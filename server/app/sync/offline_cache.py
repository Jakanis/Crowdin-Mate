"""Explicit, opt-in background job to cache every file's full string
content so a whole project can be translated with no connection.

Distinct from search_index.py, which shares this shape deliberately (see
the note on duplication at the bottom). That job's fast path only caches a
target-language *snippet* per file — enough for search to find a string,
nowhere near enough to edit it. This one always does the full
sync_file_content: every source string, every translation candidate, and
approval state. That's the payload that makes a file workable offline, and
it costs one API call per file with no bulk equivalent.

Deliberately NOT included: comments and TM/glossary matches. Both are
per-string rather than per-file, so pre-caching them for a project this
size would be ~84,000 calls rather than ~20,000. Offline you get the
strings and translations; comments degrade to whatever was cached from
visiting a string, and TM suggestions to whatever was already looked up.

Resumable for free, same as search_index: progress comes from
file_language_sync (one row per file+language actually synced) rather than
an in-memory cursor, so stopping — or the app being killed — just resumes
where it left off.

Also handles the staleness rule: a file Crowdin has touched since we last
synced it (updated_at > synced_at) counts as pending again, so running this
after a tree sync refreshes what changed instead of only filling gaps.
"""

import logging
import threading

from app.db import get_conn
from app.sync.file_content_sync import sync_file_content

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_states: dict[tuple[int, str], dict] = {}

# Never synced for this language, or Crowdin has touched it since. Shared by
# the status count and the work list so they can't disagree about what
# "pending" means — the progress bar reaching the end and the loop having
# nothing left have to be the same condition.
_PENDING_WHERE = """
    f.project_id = ?
    AND (
        s.synced_at IS NULL
        OR (f.updated_at IS NOT NULL AND f.updated_at > s.synced_at)
    )
"""


def _state_for(project_id: int, language_id: str) -> dict:
    state = _states.setdefault(
        (project_id, language_id),
        {"running": False, "errors": 0, "current_file_path": None, "stop_requested": False, "thread": None},
    )
    # Same self-heal as search_index._state_for: a dead thread can't still
    # be running, whatever state it left behind. Without this, anything that
    # kills the thread more abruptly than a caught exception leaves
    # running=True forever, and the UI sticks on "Stop" — which then does
    # nothing, since stop_requested is only read by the dead loop.
    thread: threading.Thread | None = state.get("thread")
    if state["running"] and thread is not None and not thread.is_alive():
        state["running"] = False
        state["current_file_path"] = None
    return state


def get_status(project_id: int, language_id: str) -> dict:
    """Counts come from the DB every time, never from memory, so they're
    right after a restart with no job running."""
    with get_conn() as conn:
        total = conn.execute(
            "SELECT COUNT(*) c FROM files WHERE project_id = ?", (project_id,)
        ).fetchone()["c"]
        cached = conn.execute(
            """
            SELECT COUNT(*) c FROM files f
            JOIN file_language_sync s ON s.file_id = f.id AND s.language_id = ?
            WHERE f.project_id = ?
            """,
            (language_id, project_id),
        ).fetchone()["c"]
        pending = conn.execute(
            f"""
            SELECT COUNT(*) c FROM files f
            LEFT JOIN file_language_sync s ON s.file_id = f.id AND s.language_id = ?
            WHERE {_PENDING_WHERE}
            """,
            (language_id, project_id),
        ).fetchone()["c"]

    with _lock:
        state = _state_for(project_id, language_id)
        running_info = {k: v for k, v in state.items() if k not in ("stop_requested", "thread")}

    return {"total": total, "cached": cached, "pending": pending, **running_info}


def _run(project_id: int, language_id: str) -> None:
    # Wrapped so running is GUARANTEED to reset however this exits —
    # including a failure in the pending query itself, before the loop.
    # search_index.py has the scar tissue explaining why that matters.
    try:
        with get_conn() as conn:
            pending = [
                dict(row) for row in conn.execute(
                    f"""
                    SELECT f.id, f.path FROM files f
                    LEFT JOIN file_language_sync s ON s.file_id = f.id AND s.language_id = ?
                    WHERE {_PENDING_WHERE}
                    ORDER BY f.id
                    """,
                    (language_id, project_id),
                )
            ]

        logger.info(
            "offline cache build: %d file(s) to cache for project %s/%s",
            len(pending), project_id, language_id,
        )

        for f in pending:
            with _lock:
                state = _state_for(project_id, language_id)
                if state["stop_requested"]:
                    break
                state["current_file_path"] = f["path"]
            try:
                sync_file_content(project_id, f["id"], language_id)
            except Exception:
                # One unreadable file must not abandon the other 19,000.
                logger.exception(
                    "offline cache build: failed to cache file %s (%s)", f["id"], f["path"]
                )
                with _lock:
                    _state_for(project_id, language_id)["errors"] += 1
    except Exception:
        logger.exception("offline cache build: crashed for project %s/%s", project_id, language_id)
    finally:
        with _lock:
            state = _state_for(project_id, language_id)
            state["running"] = False
            state["current_file_path"] = None
        logger.info(
            "offline cache build: finished (or stopped) for project %s/%s", project_id, language_id
        )


def start(project_id: int, language_id: str) -> bool:
    """False if a build is already running for this project + language.
    Different languages build independently, same as search_index."""
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


# The thread-state scaffolding above (_state_for's self-heal, the try/finally
# in _run, start/request_stop) is near-identical to search_index.py's, and
# consolidating it into one helper is on the backlog. Kept duplicated for
# now on purpose: that code carries several fixes for stuck-state bugs found
# live, and refactoring it would put search indexing — which is itself an
# offline dependency — at risk to save forty lines.
