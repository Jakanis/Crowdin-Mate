"""Explicit, opt-in background job to sync string content for every file
in a project, purely so full-text search (search_strings in main.py) can
cover the whole project rather than just whatever's been opened so far.

Tries the fast bulk path first for every file (bulk_search_sync.py — one
call for ALL source strings project-wide, one call per file for target
text instead of one per string), falling back to the slower per-string
file_content_sync.py sync only where that fails (permission, API error,
parse mismatch, etc.) — so a token without export permission still
completes the job, just at the old pace for whichever files needed the
fallback. This is the "on-demand or overnight... full-project resync"
the project plan already called out as a separate, explicit job, never
something that runs on its own.

Resumable for free: progress is driven by files.content_synced_at /
search_synced_at being NULL rather than an in-memory cursor, so stopping
(or an app restart) just picks back up wherever it left off next time
it's started.

State is keyed by project_id (not a single global) — with multi-project
support, switching projects mid-build must not show one project's
progress/errors while actually building another's.
"""

import logging
import threading

from app.db import get_conn
from app.sync.bulk_search_sync import bulk_sync_source_strings, sync_file_target_text_fast
from app.sync.file_content_sync import sync_file_content

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_states: dict[int, dict] = {}


def _state_for(project_id: int) -> dict:
    return _states.setdefault(
        project_id,
        {"running": False, "errors": 0, "current_file_path": None, "stop_requested": False},
    )


def get_status(project_id: int) -> dict:
    """total/synced are always computed fresh from the DB (not tracked
    in memory) so the numbers are correct even right after a restart,
    with no build running."""
    with get_conn() as conn:
        total = conn.execute(
            "SELECT COUNT(*) c FROM files WHERE project_id = ?", (project_id,)
        ).fetchone()["c"]
        synced = conn.execute(
            """
            SELECT COUNT(*) c FROM files
            WHERE project_id = ? AND (content_synced_at IS NOT NULL OR search_synced_at IS NOT NULL)
            """,
            (project_id,),
        ).fetchone()["c"]

    with _lock:
        state = _state_for(project_id)
        running_info = {k: v for k, v in state.items() if k != "stop_requested"}

    return {"total": total, "synced": synced, **running_info}


def _run(project_id: int, language_id: str) -> None:
    try:
        bulk_sync_source_strings(project_id)
    except Exception:
        logger.exception("search index build: bulk source sync failed for project %s", project_id)

    with get_conn() as conn:
        pending = [
            dict(row) for row in conn.execute(
                """
                SELECT id, path FROM files
                WHERE project_id = ? AND content_synced_at IS NULL AND search_synced_at IS NULL
                ORDER BY id
                """,
                (project_id,),
            )
        ]

    logger.info("search index build: %d file(s) to sync for project %s", len(pending), project_id)

    for f in pending:
        with _lock:
            state = _state_for(project_id)
            if state["stop_requested"]:
                break
            state["current_file_path"] = f["path"]
        try:
            if not sync_file_target_text_fast(project_id, f["id"], language_id):
                sync_file_content(project_id, f["id"], language_id)
        except Exception:
            logger.exception("search index build: failed to sync file %s (%s)", f["id"], f["path"])
            with _lock:
                _state_for(project_id)["errors"] += 1

    with _lock:
        state = _state_for(project_id)
        state["running"] = False
        state["current_file_path"] = None
    logger.info("search index build: finished (or stopped) for project %s", project_id)


def start(project_id: int, language_id: str) -> bool:
    """Returns False if a build is already running for this project.
    Different projects can build concurrently — each is an independent
    thread against its own file set."""
    with _lock:
        state = _state_for(project_id)
        if state["running"]:
            return False
        state.update(running=True, errors=0, current_file_path=None, stop_requested=False)

    thread = threading.Thread(target=_run, args=(project_id, language_id), daemon=True)
    thread.start()
    return True


def request_stop(project_id: int) -> None:
    with _lock:
        _state_for(project_id)["stop_requested"] = True
