"""Faster alternative data sources for search_index.py's per-file loop —
uses bulk/whole-file Crowdin calls instead of source_strings.list_strings
per file and one string_translations.list_string_translations call per
*string* (the genuinely slow part file_content_sync.py's docstring calls
out).

Two independent speedups, each falling back cleanly to the existing
per-file path on any failure:

- Source strings: source_strings.list_strings paginated across the WHOLE
  project (no fileId) already costs the same handful of calls regardless
  of file count — there was never a reason to wait for the per-file loop
  to reach a file just to make its source text searchable.
- Target text: translations.build_project_file_translation exports one
  file (source + current target text merged, same format as the
  project's original upload — confirmed live for this project: simple
  Android-style `<string name="ID">text</string>` entries) in a single
  call, instead of one call per string in that file. Only recovers the
  single "current" translation per string (not the full candidate/
  approval history file_content_sync.py needs for the real editor), so
  this only ever updates files.search_synced_at and strings_fts, never
  content_synced_at or the translations table.

Building a file export is a project-level action — whether a given
token's role allows it isn't knowable up front, so sync_file_target_text
just tries it and returns False on any failure (permission included),
letting the caller fall back to the slower per-string sync for that one
file rather than blocking the whole job.
"""

import logging
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

import requests

from app.crowdin_client import call_with_limits, get_client
from app.db import get_conn
from app.sync.search_fts import upsert_source_text, upsert_target_text

logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _unwrap(item: dict) -> dict:
    return item.get("data", item) if isinstance(item, dict) else item


def bulk_sync_source_strings(project_id: int) -> int:
    client = get_client()
    resp = call_with_limits(
        client.source_strings.with_fetch_all().list_strings,
        projectId=project_id,
    )
    strings = [_unwrap(s) for s in resp.get("data", [])]
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
                    s.get("fileId"),
                    project_id,
                    s.get("identifier"),
                    s.get("text", "") if isinstance(s.get("text"), str) else str(s.get("text", "")),
                    s.get("context"),
                    s.get("maxLength"),
                    1 if s.get("hasPlurals") else 0,
                    1 if s.get("isHidden") else 0,
                    "[]",
                    s.get("updatedAt"),
                    now,
                ),
            )
            upsert_source_text(conn, s["id"], s.get("identifier") or "", s.get("text") or "")
    logger.info("bulk source sync: %d string(s) for project %s", len(strings), project_id)
    return len(strings)


def sync_file_target_text_fast(project_id: int, file_id: int, language_id: str) -> bool:
    """One call instead of one-per-string. Returns False (no partial
    writes) on any failure so the caller can fall back to the full
    per-string sync for this file."""
    client = get_client()
    try:
        resp = call_with_limits(
            client.translations.build_project_file_translation,
            projectId=project_id,
            fileId=file_id,
            targetLanguageId=language_id,
            skipUntranslatedStrings=False,
            exportApprovedOnly=False,
        )
        url = _unwrap(resp["data"] if "data" in resp else resp)["url"]
        xml_bytes = requests.get(url, timeout=30).content
        root = ET.fromstring(xml_bytes)
    except Exception:
        logger.info("fast target sync: falling back to per-string sync for file %s", file_id, exc_info=True)
        return False

    target_by_identifier = {el.get("name"): (el.text or "") for el in root.findall("string") if el.get("name")}
    if not target_by_identifier:
        return True

    now = _now()
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, identifier, text FROM source_strings WHERE file_id = ?", (file_id,)
        ).fetchall()
        for row in rows:
            target_text = target_by_identifier.get(row["identifier"])
            if target_text is None:
                continue
            upsert_target_text(
                conn, row["id"], language_id, row["identifier"] or "", row["text"] or "", target_text
            )
        conn.execute("UPDATE files SET search_synced_at = ? WHERE id = ?", (now, file_id))
        conn.execute(
            """
            INSERT INTO file_search_sync (file_id, language_id, synced_at) VALUES (?, ?, ?)
            ON CONFLICT(file_id, language_id) DO UPDATE SET synced_at = excluded.synced_at
            """,
            (file_id, language_id, now),
        )
    return True
