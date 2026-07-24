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
}


def _apply_column_migrations(conn: sqlite3.Connection) -> None:
    for table, columns in _COLUMN_MIGRATIONS.items():
        existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
        for name, decl in columns:
            if name not in existing:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")


def _backfill_search_index(conn: sqlite3.Connection) -> None:
    """strings_fts is new — anything synced by an older run of this app
    before it existed was never written there. Cheap self-healing pass
    (a no-op once caught up) rather than a one-shot migration, so it also
    recovers from e.g. a crash mid-write in sync_file_content."""
    conn.execute(
        """
        INSERT INTO strings_fts(rowid, identifier, source_text, target_text)
        SELECT ss.id, COALESCE(ss.identifier, ''), ss.text,
               COALESCE((SELECT group_concat(t.text, ' ') FROM translations t WHERE t.string_id = ss.id), '')
        FROM source_strings ss
        WHERE ss.id NOT IN (SELECT rowid FROM strings_fts)
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


def init_db() -> None:
    conn = _connect()
    try:
        conn.executescript(_SCHEMA_PATH.read_text())
        _apply_column_migrations(conn)
        _backfill_search_index(conn)
        _reset_stale_glossary_matches(conn)
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
