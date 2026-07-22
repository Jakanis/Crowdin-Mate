"""Explicit, opt-in background job to sync string content for every file
in a project, purely so full-text search (search_strings in main.py) can
cover the whole project rather than just whatever's been opened so far.

Genuinely large for a project this size — 19,866 files, no bulk content
endpoint (confirmed live; see file_content_sync.py's own docstring for
the per-file cost) — expect hours, not minutes. This is the "on-demand
or overnight... full-project resync" the project plan already called
out as a separate, explicit job, never something that runs on its own.

Resumable for free: progress is driven by files.content_synced_at IS
NULL rather than an in-memory cursor, so stopping (or an app restart)
just picks back up wherever it left off next time it's started.
"""

import logging
import threading

from app.db import get_conn
from app.sync.file_content_sync import sync_file_content

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_state = {
    "running": False,
    "errors": 0,
    "current_file_path": None,
    "stop_requested": False,
}


def get_status(project_id: int) -> dict:
    """total/synced are always computed fresh from the DB (not tracked
    in memory) so the numbers are correct even right after a restart,
    with no build running."""
    with get_conn() as conn:
        total = conn.execute(
            "SELECT COUNT(*) c FROM files WHERE project_id = ?", (project_id,)
        ).fetchone()["c"]
        synced = conn.execute(
            "SELECT COUNT(*) c FROM files WHERE project_id = ? AND content_synced_at IS NOT NULL",
            (project_id,),
        ).fetchone()["c"]

    with _lock:
        running_info = {k: v for k, v in _state.items() if k != "stop_requested"}

    return {"total": total, "synced": synced, **running_info}


def _run(project_id: int, language_id: str) -> None:
    with get_conn() as conn:
        pending = [
            dict(row) for row in conn.execute(
                "SELECT id, path FROM files WHERE project_id = ? AND content_synced_at IS NULL ORDER BY id",
                (project_id,),
            )
        ]

    logger.info("search index build: %d file(s) to sync for project %s", len(pending), project_id)

    for f in pending:
        with _lock:
            if _state["stop_requested"]:
                break
            _state["current_file_path"] = f["path"]
        try:
            sync_file_content(project_id, f["id"], language_id)
        except Exception:
            logger.exception("search index build: failed to sync file %s (%s)", f["id"], f["path"])
            with _lock:
                _state["errors"] += 1

    with _lock:
        _state["running"] = False
        _state["current_file_path"] = None
    logger.info("search index build: finished (or stopped) for project %s", project_id)


def start(project_id: int, language_id: str) -> bool:
    """Returns False if a build is already running (project-agnostic —
    this app only ever works with one project open at a time)."""
    with _lock:
        if _state["running"]:
            return False
        _state.update(running=True, errors=0, current_file_path=None, stop_requested=False)

    thread = threading.Thread(target=_run, args=(project_id, language_id), daemon=True)
    thread.start()
    return True


def request_stop() -> None:
    with _lock:
        _state["stop_requested"] = True
