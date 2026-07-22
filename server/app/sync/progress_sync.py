"""Lazy translation/approval progress for the file tree.

Crowdin's public API has no bulk "progress for every file in the
project" endpoint — confirmed live: get_file_progress is one call per
file, get_directory_progress gives one aggregate row per directory (not
its children's individual progress). With ~19,866 files in this
project, the only workable approach is fetching progress for exactly
what's visible: a directory's direct children (both subdirectories and
files), right when that directory is expanded in the tree — mirroring
how the UI itself only reveals those rows at that moment.
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


def _find_language_row(rows: list[dict], language_id: str) -> dict | None:
    for item in rows:
        row = _unwrap(item)
        if row.get("languageId") == language_id:
            return row
    return None


def sync_directory_progress(project_id: int, directory_id: int, language_id: str) -> dict | None:
    client = get_client()
    resp = call_with_limits(
        client.translation_status.get_directory_progress,
        directoryId=directory_id, projectId=project_id,
    )
    row = _find_language_row(resp.get("data", []), language_id)
    if row is None:
        return None

    now = _now()
    progress = {
        "translation_progress": row.get("translationProgress", 0),
        "approval_progress": row.get("approvalProgress", 0),
    }
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO directory_progress (directory_id, language_id, translation_progress, approval_progress, cached_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(directory_id, language_id) DO UPDATE SET
                translation_progress=excluded.translation_progress,
                approval_progress=excluded.approval_progress,
                cached_at=excluded.cached_at
            """,
            (directory_id, language_id, progress["translation_progress"], progress["approval_progress"], now),
        )
    return progress


def sync_file_progress(project_id: int, file_id: int, language_id: str) -> dict | None:
    client = get_client()
    resp = call_with_limits(
        client.translation_status.get_file_progress,
        fileId=file_id, projectId=project_id,
    )
    row = _find_language_row(resp.get("data", []), language_id)
    if row is None:
        return None

    # File-level progress is counted in strings, not words — unlike
    # directory-level, which stays on Crowdin's own word-based
    # translationProgress/approvalProgress. The `phrases` breakdown
    # (confirmed live: {"total", "translated", "approved"}) is already
    # present in the same response we're fetching anyway, so this costs
    # nothing extra — no additional API call.
    phrases = row.get("phrases") or {}
    total = phrases.get("total", 0)
    now = _now()
    progress = {
        "translation_progress": round(phrases.get("translated", 0) / total * 100) if total else 100,
        "approval_progress": round(phrases.get("approved", 0) / total * 100) if total else 100,
    }
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO file_progress (file_id, language_id, translation_progress, approval_progress, cached_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(file_id, language_id) DO UPDATE SET
                translation_progress=excluded.translation_progress,
                approval_progress=excluded.approval_progress,
                cached_at=excluded.cached_at
            """,
            (file_id, language_id, progress["translation_progress"], progress["approval_progress"], now),
        )
    return progress


def get_children_progress(project_id: int, parent_directory_id: int | None, language_id: str) -> dict:
    """Progress for every direct child (subdirectory + file) of
    `parent_directory_id` (or the project root, if None) — fetching
    live only for whichever children aren't already cached."""
    with get_conn() as conn:
        child_dirs = [
            row["id"] for row in conn.execute(
                "SELECT id FROM directories WHERE project_id = ? AND parent_id IS ?",
                (project_id, parent_directory_id),
            )
        ]
        child_files = [
            row["id"] for row in conn.execute(
                "SELECT id FROM files WHERE project_id = ? AND directory_id IS ?",
                (project_id, parent_directory_id),
            )
        ]

        cached_dirs = {
            row["directory_id"]: {"translation_progress": row["translation_progress"], "approval_progress": row["approval_progress"]}
            for row in conn.execute(
                f"""
                SELECT directory_id, translation_progress, approval_progress FROM directory_progress
                WHERE language_id = ? AND directory_id IN ({",".join("?" * len(child_dirs))})
                """,
                (language_id, *child_dirs),
            )
        } if child_dirs else {}

        cached_files = {
            row["file_id"]: {"translation_progress": row["translation_progress"], "approval_progress": row["approval_progress"]}
            for row in conn.execute(
                f"""
                SELECT file_id, translation_progress, approval_progress FROM file_progress
                WHERE language_id = ? AND file_id IN ({",".join("?" * len(child_files))})
                """,
                (language_id, *child_files),
            )
        } if child_files else {}

    directories: dict[int, dict] = dict(cached_dirs)
    for did in child_dirs:
        if did not in directories:
            progress = sync_directory_progress(project_id, did, language_id)
            if progress is not None:
                directories[did] = progress

    files: dict[int, dict] = dict(cached_files)
    for fid in child_files:
        if fid not in files:
            progress = sync_file_progress(project_id, fid, language_id)
            if progress is not None:
                files[fid] = progress

    return {"directories": directories, "files": files}
