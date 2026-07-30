"""Per-file lazy sync of source strings + translations.

Unlike tree_sync (small, safe to crawl in full), string content is the
actually large data on a project like this — never bulk-fetched. This
module fetches strings + translations for exactly one file, on demand,
when the user opens it.

We deliberately fetch ALL translations per string (per-string
`list_string_translations`) rather than the single "top" one that
`list_language_translations` returns. The latter shows only the most
recent submission, which is not necessarily the approved one — so a
proofreader would see the wrong text. Approval status comes from the
separate, file-scoped `list_translation_approvals` call (one paginated
set for the whole file), whose rows point at the approved translationId.

Cost: one translations call per string. Files in this project are small
(single digits to low tens of strings), so this stays well within a
second or two even before the local cache makes repeat opens instant.
Field shapes were all confirmed against live API responses.
"""

import json
import logging
from datetime import datetime, timezone

from app.crowdin_client import call_with_limits, get_client
from app.db import get_conn
from app.sync.search_fts import upsert_target_text

logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _unwrap(item: dict) -> dict:
    return item.get("data", item) if isinstance(item, dict) else item


def _purge_stale_source_strings(conn, file_id: int, fresh_string_ids: list[int]) -> list[int]:
    """Crowdin no longer lists these string ids under this file — either
    genuinely deleted, or moved elsewhere in a way that gave the moved
    content a brand-new id (confirmed live: moving strings to a new file
    created fresh ids there rather than reassigning the existing ones,
    so the old file's fresh listing simply stops including them). The
    upsert loop below only ever adds/updates rows for ids Crowdin still
    returns, so without this a file that shrinks or gets reorganized
    keeps showing its old strings forever — exactly the bug reported
    live (a file with strings moved out, plus new ones added, kept
    showing the moved-out strings alongside the new ones)."""
    if fresh_string_ids:
        placeholders = ",".join("?" * len(fresh_string_ids))
        rows = conn.execute(
            f"SELECT id FROM source_strings WHERE file_id = ? AND id NOT IN ({placeholders})",
            (file_id, *fresh_string_ids),
        ).fetchall()
    else:
        rows = conn.execute("SELECT id FROM source_strings WHERE file_id = ?", (file_id,)).fetchall()
    stale_ids = [r["id"] for r in rows]
    if not stale_ids:
        return []

    placeholders = ",".join("?" * len(stale_ids))
    for table in (
        "translations", "deleted_translations", "comments",
        "tm_matches", "glossary_matches", "suggestion_lookups", "translation_drafts",
    ):
        conn.execute(f"DELETE FROM {table} WHERE string_id IN ({placeholders})", stale_ids)

    fts_rowids = [
        row["id"] for row in conn.execute(
            f"SELECT id FROM strings_fts_map WHERE string_id IN ({placeholders})", stale_ids
        )
    ]
    if fts_rowids:
        fts_placeholders = ",".join("?" * len(fts_rowids))
        conn.execute(f"DELETE FROM strings_fts WHERE rowid IN ({fts_placeholders})", fts_rowids)
        conn.execute(f"DELETE FROM strings_fts_map WHERE id IN ({fts_placeholders})", fts_rowids)

    conn.execute(f"DELETE FROM source_strings WHERE id IN ({placeholders})", stale_ids)
    return stale_ids


