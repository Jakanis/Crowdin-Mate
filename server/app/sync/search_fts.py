"""Read/write helpers for the strings_fts full-text index, shared by every
sync path that touches it (file_content_sync.py, bulk_search_sync.py,
db.py's backfill).

strings_fts holds one row per (string_id, language_id) — see schema.sql
for why a companion strings_fts_map table exists to bridge that composite
key to the FTS5 table's rowid. All writes go through the two functions
below rather than touching strings_fts/strings_fts_map directly, so the
placeholder-claiming logic (a string's source-only row, synced before any
language's target text, gets converted in place by whichever language
syncs first) only has to be right in one place.
"""

import sqlite3


def _get_or_create_fts_rowid(conn: sqlite3.Connection, string_id: int, language_id: str) -> int:
    row = conn.execute(
        "SELECT id FROM strings_fts_map WHERE string_id = ? AND language_id = ?",
        (string_id, language_id),
    ).fetchone()
    if row is not None:
        return row["id"]
    cur = conn.execute(
        "INSERT INTO strings_fts_map (string_id, language_id) VALUES (?, ?)",
        (string_id, language_id),
    )
    return cur.lastrowid


def upsert_source_text(conn: sqlite3.Connection, string_id: int, identifier: str, source_text: str) -> None:
    """Project-wide source-only sync (bulk_sync_source_strings) — no
    specific target language in hand, so this refreshes identifier/
    source_text on every language row already synced for this string
    (target_text untouched), or creates the '' placeholder row if none
    exist yet."""
    rowids = [
        row["id"] for row in conn.execute(
            "SELECT id FROM strings_fts_map WHERE string_id = ?", (string_id,)
        )
    ]
    if not rowids:
        rowids = [_get_or_create_fts_rowid(conn, string_id, "")]
    for rowid in rowids:
        existing = conn.execute("SELECT target_text FROM strings_fts WHERE rowid = ?", (rowid,)).fetchone()
        target_text = existing["target_text"] if existing else ""
        conn.execute(
            "INSERT OR REPLACE INTO strings_fts(rowid, identifier, source_text, target_text) VALUES (?, ?, ?, ?)",
            (rowid, identifier, source_text, target_text),
        )


def upsert_target_text(
    conn: sqlite3.Connection, string_id: int, language_id: str, identifier: str, source_text: str, target_text: str
) -> None:
    """A specific language's target text is known — claims this string's
    '' placeholder row if it's the first language synced for it,
    otherwise updates (or creates) that language's own row."""
    placeholder = conn.execute(
        "SELECT id FROM strings_fts_map WHERE string_id = ? AND language_id = ''", (string_id,)
    ).fetchone()
    if placeholder is not None:
        rowid = placeholder["id"]
        conn.execute("UPDATE strings_fts_map SET language_id = ? WHERE id = ?", (language_id, rowid))
    else:
        rowid = _get_or_create_fts_rowid(conn, string_id, language_id)
    conn.execute(
        "INSERT OR REPLACE INTO strings_fts(rowid, identifier, source_text, target_text) VALUES (?, ?, ?, ?)",
        (rowid, identifier, source_text, target_text),
    )


def delete_strings(conn: sqlite3.Connection, string_ids: list[int]) -> None:
    """Drop every language's index row for these strings — used when their
    file no longer exists on Crowdin (see prune_missing in tree_sync.py).

    Both tables, in this order: strings_fts is keyed by the map's own id, so
    clearing the map first would leave orphaned FTS rows with no way left to
    find them, and they'd keep turning up in search results for files that
    no longer exist.
    """
    if not string_ids:
        return
    placeholders = ",".join("?" * len(string_ids))
    rowids = [
        row["id"]
        for row in conn.execute(
            f"SELECT id FROM strings_fts_map WHERE string_id IN ({placeholders})", tuple(string_ids)
        )
    ]
    if rowids:
        conn.execute(
            f"DELETE FROM strings_fts WHERE rowid IN ({','.join('?' * len(rowids))})", tuple(rowids)
        )
    conn.execute(f"DELETE FROM strings_fts_map WHERE string_id IN ({placeholders})", tuple(string_ids))
