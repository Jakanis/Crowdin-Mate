"""Lazy per-string TM and glossary suggestion lookups.

Both are genuinely slow on first lookup (concordance search over the
whole project's TM/glossary, 1-6s — confirmed live, same ballpark as
Crowdin's own editor) so they're cached per string+language exactly like
comments: fetched once when the user actually looks, instant on any
revisit.
"""

import logging
import re
from datetime import datetime, timezone

from app.crowdin_client import call_with_limits, get_client
from app.db import get_conn

logger = logging.getLogger(__name__)

# Small stopword list to cut noise out of glossary lookups — these are
# common enough that they're never going to be meaningful glossary terms
# themselves, and every one skipped is one fewer expression per call.
_STOPWORDS = {
    "a", "an", "the", "and", "or", "but", "to", "of", "in", "on", "at", "is",
    "was", "were", "be", "been", "am", "i", "you", "he", "she", "it", "we",
    "they", "this", "that", "my", "your", "his", "her", "its", "our", "their",
    "for", "with", "as", "by", "from", "not", "no", "do", "does", "did",
    "have", "has", "had", "will", "would", "can", "could", "should", "must",
    "if", "then", "so", "than", "too", "very", "just", "up", "down", "out",
    "about", "into", "over", "under", "again", "once", "here", "there",
    "when", "where", "why", "how", "all", "each", "few", "more", "most",
    "other", "some", "such", "only", "own", "same", "now", "me",
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _unwrap(item: dict) -> dict:
    return item.get("data", item) if isinstance(item, dict) else item


def _extract_words(text: str) -> list[str]:
    words = re.findall(r"[A-Za-z][A-Za-z'-]*", text)
    seen: dict[str, str] = {}
    for w in words:
        key = w.lower()
        if key in _STOPWORDS or len(key) < 3:
            continue
        seen.setdefault(key, w)  # keep first-seen casing
    return list(seen.values())


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
                INSERT INTO tm_matches (string_id, language_id, source_text, target_text, relevant, tm_name, cached_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    string_id, target_lang,
                    m.get("source", ""), m.get("target", ""),
                    m.get("relevant", 0),
                    (m.get("tm") or {}).get("name"),
                    now,
                ),
            )
        _mark_looked_up(conn, string_id, target_lang, "tm", now)
    return len(matches)


def sync_glossary_matches(project_id: int, string_id: int, source_text: str, source_lang: str, target_lang: str) -> int:
    """Word-level concordance search against the project's glossary.
    Only single-word terms are caught this way — multi-word glossary
    entries (e.g. a two-word proper noun) won't match a unigram
    expression list. Known limitation, not attempted here."""
    words = _extract_words(source_text)
    now = _now()

    if not words:
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
        expressions=words,
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