def sync_file_content(
    project_id: int, file_id: int, language_id: str, include_candidates: bool = True
) -> dict:
    """include_candidates=False swaps the per-string translation fetch for a
    single per-file one. Much cheaper, but it only recovers the current
    translation per string — see the branch below. Used by the offline
    pre-cache, where covering 19,000 files matters more than knowing every
    superseded candidate in each."""
    client = get_client()

    strings_resp = call_with_limits(
        client.source_strings.with_fetch_all().list_strings,
        projectId=project_id,
        fileId=file_id,
    )
    strings = [_unwrap(s) for s in strings_resp.get("data", [])]
    string_ids = [s["id"] for s in strings]

    # File-scoped approvals (one paginated set) → translationId -> approvalId.
    approvals_resp = call_with_limits(
        client.string_translations.with_fetch_all().list_translation_approvals,
        projectId=project_id,
        fileId=file_id,
        languageId=language_id,
    )
    approval_by_translation: dict[int, int] = {}
    for a in approvals_resp.get("data", []):
        a = _unwrap(a)
        approval_by_translation[a["translationId"]] = a["id"]

    translations: list[dict] = []
    if include_candidates:
        # All translations for each string (per-string call).
        for sid in string_ids:
            t_resp = call_with_limits(
                client.string_translations.with_fetch_all().list_string_translations,
                projectId=project_id,
                stringId=sid,
                languageId=language_id,
            )
            for t in t_resp.get("data", []):
                t = _unwrap(t)
                t["_string_id"] = sid  # this endpoint's rows don't carry stringId
                translations.append(t)
    else:
        # One paginated call for the whole file instead of one per string —
        # the difference between ~6 requests per file and ~3, and far more
        # than that for a string-heavy file.
        #
        # The tradeoff, confirmed live: this returns only the CURRENT
        # translation per string, never the candidate history. On string 284
        # the per-string endpoint returns 2 candidates and this one returns
        # 1. So it's right for bulk pre-caching (where the goal is coverage)
        # and wrong for opening a file to work on it, which is why the
        # caller chooses.
        #
        # Unlike a file export — the other bulk option — these rows carry a
        # real translationId, so what they produce can still be approved,
        # voted on and deleted rather than being a read-only snapshot.
        t_resp = call_with_limits(
            client.string_translations.with_fetch_all().list_language_translations,
            projectId=project_id,
            fileId=file_id,
            languageId=language_id,
        )
        for t in t_resp.get("data", []):
            t = _unwrap(t)
            # This endpoint names them differently to list_string_translations.
            t["id"] = t.get("translationId")
            t["_string_id"] = t.get("stringId")
            if t["id"] is not None and t["_string_id"] is not None:
                translations.append(t)

    now = _now()

    with get_conn() as conn:
        purged_ids = _purge_stale_source_strings(conn, file_id, string_ids)
        if purged_ids:
            logger.info(
                "Synced file %s content: purged %d stale string(s) no longer present: %s",
                file_id, len(purged_ids), purged_ids,
            )

        for s in strings:
            conn.execute(
                """
                INSERT INTO source_strings
                    (id, file_id, project_id, identifier, text, context,
                     max_length, has_plurals, is_hidden, label_ids_json, updated_at, synced_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    text=excluded.text,
                    context=excluded.context,
                    max_length=excluded.max_length,
                    has_plurals=excluded.has_plurals,
                    is_hidden=excluded.is_hidden,
                    label_ids_json=excluded.label_ids_json,
                    updated_at=excluded.updated_at,
                    synced_at=excluded.synced_at
                """,
                (
                    s["id"],
                    file_id,
                    project_id,
                    s.get("identifier"),
                    s.get("text", "") if isinstance(s.get("text"), str) else str(s.get("text", "")),
                    s.get("context"),
                    s.get("maxLength"),
                    1 if s.get("hasPlurals") else 0,
                    1 if s.get("isHidden") else 0,
                    # Already present in this same list_strings response
                    # (confirmed live) — no extra API call for it.
                    json.dumps(s.get("labelIds") or []),
                    _iso(s.get("updatedAt")),
                    now,
                ),
            )

        if string_ids:
            placeholders = ",".join("?" * len(string_ids))
            conn.execute(
                f"DELETE FROM translations WHERE language_id = ? AND string_id IN ({placeholders})",
                (language_id, *string_ids),
            )

        for t in translations:
            user = t.get("user") or {}
            # list_string_translations rows use `id` for the translation id
            # (confirmed live) — the same id the approvals list points at.
            translation_id = t["id"]
            approval_id = approval_by_translation.get(translation_id)
            conn.execute(
                """
                INSERT INTO translations
                    (id, string_id, language_id, text, user_id, user_name,
                     rating, is_approved, approval_id, created_at, synced_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    text=excluded.text,
                    user_id=excluded.user_id,
                    user_name=excluded.user_name,
                    rating=excluded.rating,
                    is_approved=excluded.is_approved,
                    approval_id=excluded.approval_id,
                    created_at=excluded.created_at,
                    synced_at=excluded.synced_at
                """,
                (
                    translation_id,
                    t["_string_id"],
                    language_id,
                    t.get("text", ""),
                    user.get("id"),
                    user.get("fullName") or user.get("username"),
                    t.get("rating", 0) or 0,
                    1 if approval_id is not None else 0,
                    approval_id,
                    _iso(t.get("createdAt")),
                    now,
                ),
            )

        # Keep the search index in step with what was just written. Rebuilt
        # from scratch per string rather than patched — cheap at per-file
        # scale, and sidesteps having to diff old vs new translation sets.
        translation_texts_by_string: dict[int, list[str]] = {}
        for t in translations:
            translation_texts_by_string.setdefault(t["_string_id"], []).append(t.get("text", ""))

        for s in strings:
            upsert_target_text(
                conn,
                s["id"],
                language_id,
                s.get("identifier") or "",
                s.get("text") or "",
                " ".join(translation_texts_by_string.get(s["id"], [])),
            )

        conn.execute(
            "UPDATE files SET content_synced_at = ? WHERE id = ?",
            (now, file_id),
        )
        conn.execute(
            """
            INSERT INTO file_language_sync (file_id, language_id, synced_at) VALUES (?, ?, ?)
            ON CONFLICT(file_id, language_id) DO UPDATE SET synced_at = excluded.synced_at
            """,
            (file_id, language_id, now),
        )
        conn.execute(
            """
            INSERT INTO file_search_sync (file_id, language_id, synced_at) VALUES (?, ?, ?)
            ON CONFLICT(file_id, language_id) DO UPDATE SET synced_at = excluded.synced_at
            """,
            (file_id, language_id, now),
        )

    logger.info(
        "Synced file %s content: %d strings, %d translations, %d approved",
        file_id, len(strings), len(translations), len(approval_by_translation),
    )
    return {
        "file_id": file_id,
        "strings": len(strings),
        "translations": len(translations),
        "approvals": len(approval_by_translation),
        "synced_at": now,
    }


