"""SQLite connection helper.

One connection per request via FastAPI's dependency system; WAL mode so the
background sync worker and the request-handling thread don't block each
other on every read.
"""

import sys
import sqlite3
from contextlib import contextmanager
from pathlib import Path

from app.config import DB_PATH
from app.sync.search_fts import upsert_source_text, upsert_target_text

# Frozen (PyInstaller) builds extract everything under sys._MEIPASS rather
# than a real checkout with schema.sql sitting next to this file on disk —
# see desktop.spec, which bundles it at that same "app/schema.sql" path.
if getattr(sys, "frozen", False):
    _SCHEMA_PATH = Path(sys._MEIPASS) / "app" / "schema.sql"  # type: ignore[attr-defined]
else:
    _SCHEMA_PATH = Path(__file__).parent / "schema.sql"


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.row_factory = sqlite3.Row
    return conn


# Columns added to existing tables after their initial CREATE. schema.sql's
# CREATE TABLE IF NOT EXISTS won't alter a table that already exists, so an
# already-populated dev cache needs these applied explicitly. Each entry is
# idempotent — we only add a column that isn't already present.
_COLUMN_MIGRATIONS = {
    "translations": [
        ("rating", "INTEGER NOT NULL DEFAULT 0"),
        ("is_approved", "INTEGER NOT NULL DEFAULT 0"),
        ("approval_id", "INTEGER"),
    ],
    "source_strings": [
        ("label_ids_json", "TEXT NOT NULL DEFAULT '[]'"),
    ],
    "tm_matches": [
        ("updated_at", "TEXT"),
    ],
    "files": [
        ("search_synced_at", "TEXT"),
    ],
    "projects": [
        # Crowdin's own project-level "last activity" timestamp — confirmed
        # live to be distinct from (and updates far more often than)
        # updatedAt, which only reflects project *settings* changes. Used
        # as a cheap single-call signal for "has anything changed since we
        # last crawled the tree" — see check_and_sync_if_changed in
        # tree_sync.py.
        ("last_activity", "TEXT"),
        # Crowdin's URL slug. Cached so the offline project list can still
        # build "Open in Crowdin" links — list_projects is the only place
        # this is returned, and that call is exactly what's unavailable
        # offline. Populated by list_projects in main.py.
        ("identifier", "TEXT"),
    ],
}


def _apply_column_migrations(conn: sqlite3.Connection) -> None:
    for table, columns in _COLUMN_MIGRATIONS.items():
        existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
        for name, decl in columns:
            if name not in existing:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")


def _migrate_strings_fts_schema(conn: sqlite3.Connection) -> None:
    """strings_fts used to hold one row per string (rowid = string_id),
    which could only ever cache one language's target_text at a time —
    broken for a project with more than one target language. The fix
    needs a companion strings_fts_map table (see schema.sql); FTS5 tables
    can't ALTER TABLE, so an install that predates strings_fts_map has its
    old-shape strings_fts dropped and rebuilt fresh — safe since it's a
    fully rebuildable cache and _backfill_search_index repopulates it,
    same as a first run."""
    has_map = conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'strings_fts_map'"
    ).fetchone()
    if has_map is None:
        has_fts = conn.execute(
            "SELECT name FROM sqlite_master WHERE name = 'strings_fts'"
        ).fetchone()
        if has_fts is not None:
            conn.execute("DROP TABLE strings_fts")


def _backfill_search_index(conn: sqlite3.Connection) -> None:
    """strings_fts is new — anything synced by an older run of this app
    before it existed was never written there. Cheap self-healing pass
    (a no-op once caught up) rather than a one-shot migration, so it also
    recovers from e.g. a crash mid-write in sync_file_content. Covers
    each language with cached translations separately (see
    app/sync/search_fts.py) rather than mixing them into one blob."""
    missing = conn.execute(
        """
        SELECT ss.id, ss.identifier, ss.text
        FROM source_strings ss
        WHERE ss.id NOT IN (SELECT DISTINCT string_id FROM strings_fts_map)
        """
    ).fetchall()
    for row in missing:
        translations_by_lang: dict[str, list[str]] = {}
        for t in conn.execute(
            "SELECT language_id, text FROM translations WHERE string_id = ?", (row["id"],)
        ):
            translations_by_lang.setdefault(t["language_id"], []).append(t["text"])

        identifier = row["identifier"] or ""
        if not translations_by_lang:
            upsert_source_text(conn, row["id"], identifier, row["text"])
        else:
            for language_id, texts in translations_by_lang.items():
                upsert_target_text(conn, row["id"], language_id, identifier, row["text"], " ".join(texts))


