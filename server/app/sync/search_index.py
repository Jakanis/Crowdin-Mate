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

Resumable for free: progress is driven by file_search_sync (one row per
file+language actually indexed) rather than an in-memory cursor, so
stopping (or an app restart) just picks back up wherever it left off next
time it's started.

State is keyed by (project_id, language_id), not just project_id — a
project can have several target languages, each needing its own
independent index build/progress, so one language's completed build must
not make a different language's build look done (or make its own status
show another language's progress)."""

import logging
import threading

from app.db import get_conn
from app.sync.bulk_search_sync import bulk_sync_source_strings, sync_file_target_text_fast
from app.sync.file_content_sync import sync_file_content

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_states: dict[tuple[int, str], dict] = {}


def _state_for(project_id: int, language_id: str) -> dict:
    state = _states.setdefault(
        (project_id, language_id),
        {"running": False, "errors": 0, "current_file_path": None, "stop_requested": False, "thread": None},
    )
    # Self-heal: a thread that's no longer alive can't genuinely still be
    # "running", whatever state it left behind. _run()'s own try/finally
    # (below) already guarantees a normal or errored-out run resets this
    # on its own, but this is the last line of defense against anything
    # that kills the thread more abruptly than a caught exception (a hard
    # process-level fault, for instance) — without it, a crash like that
    # leaves running=True permanently, since nothing else ever revisits
    # it: the "Index all files" button would stay stuck showing "Stop
    # indexing" forever, and clicking Stop wouldn't help either, since
    # stop_requested is only ever checked by the (already-dead) loop.
    thread: threading.Thread | None = state.get("thread")
    if state["running"] and thread is not None and not thread.is_alive():
        state["running"] = False
        state["current_file_path"] = None
    return state


def get_status(project_id: int, language_id: str) -> dict:
    """total/synced are always computed fresh from the DB (not tracked
    in memory) so the numbers are correct even right after a restart,
    with no build running."""
    with get_conn() as conn:
        total = conn.execute(
            "SELECT COUNT(*) c FROM files WHERE project_id = ?", (project_id,)
        ).fetchone()["c"]
        synced = conn.execute(
            """
            SELECT COUNT(*) c FROM files f
            WHERE f.project_id = ?
              AND EXISTS (
                  SELECT 1 FROM file_search_sync s WHERE s.file_id = f.id AND s.language_id = ?
              )
            """,
            (project_id, language_id),
        ).fetchone()["c"]

    with _lock:
        state = _state_for(project_id, language_id)
        running_info = {k: v for k, v in state.items() if k not in ("stop_requested", "thread")}

    return {"total": total, "synced": synced, **running_info}


def _run(project_id: int, language_id: str) -> None:
    # Everything below is wrapped so state["running"] is GUARANTEED to
    # reset no matter what happens — confirmed live: an earlier version
    # only reset it after the per-file loop, with no try/finally around
    # any of this, so a failure anywhere before or during that loop (the
    # pending-files query included — a genuine DB error there is exactly
    # as fatal as any other) left running=True forever, no exception ever
    # logged. From the UI that reads as a stuck "Stop indexing" button
    # that doing nothing when clicked, since stop_requested is only ever
    # checked by the (already-dead) loop — see _state_for's own
    # thread-liveness self-heal for the other half of this fix.
    try:
        # bulk_sync_source_strings fetches every source string project-wide
        # in one paginated call before the per-file loop below even starts
        # — for a project this size (tens of thousands of files) that can
        # legitimately take minutes with nothing else to show for it
        # otherwise, since current_file_path is only ever set once the
        # loop begins. Reusing that same field here (rather than a new
        # one) means the existing "current_file_path && <div>" in
        # SearchPanel.tsx already renders it with zero frontend changes.
        with _lock:
            _state_for(project_id, language_id)["current_file_path"] = "Fetching all source strings…"
        try:
            bulk_sync_source_strings(project_id)
        except Exception:
            logger.exception("search index build: bulk source sync failed for project %s", project_id)

        with get_conn() as conn:
            pending = [
                dict(row) for row in conn.execute(
                    """
                    SELECT id, path FROM files f
                    WHERE f.project_id = ?
                      AND NOT EXISTS (
                          SELECT 1 FROM file_search_sync s WHERE s.file_id = f.id AND s.language_id = ?
                      )
                    ORDER BY id
                    """,
                    (project_id, language_id),
                )
            ]

        logger.info(
            "search index build: %d file(s) to sync for project %s/%s", len(pending), project_id, language_id
        )

        for f in pending:
            with _lock:
                state = _state_for(project_id, language_id)
                if state["stop_requested"]:
                    break
                state["current_file_path"] = f["path"]
            try:
                if not sync_file_target_text_fast(project_id, f["id"], language_id):
                    sync_file_content(project_id, f["id"], language_id)
            except Exception:
                logger.exception("search index build: failed to sync file %s (%s)", f["id"], f["path"])
                with _lock:
                    _state_for(project_id, language_id)["errors"] += 1
    except Exception:
        logger.exception("search index build: crashed for project %s/%s", project_id, language_id)
    finally:
        with _lock:
            state = _state_for(project_id, language_id)
            state["running"] = False
            state["current_file_path"] = None
        logger.info("search index build: finished (or stopped) for project %s/%s", project_id, language_id)


def start(project_id: int, language_id: str) -> bool:
    """Returns False if a build is already running for this project +
    language. Different projects, or different languages of the same
    project, can build concurrently — each is an independent thread
    against its own file set."""
    thread = threading.Thread(target=_run, args=(project_id, language_id), daemon=True)
    with _lock:
        state = _state_for(project_id, language_id)
        if state["running"]:
            return False
        state.update(running=True, errors=0, current_file_path=None, stop_requested=False, thread=thread)

    thread.start()
    return True


def request_stop(project_id: int, language_id: str) -> None:
    with _lock:
        _state_for(project_id, language_id)["stop_requested"] = True