def sync_string_comments(project_id: int, string_id: int) -> list[dict]:
    """Fetch + cache all comments/issues for one string. Called lazily
    when the user opens a string's comment panel (most strings have none,
    so eagerly fetching per-string on every file open would be wasteful).
    Returns the freshly-cached rows."""
    client = get_client()
    resp = call_with_limits(
        client.string_comments.with_fetch_all().list_string_comments,
        projectId=project_id,
        stringId=string_id,
    )
    comments = [_unwrap(c) for c in resp.get("data", [])]
    now = _now()

    with get_conn() as conn:
        # Replace the cached set for this string so deletions/resolutions
        # upstream are reflected.
        conn.execute("DELETE FROM comments WHERE string_id = ?", (string_id,))
        for c in comments:
            user = c.get("user") or {}
            conn.execute(
                """
                INSERT INTO comments
                    (id, string_id, project_id, language_id, text, user_id, user_name,
                     type, issue_type, issue_status, is_resolved, created_at, synced_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    c["id"],
                    string_id,
                    project_id,
                    c.get("languageId"),
                    c.get("text", ""),
                    user.get("id"),
                    user.get("fullName") or user.get("username"),
                    c.get("type"),
                    c.get("issueType"),
                    c.get("issueStatus"),
                    1 if c.get("resolvedAt") else 0,
                    _iso(c.get("createdAt")),
                    now,
                ),
            )

    return comments


def _iso(value) -> str | None:
    """The SDK parses timestamp fields into datetime objects (or leaves
    them None) rather than raw strings — normalize to ISO text for
    storage."""
    if value is None:
        return None
    if isinstance(value, str):
        return value
    return value.isoformat()
