"""Explicit, opt-in wholesale sync of a project's glossary terms.

Separate from sync_glossary_matches (suggestions_sync.py), which stays a
live per-string concordance lookup — that needs Crowdin's own relevance
ranking against the whole segment, not something replicable locally.
This module exists purely so glossary SEARCH (look up any term in the
project's glossary, not "what applies to this string") can run fully
offline against the local cache, same idea as search_index.py for
full-text string search.

Confirmed live: ~30k term rows (source+target pairs) for a ~15k-concept
glossary took about 24s to fetch in full via with_fetch_all() — a real
but bounded one-time cost, not something to run automatically.
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


def sync_project_glossary(project_id: int) -> int:
    client = get_client()
    glossaries_resp = call_with_limits(client.glossaries.list_glossaries)
    glossary_ids = [
        g["id"]
        for g in (_unwrap(item) for item in glossaries_resp.get("data", []))
        if project_id in (g.get("projectIds") or [])
    ]

    now = _now()
    total = 0
    with get_conn() as conn:
        conn.execute("DELETE FROM glossary_terms WHERE project_id = ?", (project_id,))
        for glossary_id in glossary_ids:
            terms_resp = call_with_limits(
                client.glossaries.with_fetch_all().list_terms, glossaryId=glossary_id
            )
            for item in terms_resp.get("data", []):
                t = _unwrap(item)
                conn.execute(
                    """
                    INSERT INTO glossary_terms
                        (id, project_id, glossary_id, concept_id, language_id, text, description, synced_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        t["id"],
                        project_id,
                        glossary_id,
                        t["conceptId"],
                        t["languageId"],
                        t.get("text", ""),
                        t.get("description"),
                        now,
                    ),
                )
                total += 1

    logger.info("Synced glossary for project %s: %d term(s) across %d glossary/ies", project_id, total, len(glossary_ids))
    return total


def get_glossary_status(project_id: int) -> dict:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT COUNT(DISTINCT concept_id) c, MAX(synced_at) s FROM glossary_terms WHERE project_id = ?",
            (project_id,),
        ).fetchone()
    return {"terms": row["c"], "synced_at": row["s"]}


def search_glossary(project_id: int, q: str, source_language_id: str, target_language_id: str, limit: int) -> list[dict]:
    q = q.strip()
    if not q:
        return []

    with get_conn() as conn:
        concept_ids = [
            row["concept_id"]
            for row in conn.execute(
                """
                SELECT DISTINCT concept_id FROM glossary_terms
                WHERE project_id = ? AND text LIKE ? ESCAPE '\\'
                LIMIT ?
                """,
                (project_id, f"%{_escape_like(q)}%", limit),
            )
        ]
        if not concept_ids:
            return []

        placeholders = ",".join("?" * len(concept_ids))
        rows = conn.execute(
            f"""
            SELECT concept_id, language_id, text, description
            FROM glossary_terms
            WHERE project_id = ? AND concept_id IN ({placeholders})
            """,
            (project_id, *concept_ids),
        ).fetchall()

    by_concept: dict[int, dict[str, dict]] = {}
    for r in rows:
        by_concept.setdefault(r["concept_id"], {})[r["language_id"]] = {
            "text": r["text"],
            "description": r["description"],
        }

    results = []
    for concept_id, langs in by_concept.items():
        source = langs.get(source_language_id)
        if source is None:
            continue
        target = langs.get(target_language_id)
        results.append(
            {
                "concept_id": concept_id,
                "source_term": source["text"],
                "target_term": target["text"] if target else "",
                "description": source.get("description"),
            }
        )
    return results


def _escape_like(q: str) -> str:
    return q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
