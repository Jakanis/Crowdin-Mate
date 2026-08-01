"""Find files whose TRANSLATIONS changed on Crowdin since we last cached them.

The offline cache's staleness rule compares files.updated_at against our
own synced_at, which catches source changes and nothing else. Confirmed
live, and it's not a subtle gap: translations created 2026-08-01 sit in
file 22042 whose updated_at is 2023-11-11. Crowdin moves a file's
updatedAt when its SOURCE changes; translating in it doesn't touch it.

So a fully pre-cached project silently rots. Every file reads as cached and
up to date while other people's translations accumulate behind it, and
nothing in the app would ever re-fetch them.

The project-level lastActivity probe (has_project_changed in tree_sync)
notices that *something* happened, but can't say what — it moves for
translations, comments and settings alike, so it can't drive a targeted
refresh either.

What does work: list_language_translations sorted by createdAt descending,
walked newest-first until we pass the point we last checked. That yields
exactly the strings translated since, which map to the files needing a
re-cache. Measured on this project: 169 translations across 3 days came
back in a single 500-row page in 1.2s, so the cost tracks how much has
happened rather than how big the project is.
"""

import logging
from datetime import datetime, timezone

from crowdin_api.api_resources.string_translations.enums import ListLanguageTranslationsOrderBy as OrderBy
from crowdin_api.sorting import Sorting, SortingOrder, SortingRule

from app.crowdin_client import call_with_limits, get_client
from app.db import get_conn

logger = logging.getLogger(__name__)

_PAGE = 500

# Walking back further than this means the cache is so far behind that a
# targeted refresh has stopped being the cheap option — better to say so than
# to spend dozens of calls reconstructing it.
_MAX_PAGES = 40


def _checkpoint_key(project_id: int, language_id: str) -> str:
    return f"translations_checked_at:{project_id}:{language_id}"


def _parse(value) -> datetime | None:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def get_checkpoint(project_id: int, language_id: str) -> datetime | None:
    """When translations were last checked. Falls back to the newest
    file cache timestamp: anything translated after the most recent caching
    pass is precisely what we'd be missing."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT value FROM app_config WHERE key = ?", (_checkpoint_key(project_id, language_id),)
        ).fetchone()
        if row is not None:
            parsed = _parse(row["value"])
            if parsed is not None:
                return parsed
        row = conn.execute(
            """
            SELECT MAX(s.synced_at) m FROM file_language_sync s
            JOIN files f ON f.id = s.file_id
            WHERE s.language_id = ? AND f.project_id = ?
            """,
            (language_id, project_id),
        ).fetchone()
    return _parse(row["m"]) if row else None


def set_checkpoint(project_id: int, language_id: str, when: datetime) -> None:
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO app_config (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (_checkpoint_key(project_id, language_id), when.isoformat()),
        )


def find_changed_files(project_id: int, language_id: str) -> dict:
    """File ids with translations newer than the checkpoint.

    Does NOT move the checkpoint — the caller advances it only once it has
    actually re-cached what this reported, so an interrupted refresh doesn't
    lose track of the window it never processed.
    """
    since = get_checkpoint(project_id, language_id)
    if since is None:
        # Nothing cached yet, so there's nothing to refresh — the ordinary
        # pre-cache path covers a cold start.
        return {"file_ids": [], "translations": 0, "since": None, "truncated": False}

    client = get_client()
    order = Sorting([SortingRule(OrderBy.CREATED_AT, SortingOrder.DESC)])
    string_ids: set[int] = set()
    counted = 0
    truncated = False

    for page in range(_MAX_PAGES):
        resp = call_with_limits(
            client.string_translations.list_language_translations,
            projectId=project_id, languageId=language_id,
            orderBy=order, limit=_PAGE, offset=page * _PAGE,
        )
        items = [i.get("data", i) for i in resp.get("data", [])]
        if not items:
            break
        reached_checkpoint = False
        for t in items:
            created = _parse(t.get("createdAt"))
            if created is not None and created <= since:
                reached_checkpoint = True
                break
            if t.get("stringId") is not None:
                string_ids.add(t["stringId"])
                counted += 1
        if reached_checkpoint or len(items) < _PAGE:
            break
    else:
        truncated = True

    if not string_ids:
        return {"file_ids": [], "translations": 0, "since": since.isoformat(), "truncated": truncated}

    placeholders = ",".join("?" * len(string_ids))
    with get_conn() as conn:
        rows = conn.execute(
            f"SELECT DISTINCT file_id FROM source_strings WHERE id IN ({placeholders})",
            tuple(string_ids),
        ).fetchall()
    file_ids = [r["file_id"] for r in rows]
    logger.info(
        "translation changes: %d translation(s) across %d file(s) since %s for %s/%s",
        counted, len(file_ids), since.isoformat(), project_id, language_id,
    )
    return {
        "file_ids": file_ids,
        "translations": counted,
        "since": since.isoformat(),
        "truncated": truncated,
    }


def mark_files_for_recache(file_ids: list[int], language_id: str) -> int:
    """Drop the per-language sync marker so the pre-cache treats these as
    pending again. Deliberately only the marker — the cached strings and
    translations stay readable offline until fresh ones replace them."""
    if not file_ids:
        return 0
    placeholders = ",".join("?" * len(file_ids))
    with get_conn() as conn:
        cur = conn.execute(
            f"DELETE FROM file_language_sync WHERE language_id = ? AND file_id IN ({placeholders})",
            (language_id, *file_ids),
        )
        return cur.rowcount