def _backfill_file_language_sync(conn: sqlite3.Connection) -> None:
    """file_language_sync/file_search_sync are new — an install with files
    already synced under the old file-level-only content_synced_at/
    search_synced_at flags would otherwise look "never synced for this
    language" and get needlessly re-synced once more on next open. Only
    ever needs to run once, right after the migration that introduced
    these tables, so it's gated on each table being empty rather than a
    per-row NOT-IN scan like _backfill_search_index."""
    if conn.execute("SELECT 1 FROM file_language_sync LIMIT 1").fetchone() is None:
        conn.execute(
            """
            INSERT INTO file_language_sync (file_id, language_id, synced_at)
            SELECT DISTINCT f.id, t.language_id, f.content_synced_at
            FROM files f
            JOIN source_strings ss ON ss.file_id = f.id
            JOIN translations t ON t.string_id = ss.id
            WHERE f.content_synced_at IS NOT NULL
            ON CONFLICT(file_id, language_id) DO NOTHING
            """
        )
    if conn.execute("SELECT 1 FROM file_search_sync LIMIT 1").fetchone() is None:
        conn.execute(
            """
            INSERT INTO file_search_sync (file_id, language_id, synced_at)
            SELECT DISTINCT f.id, m.language_id, COALESCE(f.search_synced_at, f.content_synced_at)
            FROM files f
            JOIN source_strings ss ON ss.file_id = f.id
            JOIN strings_fts_map m ON m.string_id = ss.id
            WHERE m.language_id != ''
              AND (f.content_synced_at IS NOT NULL OR f.search_synced_at IS NOT NULL)
            ON CONFLICT(file_id, language_id) DO NOTHING
            """
        )


def _reset_stale_glossary_matches(conn: sqlite3.Connection) -> None:
    """One-time cache bust: sync_glossary_matches used to search
    single-word tokens (stopwords stripped) instead of the whole
    segment, which could never find a multi-word glossary term (e.g. a
    quest title). Cached results and "already looked up" markers from
    that version are silently incomplete, not just stale, so they need
    clearing rather than expiring naturally — gated by an app_config
    flag so this runs exactly once, not on every startup."""
    done = conn.execute(
        "SELECT value FROM app_config WHERE key = 'glossary_algorithm_version'"
    ).fetchone()
    if done is not None and done["value"] == "2":
        return
    conn.execute("DELETE FROM glossary_matches")
    conn.execute("DELETE FROM suggestion_lookups WHERE kind = 'glossary'")
    conn.execute(
        "INSERT INTO app_config (key, value) VALUES ('glossary_algorithm_version', '2') "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )


def _reset_rounded_progress_cache(conn: sqlite3.Connection) -> None:
    """One-time cache bust: file_progress/directory_progress used to be
    computed with round(), which turns e.g. 999/1000 translated into a
    reported 100% — round(99.9) is 100 — silently showing a file as fully
    done (and, per FileTree.tsx, collapsing its progress indicator to a
    bare checkmark) when it genuinely wasn't. _percent in progress_sync.py
    now floors instead, but a row already cached under the old formula
    would otherwise keep showing its inflated value indefinitely (nothing
    else invalidates it short of an actual translation change on that
    file/directory — see invalidate_progress_for_file). Gated by an
    app_config flag so this runs exactly once, not on every startup."""
    done = conn.execute(
        "SELECT value FROM app_config WHERE key = 'progress_rounding_version'"
    ).fetchone()
    if done is not None and done["value"] == "2":
        return
    conn.execute("DELETE FROM file_progress")
    conn.execute("DELETE FROM directory_progress")
    conn.execute(
        "INSERT INTO app_config (key, value) VALUES ('progress_rounding_version', '2') "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )


def init_db() -> None:
    conn = _connect()
    try:
        _migrate_strings_fts_schema(conn)
        conn.executescript(_SCHEMA_PATH.read_text())
        _apply_column_migrations(conn)
        _backfill_search_index(conn)
        _backfill_file_language_sync(conn)
        _reset_stale_glossary_matches(conn)
        _reset_rounded_progress_cache(conn)
        conn.commit()
    finally:
        conn.close()


@contextmanager
def get_conn():
    conn = _connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
