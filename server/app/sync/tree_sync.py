"""Background crawl of a project's directory/file tree into local SQLite.

This directly replaces what Crowdin's own frontend does badly: instead of
serializing the whole nested tree as one multi-hundred-KB JSON blob on
every page load, we crawl it once (paginated, `recursion=True` so a single
walk covers every nested folder), upsert rows into SQLite, and the UI reads
only from the local cache from then on. Re-running this is always safe —
every write is an upsert keyed by Crowdin's own id.
"""

import logging
from datetime import datetime, timezone

from app.crowdin_client import call_with_limits, get_client
from app.db import get_conn

logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _unwrap(item: dict) -> dict:
    """Crowdin API v2 wraps each list item as {"data": {...fields...}}."""
    return item.get("data", item) if isinstance(item, dict) else item


def _iso(value) -> str | None:
    """The SDK parses timestamp fields into datetime objects (or leaves
    them None) rather than raw strings — normalize to ISO text so we're
    not relying on sqlite3's deprecated implicit datetime adapter."""
    if value is None:
        return None
    if isinstance(value, str):
        return value
    return value.isoformat()


def sync_project_tree(project_id: int) -> dict:
    client = get_client()

    project_resp = call_with_limits(client.projects.get_project, projectId=project_id)
    project = _unwrap(project_resp)

    directories_resp = call_with_limits(
        client.source_files.with_fetch_all().list_directories,
        projectId=project_id,
        recursion=True,
    )
    directories = [_unwrap(d) for d in directories_resp.get("data", [])]

    files_resp = call_with_limits(
        client.source_files.with_fetch_all().list_files,
        projectId=project_id,
        recursion=True,
    )
    files = [_unwrap(f) for f in files_resp.get("data", [])]

    labels_resp = call_with_limits(client.labels.with_fetch_all().list_labels, projectId=project_id)
    labels = [_unwrap(item) for item in labels_resp.get("data", [])]

    now = _now()
    with get_conn() as conn:
        # Snapshot each file's previously-known updatedAt before the
        # upsert below overwrites it — that's the only signal available
        # for "did this file's source content change on Crowdin since we
        # last looked" (Crowdin bumps a file's updatedAt on a new content
        # revision, not just on rename/move). A file with no prior row is
        # new, not "changed", so it's excluded rather than compared to None.
        previous_updated_at: dict[int, str | None] = {
            row["id"]: row["updated_at"]
            for row in conn.execute(
                "SELECT id, updated_at FROM files WHERE project_id = ?", (project_id,)
            )
        }
        conn.execute(
            """
            INSERT INTO projects (id, name, source_language, target_languages_json, last_full_sync_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name=excluded.name,
                source_language=excluded.source_language,
                target_languages_json=excluded.target_languages_json,
                last_full_sync_at=excluded.last_full_sync_at
            """,
            (
                project["id"],
                project.get("name", ""),
                (project.get("sourceLanguageId") or project.get("sourceLanguage", {}).get("id", "")),
                _target_languages_json(project),
                now,
            ),
        )

        for d in directories:
            conn.execute(
                """
                INSERT INTO directories (id, project_id, parent_id, name, path, updated_at, synced_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    parent_id=excluded.parent_id,
                    name=excluded.name,
                    path=excluded.path,
                    updated_at=excluded.updated_at,
                    synced_at=excluded.synced_at
                """,
                (
                    d["id"],
                    project_id,
                    d.get("directoryId"),
                    d.get("name", ""),
                    d.get("path", d.get("name", "")),
                    _iso(d.get("updatedAt")),
                    now,
                ),
            )

        changed_file_ids: list[int] = []
        for f in files:
            new_updated_at = _iso(f.get("updatedAt"))
            old_updated_at = previous_updated_at.get(f["id"])
            if old_updated_at is not None and new_updated_at != old_updated_at:
                changed_file_ids.append(f["id"])

            conn.execute(
                """
                INSERT INTO files (id, project_id, directory_id, name, path, strings_count, updated_at, synced_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    directory_id=excluded.directory_id,
                    name=excluded.name,
                    path=excluded.path,
                    strings_count=excluded.strings_count,
                    updated_at=excluded.updated_at,
                    synced_at=excluded.synced_at
                """,
                (
                    f["id"],
                    project_id,
                    f.get("directoryId"),
                    f.get("name", ""),
                    f.get("path", f.get("name", "")),
                    # Crowdin's file object from list_files has no phrase count field
                    # (confirmed against the live response) — this gets filled in
                    # once Phase 1 syncs a file's actual source strings.
                    None,
                    new_updated_at,
                    now,
                ),
            )

        for label in labels:
            conn.execute(
                """
                INSERT INTO labels (id, project_id, title, synced_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET title=excluded.title, synced_at=excluded.synced_at
                """,
                (label["id"], project_id, label.get("title", ""), now),
            )

    logger.info(
        "Synced project %s tree: %d directories, %d files, %d labels, %d changed since last sync",
        project_id, len(directories), len(files), len(labels), len(changed_file_ids),
    )
    return {
        "project_id": project_id,
        "directories": len(directories),
        "files": len(files),
        "synced_at": now,
        "changed_file_ids": changed_file_ids,
    }


def _target_languages_json(project: dict) -> str:
    import json

    # Confirmed directly on the project object as a flat list of ids
    # (e.g. ["uk"]) — simpler than deriving it from targetLanguages[].id.
    return json.dumps(project.get("targetLanguageIds") or [])
