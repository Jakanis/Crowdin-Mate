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

from app.crowdin_client import background_work, call_with_limits, get_client
from app.db import get_conn
from app.sync import search_fts

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


# Every table below hangs off a file that no longer exists, keyed by that
# file's own strings rather than by the file. Deleting the file row alone
# would leave all of this behind — most visibly the search index, which
# would keep returning hits in files you can no longer open.
_STRING_SCOPED_TABLES = (
    "translations",
    "deleted_translations",
    "comments",
    "tm_matches",
    "glossary_matches",
    "suggestion_lookups",
    "translation_drafts",
)

_FILE_SCOPED_TABLES = ("source_strings", "file_progress", "file_language_sync", "file_search_sync")


def _prune_missing(conn, project_id: int, live_dir_ids: set[int], live_file_ids: set[int]) -> dict:
    """Drop cached files and directories Crowdin no longer lists.

    Every write in this module is an upsert, which keeps a re-run safe but
    can only ever add: a file deleted or moved out of the project on Crowdin
    stayed in the tree forever, and its strings stayed searchable.

    Safe here specifically because this crawl is `recursion=True` +
    fetch-all, and every API call has already returned before the caller
    opens this transaction — so reaching this point means the listing is the
    complete current state, not a page of it. A failure anywhere earlier
    raises before any of it, leaving the cache untouched.

    Deliberately NOT touched: offline_queue. A queued write whose file has
    vanished can't succeed, but silently discarding someone's unsent work on
    the strength of a tree listing is worse than leaving it to fail visibly
    and be dealt with.
    """
    stale_files = [
        row["id"]
        for row in conn.execute("SELECT id FROM files WHERE project_id = ?", (project_id,))
        if row["id"] not in live_file_ids
    ]
    stale_dirs = [
        row["id"]
        for row in conn.execute("SELECT id FROM directories WHERE project_id = ?", (project_id,))
        if row["id"] not in live_dir_ids
    ]
    if not stale_files and not stale_dirs:
        return {"files": 0, "directories": 0, "strings": 0}

    string_ids: list[int] = []
    if stale_files:
        marks = ",".join("?" * len(stale_files))
        string_ids = [
            row["id"]
            for row in conn.execute(
                f"SELECT id FROM source_strings WHERE file_id IN ({marks})", tuple(stale_files)
            )
        ]
        if string_ids:
            search_fts.delete_strings(conn, string_ids)
            string_marks = ",".join("?" * len(string_ids))
            for table in _STRING_SCOPED_TABLES:
                conn.execute(f"DELETE FROM {table} WHERE string_id IN ({string_marks})", tuple(string_ids))
        for table in _FILE_SCOPED_TABLES:
            conn.execute(f"DELETE FROM {table} WHERE file_id IN ({marks})", tuple(stale_files))
        conn.execute(f"DELETE FROM files WHERE id IN ({marks})", tuple(stale_files))

    if stale_dirs:
        marks = ",".join("?" * len(stale_dirs))
        conn.execute(f"DELETE FROM directory_progress WHERE directory_id IN ({marks})", tuple(stale_dirs))
        conn.execute(f"DELETE FROM directories WHERE id IN ({marks})", tuple(stale_dirs))

    return {"files": len(stale_files), "directories": len(stale_dirs), "strings": len(string_ids)}


def sync_project_tree(project_id: int) -> dict:
    with background_work():
        return _sync_project_tree(project_id)


def _sync_project_tree(project_id: int) -> dict:
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
            INSERT INTO projects
                (id, name, source_language, target_languages_json, last_full_sync_at, last_activity)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name=excluded.name,
                source_language=excluded.source_language,
                target_languages_json=excluded.target_languages_json,
                last_full_sync_at=excluded.last_full_sync_at,
                last_activity=excluded.last_activity
            """,
            (
                project["id"],
                project.get("name", ""),
                (project.get("sourceLanguageId") or project.get("sourceLanguage", {}).get("id", "")),
                _target_languages_json(project),
                now,
                _iso(project.get("lastActivity")),
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

        # An empty file listing against a non-empty cache is refused rather
        # than obeyed. A project really can be emptied, but a listing that
        # comes back empty for some other reason — a permission change, a
        # response shape this code didn't anticipate — looks identical here,
        # and the two outcomes are not comparable: one leaves a few stale
        # rows, the other throws away the entire local cache, including
        # every offline-readable string in it. Directories aren't part of
        # the condition: a flat project legitimately has none.
        if not files and previous_updated_at:
            logger.warning(
                "Project %s returned no files while %d are cached — skipping prune rather than "
                "emptying the cache on a listing this suspicious",
                project_id, len(previous_updated_at),
            )
            pruned = {"files": 0, "directories": 0, "strings": 0}
        else:
            pruned = _prune_missing(
                conn, project_id, {d["id"] for d in directories}, {f["id"] for f in files}
            )

    logger.info(
        "Synced project %s tree: %d directories, %d files, %d labels, %d changed since last sync; "
        "pruned %d file(s), %d director(ies), %d cached string(s)",
        project_id, len(directories), len(files), len(labels), len(changed_file_ids),
        pruned["files"], pruned["directories"], pruned["strings"],
    )
    return {
        "project_id": project_id,
        "directories": len(directories),
        "files": len(files),
        "synced_at": now,
        "changed_file_ids": changed_file_ids,
        "pruned": pruned,
    }


def has_project_changed(project_id: int) -> bool:
    """Cheap one-call signal for whether anything's happened on Crowdin
    since the last full tree sync — used to visually flag the sync
    button (paint it, update its hover hint) rather than silently
    re-crawling on its own; the user decides when to actually pull via
    the manual sync button, same spirit as not auto-syncing at all.

    A single get_project call's lastActivity field moves on essentially
    any real activity in the project (translations, comments, file
    management — confirmed live that it's distinct from, and updates far
    more often than, updatedAt, which only reflects the project's own
    *settings* changing), compared against the value sync_project_tree
    stored as of the last completed full sync. Unlike a separate "last
    checked" timestamp, this naturally stays true across repeated calls
    until an actual sync runs and moves the stored value forward."""
    client = get_client()
    project_resp = call_with_limits(client.projects.get_project, projectId=project_id)
    project = _unwrap(project_resp)
    last_activity = _iso(project.get("lastActivity"))

    with get_conn() as conn:
        row = conn.execute(
            "SELECT last_activity FROM projects WHERE id = ?", (project_id,)
        ).fetchone()
    previously_known = row["last_activity"] if row is not None else None

    return previously_known is not None and last_activity != previously_known


def _target_languages_json(project: dict) -> str:
    import json

    # Confirmed directly on the project object as a flat list of ids
    # (e.g. ["uk"]) — simpler than deriving it from targetLanguages[].id.
    return json.dumps(project.get("targetLanguageIds") or [])
