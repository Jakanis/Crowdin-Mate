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

Two sources are combined, and it has to be both:

1. list_language_translations sorted by createdAt descending, walked
   newest-first until we pass the point last checked. Cheap (169
   translations over 3 days came back in one 500-row page in 1.2s), works
   on any role, and its cost tracks how much has happened rather than how
   big the project is. Blind to approvals, which create no new translation.

2. The contribution raw-data report — what Crowdin's Activity tab is built
   on. Has an APPROVALS mode, and each row names its file directly. Costs
   an async generate/poll/download cycle (~5s) and is manager-only.

Measured over the same four days, the report's file set was a strict SUBSET
of the scan's: 77 files against 85, with 8 the report never mentioned. So
"use the report, fall back to the scan" would have quietly lost changes.
The scan is the floor and the report adds the approvals it alone can see.
"""

import csv
import io
import logging
import time
from datetime import datetime, timezone

import requests

from crowdin_api.api_resources.reports.enums import ContributionMode, Unit
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

# Report generation is queued server-side; on this project it finishes in a
# couple of seconds. Bounded so a stuck report can't hang a cache build.
_REPORT_POLL_ATTEMPTS = 40
_REPORT_POLL_SECONDS = 1


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


def _report_changed_files(project_id: int, language_id: str, since: datetime) -> dict | None:
    """Changed files from Crowdin's contribution raw-data report — what the
    Activity tab is built on.

    Better than the translations walk below in two ways. It has an APPROVALS
    mode, so it sees someone approving an existing translation, which creates
    no new translation and is therefore invisible to a createdAt scan (281
    such events in four days on this project). And each row carries File
    Identifier directly, so no local string-to-file mapping is needed —
    which also means it still works for a file we've never cached.

    Returns None if the report isn't available, so the caller can fall back.
    Reports are a manager-level feature: a plain translator's token gets a
    403 here, and that must not break change detection for them.
    """
    client = get_client()
    now = datetime.now(timezone.utc)
    file_ids: set[int] = set()
    events = 0

    for mode, label in ((ContributionMode.TRANSLATIONS, "translations"),
                        (ContributionMode.APPROVALS, "approvals")):
        resp = call_with_limits(
            client.reports.generate_contribution_raw_data_report,
            projectId=project_id, mode=mode, unit=Unit.STRINGS,
            languageId=language_id, dateFrom=since, dateTo=now,
        )
        report_id = (resp.get("data") or resp)["identifier"]

        status = None
        for _ in range(_REPORT_POLL_ATTEMPTS):
            check = call_with_limits(
                client.reports.check_report_generation_status,
                reportId=report_id, projectId=project_id,
            )
            status = (check.get("data") or check).get("status")
            if status in ("finished", "failed", "canceled"):
                break
            time.sleep(_REPORT_POLL_SECONDS)
        if status != "finished":
            logger.info("contribution report (%s) did not finish: %s", label, status)
            return None

        download = call_with_limits(
            client.reports.download_report, reportId=report_id, projectId=project_id
        )
        url = (download.get("data") or download)["url"]
        text = requests.get(url, timeout=60).content.decode("utf-8-sig", "replace")
        for row in csv.DictReader(io.StringIO(text)):
            raw_id = (row.get("File Identifier") or "").strip()
            if raw_id.isdigit():
                file_ids.add(int(raw_id))
                events += 1

    return {"file_ids": sorted(file_ids), "events": events, "source": "report"}


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
        return {"file_ids": [], "translations": 0, "since": None, "truncated": False, "source": "none"}

    # Both sources, unioned — NOT one or the other.
    #
    # The obvious design is "use the report, fall back to the scan", since
    # the report also covers approvals. Comparing them on real data killed
    # that: over the same four days the report returned 77 files and the
    # scan 85, with the report's set a strict SUBSET — every report file was
    # in the scan, and the scan caught 8 the report missed. Preferring the
    # report would therefore have silently dropped changes.
    #
    # So the scan is the floor (cheap, works on any role) and the report adds
    # what only it can see. A report failure — most likely a 403, since
    # reports are manager-level — just means the approvals half is missing,
    # not that change detection breaks.
    report_file_ids: set[int] = set()
    report_events = 0
    used_report = False
    try:
        via_report = _report_changed_files(project_id, language_id, since)
        if via_report is not None:
            report_file_ids = set(via_report["file_ids"])
            report_events = via_report["events"]
            used_report = True
    except Exception:
        logger.info("contribution report unavailable; scan only", exc_info=True)

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

    scan_file_ids: set[int] = set()
    if string_ids:
        placeholders = ",".join("?" * len(string_ids))
        with get_conn() as conn:
            rows = conn.execute(
                f"SELECT DISTINCT file_id FROM source_strings WHERE id IN ({placeholders})",
                tuple(string_ids),
            ).fetchall()
        scan_file_ids = {r["file_id"] for r in rows}

    file_ids = sorted(scan_file_ids | report_file_ids)
    source = "scan+report" if used_report else "scan"
    logger.info(
        "translation changes (%s): %d scanned + %d reported event(s) across %d file(s) "
        "(scan %d, report %d) since %s for %s/%s",
        source, counted, report_events, len(file_ids),
        len(scan_file_ids), len(report_file_ids), since.isoformat(), project_id, language_id,
    )
    return {
        "file_ids": file_ids,
        "translations": counted + report_events,
        "since": since.isoformat(),
        "truncated": truncated,
        "source": source,
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
