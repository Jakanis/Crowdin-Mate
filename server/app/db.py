"""SQLite connection helper.

One connection per request via FastAPI's dependency system; WAL mode so the
background sync worker and the request-handling thread don't block each
other on every read.
"""

import sqlite3
from contextlib import contextmanager
from pathlib import Path

from app.config import DB_PATH

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
}


def _apply_column_migrations(conn: sqlite3.Connection) -> None:
    for table, columns in _COLUMN_MIGRATIONS.items():
        existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
        for name, decl in columns:
            if name not in existing:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")


def init_db() -> None:
    conn = _connect()
    try:
        conn.executescript(_SCHEMA_PATH.read_text())
        _apply_column_migrations(conn)
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
