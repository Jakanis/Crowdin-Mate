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

logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _unwrap(item: dict) -> dict:
    return item.get("data", item) if isinstance(item, dict) else item


def sync_file_content(project_id: int, file_id: int, language_id: str) -> dict:
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

    # All translations for each string (per-string call).
    translations: list[dict] = []
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

    now = _now()

    with get_conn() as conn:
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
            conn.execute("DELETE FROM strings_fts WHERE rowid = ?", (s["id"],))
            conn.execute(
                "INSERT INTO strings_fts(rowid, identifier, source_text, target_text) VALUES (?, ?, ?, ?)",
                (
                    s["id"],
                    s.get("identifier") or "",
                    s.get("text") or "",
                    " ".join(translation_texts_by_string.get(s["id"], [])),
                ),
            )

        conn.execute(
            "UPDATE files SET content_synced_at = ? WHERE id = ?",
            (now, file_id),
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
