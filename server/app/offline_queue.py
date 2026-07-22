"""Durable outbox for translation submissions.

A typed translation is written to `translation_drafts` the instant it's
submitted, independent of whether the network call to Crowdin succeeds.
If the live call fails (offline, rate-limited, Crowdin down), the
operation lands in `offline_queue` instead of being lost, and a
background loop drains it through the same rate limiter as everything
else once conditions recover.
"""

import json
import logging
from datetime import datetime, timezone

from crowdin_api.exceptions import APIException

from app.crowdin_client import call_with_limits, get_client
from app.db import get_conn

logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def enqueue_add_translation(project_id: int, string_id: int, language_id: str, text: str) -> None:
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO offline_queue (operation_type, payload_json, string_id, language_id, created_at, status)
            VALUES ('add_translation', ?, ?, ?, ?, 'pending')
            """,
            (
                json.dumps({"project_id": project_id, "string_id": string_id, "language_id": language_id, "text": text}),
                string_id,
                language_id,
                _now(),
            ),
        )


def drain_once(max_items: int = 20) -> int:
    """Attempt every pending queue item once. Returns how many succeeded."""
    with get_conn() as conn:
        rows = [
            dict(r) for r in conn.execute(
                "SELECT * FROM offline_queue WHERE status = 'pending' ORDER BY created_at LIMIT ?",
                (max_items,),
            )
        ]

    if not rows:
        return 0

    client = get_client()
    succeeded = 0

    for row in rows:
        payload = json.loads(row["payload_json"])
        try:
            if row["operation_type"] == "add_translation":
                call_with_limits(
                    client.string_translations.add_translation,
                    projectId=payload["project_id"],
                    stringId=payload["string_id"],
                    languageId=payload["language_id"],
                    text=payload["text"],
                )
            else:
                raise ValueError(f"Unknown operation_type: {row['operation_type']}")

            with get_conn() as conn:
                conn.execute("UPDATE offline_queue SET status = 'done' WHERE id = ?", (row["id"],))
                conn.execute(
                    "UPDATE translation_drafts SET dirty = 0 WHERE string_id = ? AND language_id = ?",
                    (row["string_id"], row["language_id"]),
                )
            succeeded += 1

        except Exception as exc:  # noqa: BLE001 - outbox must never crash on a bad item
            # A validation-type error (e.g. Crowdin's "duplicate
            # translation" check) will never succeed no matter how many
            # times we retry it — mark it terminal instead of retrying
            # forever every drain cycle.
            terminal = isinstance(exc, APIException) and not exc.should_retry
            logger.warning(
                "offline_queue item %s %s: %s",
                row["id"], "permanently failed" if terminal else "failed again", exc,
            )
            with get_conn() as conn:
                conn.execute(
                    """
                    UPDATE offline_queue
                    SET attempts = attempts + 1, last_attempt_at = ?, last_error = ?,
                        status = ?
                    WHERE id = ?
                    """,
                    (_now(), str(exc), "failed" if terminal else "pending", row["id"]),
                )

    return succeeded
