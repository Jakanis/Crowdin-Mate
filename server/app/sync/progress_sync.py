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

from app.crowdin_client import OFFLINE_ERRORS, call_with_limits, get_client
from app.db import get_conn

logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _unwrap(item: dict) -> dict:
    return item.get("data", item) if isinstance(item, dict) else item


def _percent(count: int, total: int) -> int:
    """Floors rather than rounds — round(999/1000*100) is 100, which would
    show a file as fully translated/approved (and, per FileTree.tsx,
    collapse its whole progress indicator to a bare checkmark) when one
    single string genuinely isn't done yet. 100% only ever means
    count >= total; everything short of that tops out at 99%, however
    close, matching what a proofreader actually needs to know: is there
    still something left to do here or not."""
    if total <= 0 or count >= total:
        return 100
    return min(99, int(count / total * 100))


def _counts(row: dict) -> dict:
    """Raw phrase and word counts from the same response the percentages
    come from. Kept because a percentage alone can't answer "how much is
    left" — 99% of a 5-string file and 99% of a 900-string one are very
    different amounts of work — and because words are the fairer measure
    when file sizes vary this much. Costs no extra API call: both
    breakdowns are already in the payload."""
    phrases = row.get("phrases") or {}
    words = row.get("words") or {}
    return {
        "phrases_total": phrases.get("total", 0),
        "phrases_translated": phrases.get("translated", 0),
        "phrases_approved": phrases.get("approved", 0),
        "words_total": words.get("total", 0),
        "words_translated": words.get("translated", 0),
        "words_approved": words.get("approved", 0),
    }


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

    # Counted in strings, not words — see the matching note in
    # sync_file_progress. Confirmed live that get_directory_progress
    # carries the same phrases: {total, translated, approved} breakdown
    # as get_file_progress, so this is free here too.
    phrases = row.get("phrases") or {}
    total = phrases.get("total", 0)
    now = _now()
    progress = {
        "translation_progress": _percent(phrases.get("translated", 0), total),
        "approval_progress": _percent(phrases.get("approved", 0), total),
        **_counts(row),
    }
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO directory_progress (directory_id, language_id, translation_progress, approval_progress, cached_at,
                phrases_total, phrases_translated, phrases_approved,
                words_total, words_translated, words_approved)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(directory_id, language_id) DO UPDATE SET
                translation_progress=excluded.translation_progress,
                approval_progress=excluded.approval_progress,
                cached_at=excluded.cached_at,
                phrases_total=excluded.phrases_total,
                phrases_translated=excluded.phrases_translated,
                phrases_approved=excluded.phrases_approved,
                words_total=excluded.words_total,
                words_translated=excluded.words_translated,
                words_approved=excluded.words_approved
            """,
            (directory_id, language_id, progress["translation_progress"],
             progress["approval_progress"], now,
             *[progress[k] for k in ("phrases_total", "phrases_translated", "phrases_approved",
                                     "words_total", "words_translated", "words_approved")]),
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

    # Counted in strings, not words — the `phrases` breakdown (confirmed
    # live: {"total", "translated", "approved"}) is already present in
    # the same response we're fetching anyway, so this costs nothing
    # extra — no additional API call.
    phrases = row.get("phrases") or {}
    total = phrases.get("total", 0)
    now = _now()
    progress = {
        "translation_progress": _percent(phrases.get("translated", 0), total),
        "approval_progress": _percent(phrases.get("approved", 0), total),
        **_counts(row),
    }
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO file_progress (file_id, language_id, translation_progress, approval_progress, cached_at,
                phrases_total, phrases_translated, phrases_approved,
                words_total, words_translated, words_approved)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(file_id, language_id) DO UPDATE SET
                translation_progress=excluded.translation_progress,
                approval_progress=excluded.approval_progress,
                cached_at=excluded.cached_at,
                phrases_total=excluded.phrases_total,
                phrases_translated=excluded.phrases_translated,
                phrases_approved=excluded.phrases_approved,
                words_total=excluded.words_total,
                words_translated=excluded.words_translated,
                words_approved=excluded.words_approved
            """,
            (file_id, language_id, progress["translation_progress"],
             progress["approval_progress"], now,
             *[progress[k] for k in ("phrases_total", "phrases_translated", "phrases_approved",
                                     "words_total", "words_translated", "words_approved")]),
        )
    return progress


