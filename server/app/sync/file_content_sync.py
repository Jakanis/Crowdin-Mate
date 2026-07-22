"""Per-file lazy sync of source strings + translations.

Unlike tree_sync (small, safe to crawl in full), string content is the
actually large data on a project like this — never bulk-fetched. This
module fetches strings + translations for exactly one file, on demand,
when the user opens it.

Field shapes here were confirmed against live API responses, not assumed:
translations use `translationId` (not `id`), carry no `updatedAt` or
`isApproved` field at all, so unlike source_strings (which do have a
reliable `updatedAt` to diff against) translations are simplest to just
fully replace per file+language on every revalidation — cheap at the
per-file scale this operates at (tens to low hundreds of strings).
"""

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

    translations_resp = call_with_limits(
        client.string_translations.with_fetch_all().list_language_translations,
        projectId=project_id,
        languageId=language_id,
        fileId=file_id,
    )
    translations = [_unwrap(t) for t in translations_resp.get("data", [])]

    now = _now()
    string_ids = [s["id"] for s in strings]

    with get_conn() as conn:
        for s in strings:
            conn.execute(
                """
                INSERT INTO source_strings
                    (id, file_id, project_id, identifier, text, context,
                     max_length, has_plurals, is_hidden, updated_at, synced_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    text=excluded.text,
                    context=excluded.context,
                    max_length=excluded.max_length,
                    has_plurals=excluded.has_plurals,
                    is_hidden=excluded.is_hidden,
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
            conn.execute(
                """
                INSERT INTO translations
                    (id, string_id, language_id, text, user_id, user_name, created_at, synced_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    text=excluded.text,
                    user_id=excluded.user_id,
                    user_name=excluded.user_name,
                    created_at=excluded.created_at,
                    synced_at=excluded.synced_at
                """,
                (
                    t["translationId"],
                    t["stringId"],
                    language_id,
                    t.get("text", ""),
                    user.get("id"),
                    user.get("fullName") or user.get("username"),
                    _iso(t.get("createdAt")),
                    now,
                ),
            )

        conn.execute(
            "UPDATE files SET content_synced_at = ? WHERE id = ?",
            (now, file_id),
        )

    logger.info(
        "Synced file %s content: %d strings, %d translations",
        file_id, len(strings), len(translations),
    )
    return {"file_id": file_id, "strings": len(strings), "translations": len(translations), "synced_at": now}


def _iso(value) -> str | None:
    """The SDK parses timestamp fields into datetime objects (or leaves
    them None) rather than raw strings — normalize to ISO text for
    storage."""
    if value is None:
        return None
    if isinstance(value, str):
        return value
    return value.isoformat()
