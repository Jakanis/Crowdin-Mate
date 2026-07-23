"""Lazy per-string TM and glossary suggestion lookups.

Both are genuinely slow on first lookup (concordance search over the
whole project's TM/glossary, 1-6s — confirmed live, same ballpark as
Crowdin's own editor) so they're cached per string+language exactly like
comments: fetched once when the user actually looks, instant on any
revisit.
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


def _mark_looked_up(conn, string_id: int, language_id: str, kind: str, now: str) -> None:
    conn.execute(
        """
        INSERT INTO suggestion_lookups (string_id, language_id, kind, synced_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(string_id, language_id, kind) DO UPDATE SET synced_at = excluded.synced_at
        """,
        (string_id, language_id, kind, now),
    )


def has_looked_up(string_id: int, language_id: str, kind: str) -> bool:
    """Row count in tm_matches/glossary_matches alone can't tell "never
    looked up" apart from "looked up, found nothing" — and a clean
    zero-match result is the common case for unique prose in this
    project. This checks the separate marker table instead."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT 1 FROM suggestion_lookups WHERE string_id = ? AND language_id = ? AND kind = ?",
            (string_id, language_id, kind),
        ).fetchone()
    return row is not None


def sync_tm_matches(project_id: int, string_id: int, source_text: str, source_lang: str, target_lang: str) -> int:
    """Segment-level fuzzy match — the same query Crowdin's own
    "Automated Suggestions" panel runs: the whole source text as one
    expression, above a relevance floor. Real prose in this project is
    mostly unique, so an empty result is common and expected, not a bug."""
    client = get_client()
    resp = call_with_limits(
        client.translation_memory.concordance_search_in_tms,
        projectId=project_id,
        sourceLanguageId=source_lang,
        targetLanguageId=target_lang,
        autoSubstitution=True,
        minRelevant=60,
        expressions=[source_text],
    )
    matches = [_unwrap(m) for m in resp.get("data", [])]

    now = _now()
    with get_conn() as conn:
        conn.execute(
            "DELETE FROM tm_matches WHERE string_id = ? AND language_id = ?",
            (string_id, target_lang),
        )
        for m in matches:
            conn.execute(
                """
                INSERT INTO tm_matches
                    (string_id, language_id, source_text, target_text, relevant, tm_name, updated_at, cached_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    string_id, target_lang,
                    m.get("source", ""), m.get("target", ""),
                    m.get("relevant", 0),
                    (m.get("tm") or {}).get("name"),
                    m.get("updatedAt"),
                    now,
                ),
            )
        _mark_looked_up(conn, string_id, target_lang, "tm", now)
    return len(matches)


def sync_glossary_matches(project_id: int, string_id: int, source_text: str, source_lang: str, target_lang: str) -> int:
    """Concordance search against the project's glossary, passing the
    whole segment as one expression — same as sync_tm_matches above.

    An earlier version of this split the text into single lowercased
    words first (stripping stopwords), on the assumption the API only
    matches whole expressions verbatim against glossary terms. Confirmed
    live that's wrong: concordance search finds glossary terms occurring
    *within* a given expression, multi-word terms included — passing
    "The Hand of Gul'dan" as one expression matched both the single-word
    entry "Gul'dan" AND the multi-word entry "The Hand of Gul'dan" (a
    quest title), which the old word-split approach could never find no
    matter how the stopword list was tuned."""
    now = _now()

    if not source_text.strip():
        with get_conn() as conn:
            conn.execute(
                "DELETE FROM glossary_matches WHERE string_id = ? AND language_id = ?",
                (string_id, target_lang),
            )
            _mark_looked_up(conn, string_id, target_lang, "glossary", now)
        return 0

    client = get_client()
    resp = call_with_limits(
        client.glossaries.concordance_search_in_glossaries,
        projectId=project_id,
        sourceLanguageId=source_lang,
        targetLanguageId=target_lang,
        expressions=[source_text],
    )
    matches = [_unwrap(m) for m in resp.get("data", [])]

    with get_conn() as conn:
        conn.execute(
            "DELETE FROM glossary_matches WHERE string_id = ? AND language_id = ?",
            (string_id, target_lang),
        )
        for m in matches:
            source_terms = m.get("sourceTerms") or []
            target_terms = m.get("targetTerms") or []
            if not source_terms:
                continue
            conn.execute(
                """
                INSERT INTO glossary_matches
                    (string_id, language_id, source_term, target_term, description, glossary_name, cached_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    string_id, target_lang,
                    source_terms[0].get("text", ""),
                    target_terms[0].get("text", "") if target_terms else "",
                    source_terms[0].get("description"),
                    (m.get("glossary") or {}).get("name"),
                    now,
                ),
            )
        _mark_looked_up(conn, string_id, target_lang, "glossary", now)
    return len(matches)