def invalidate_progress_for_file(file_id: int, language_id: str) -> None:
    """Called after any action that changes a file's translation/approval
    counts (submit, approve, unapprove, delete, a drained offline-queue
    submit) so the tree's progress bars refetch live next time they're
    shown instead of quietly keeping whatever was cached the moment the
    folder was first expanded — get_children_progress only ever fetches
    a child that ISN'T already cached, so without this an approved file
    would show its old percentage forever. Also walks up the ancestor
    directory chain, since a parent folder's aggregate is just as stale
    once any of its children's counts change."""
    with get_conn() as conn:
        conn.execute(
            "DELETE FROM file_progress WHERE file_id = ? AND language_id = ?", (file_id, language_id)
        )
        row = conn.execute("SELECT directory_id FROM files WHERE id = ?", (file_id,)).fetchone()
        dir_id = row["directory_id"] if row else None
        while dir_id is not None:
            conn.execute(
                "DELETE FROM directory_progress WHERE directory_id = ? AND language_id = ?",
                (dir_id, language_id),
            )
            parent_row = conn.execute(
                "SELECT parent_id FROM directories WHERE id = ?", (dir_id,)
            ).fetchone()
            dir_id = parent_row["parent_id"] if parent_row else None


def _local_file_progress(file_id: int, language_id: str) -> dict | None:
    """Progress computed from the local cache, for when Crowdin is
    unreachable.

    Only meaningful once a file's content has been synced — with no strings
    cached there's nothing to count, and reporting 0/0 as "100%" would be a
    lie, so that case returns None and the bar is simply absent.

    Words are left null: Crowdin counts those server-side and we don't store
    a per-string word count. The tooltip already handles missing counts.
    """
    with get_conn() as conn:
        row = conn.execute(
            """
            SELECT
              (SELECT COUNT(*) FROM source_strings WHERE file_id = ?) total,
              (SELECT COUNT(DISTINCT t.string_id) FROM translations t
                JOIN source_strings s ON s.id = t.string_id
                WHERE s.file_id = ? AND t.language_id = ?) translated,
              (SELECT COUNT(DISTINCT t.string_id) FROM translations t
                JOIN source_strings s ON s.id = t.string_id
                WHERE s.file_id = ? AND t.language_id = ? AND t.is_approved = 1) approved
            """,
            (file_id, file_id, language_id, file_id, language_id),
        ).fetchone()
    total = row["total"] or 0
    if total == 0:
        return None
    return {
        "translation_progress": _percent(row["translated"] or 0, total),
        "approval_progress": _percent(row["approved"] or 0, total),
        "phrases_total": total,
        "phrases_translated": row["translated"] or 0,
        "phrases_approved": row["approved"] or 0,
        "words_total": None,
        "words_translated": None,
        "words_approved": None,
    }


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
            row["directory_id"]: {k: row[k] for k in row.keys() if k != "directory_id"}
            for row in conn.execute(
                f"""
                SELECT directory_id, translation_progress, approval_progress, phrases_total, phrases_translated, phrases_approved, words_total, words_translated, words_approved FROM directory_progress
                WHERE language_id = ? AND directory_id IN ({",".join("?" * len(child_dirs))})
                """,
                (language_id, *child_dirs),
            )
        } if child_dirs else {}

        cached_files = {
            row["file_id"]: {k: row[k] for k in row.keys() if k != "file_id"}
            for row in conn.execute(
                f"""
                SELECT file_id, translation_progress, approval_progress, phrases_total, phrases_translated, phrases_approved, words_total, words_translated, words_approved FROM file_progress
                WHERE language_id = ? AND file_id IN ({",".join("?" * len(child_files))})
                """,
                (language_id, *child_files),
            )
        } if child_files else {}

    # Each child is fetched independently and may fail on its own.
    #
    # These used to propagate, so ONE uncached child with no connection
    # turned the whole request into a 500 and every bar in the folder
    # disappeared — including the ones that were cached and perfectly
    # displayable. Confirmed live: expanding a folder whose progress had
    # never been fetched wiped the tree's bars, and since the tab strips use
    # this same endpoint, theirs too.
    directories: dict[int, dict] = dict(cached_dirs)
    for did in child_dirs:
        if did in directories:
            continue
        try:
            progress = sync_directory_progress(project_id, did, language_id)
        except OFFLINE_ERRORS:
            continue
        if progress is not None:
            directories[did] = progress

    files: dict[int, dict] = dict(cached_files)
    for fid in child_files:
        if fid in files:
            continue
        try:
            progress = sync_file_progress(project_id, fid, language_id)
        except OFFLINE_ERRORS:
            # Counted from what's already cached instead. A file whose
            # content we hold locally can have its progress derived without
            # Crowdin at all — and unlike a cached percentage, this one
            # moves as you translate offline.
            local = _local_file_progress(fid, language_id)
            if local is not None:
                files[fid] = local
            continue
        if progress is not None:
            files[fid] = progress

    return {"directories": directories, "files": files}
