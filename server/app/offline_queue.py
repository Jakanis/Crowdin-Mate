"""Durable outbox for every write we send to Crowdin.

A write is applied to the local cache immediately and, if the live call to
Crowdin fails (offline, rate-limited, Crowdin down), lands in
`offline_queue` instead of being lost. A background loop drains it through
the same rate limiter as everything else once conditions recover.

Originally this only carried translation submissions, which meant going
offline let you type translations and nothing else — approve, unapprove,
delete, restore and vote all just failed. Every write is queueable now, so
a whole session's work survives having no connection.

Ordering matters and is why draining is strictly FIFO by created_at: an
offline approve has no Crowdin approval id yet, so a later unapprove of
the same translation can only resolve one once the approve ahead of it has
actually run. `_do_unapprove` reads that id at drain time rather than
trusting what was known at enqueue time.
"""

import json
import logging
from datetime import datetime, timezone

from crowdin_api.exceptions import APIException

from app.crowdin_client import call_with_limits, get_client
from app.db import get_conn
from app.sync.progress_sync import invalidate_progress_for_file
from app.sync.suggestions_sync import invalidate_tm_lookups

logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def enqueue(
    operation_type: str,
    payload: dict,
    string_id: int | None = None,
    language_id: str | None = None,
) -> int:
    """string_id/language_id are denormalised out of the payload so the
    queue UI can show which string an item belongs to (and link to it)
    without every consumer having to know each operation's payload shape."""
    with get_conn() as conn:
        cur = conn.execute(
            """
            INSERT INTO offline_queue
                (operation_type, payload_json, string_id, language_id, created_at, status)
            VALUES (?, ?, ?, ?, ?, 'pending')
            """,
            (operation_type, json.dumps(payload), string_id, language_id, _now()),
        )
        return cur.lastrowid


def enqueue_add_translation(project_id: int, string_id: int, language_id: str, text: str) -> int:
    return enqueue(
        "add_translation",
        {"project_id": project_id, "string_id": string_id, "language_id": language_id, "text": text},
        string_id,
        language_id,
    )


def cancel_pending(operation_type: str, **payload_match) -> int:
    """Drop still-pending items of one type whose payload matches every
    given key. Returns how many were removed.

    Exists so an action that undoes a not-yet-sent action annihilates it
    instead of queueing its opposite behind it. Approving and then
    un-approving while offline should send nothing at all — sending both
    would notify watchers about an approval that, from Crowdin's point of
    view, never happened.

    Only touches 'pending': a 'failed' item is something the user can see
    and decide about, and a 'done' one has already reached Crowdin.
    """
    removed = 0
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, payload_json FROM offline_queue WHERE status = 'pending' AND operation_type = ?",
            (operation_type,),
        ).fetchall()
        for row in rows:
            try:
                payload = json.loads(row["payload_json"])
            except (ValueError, TypeError):
                continue
            if all(payload.get(k) == v for k, v in payload_match.items()):
                conn.execute("DELETE FROM offline_queue WHERE id = ?", (row["id"],))
                removed += 1
    return removed


def apply_local_approval(conn, translation_id: int, approval_id: int | None) -> None:
    """Mark one translation approved locally and drop any sibling's
    approval. Shared with main.py's own approve endpoint so the two paths
    can't drift — Crowdin silently revokes the previously approved
    candidate for the same string+language, and missing that is what
    produced the "two approved translations" bug once already.
    """
    row = conn.execute(
        "SELECT string_id, language_id FROM translations WHERE id = ?", (translation_id,)
    ).fetchone()
    if row is not None:
        conn.execute(
            "UPDATE translations SET is_approved = 0, approval_id = NULL "
            "WHERE string_id = ? AND language_id = ? AND id != ?",
            (row["string_id"], row["language_id"], translation_id),
        )
    conn.execute(
        "UPDATE translations SET is_approved = 1, approval_id = ? WHERE id = ?",
        (approval_id, translation_id),
    )


# --- drain handlers -------------------------------------------------------
#
# Each takes (client, payload) and performs the Crowdin call plus any
# reconciliation that needs a server-assigned id. The local optimistic
# state was already written when the operation was first attempted, so
# these only fix up what the offline path couldn't know.


def _do_add_translation(client, payload: dict) -> None:
    call_with_limits(
        client.string_translations.add_translation,
        projectId=payload["project_id"],
        stringId=payload["string_id"],
        languageId=payload["language_id"],
        text=payload["text"],
    )


def _do_approve(client, payload: dict) -> None:
    resp = call_with_limits(
        client.string_translations.add_approval,
        translationId=payload["translation_id"], projectId=payload["project_id"],
    )
    approval = resp.get("data", resp)
    # The approval id is only knowable now — an offline approve stored
    # is_approved=1 with a NULL approval_id, and unapprove needs this.
    with get_conn() as conn:
        apply_local_approval(conn, payload["translation_id"], approval["id"])


def _do_unapprove(client, payload: dict) -> None:
    translation_id = payload["translation_id"]
    approval_id = payload.get("approval_id")
    if approval_id is None:
        # Approved offline, so no id existed at enqueue time. FIFO means
        # the approve ahead of this one has already run and written it.
        with get_conn() as conn:
            row = conn.execute(
                "SELECT approval_id FROM translations WHERE id = ?", (translation_id,)
            ).fetchone()
        approval_id = row["approval_id"] if row is not None else None
    if approval_id is None:
        raise ValueError(
            "No approval id for this translation — the approval it was meant to "
            "remove is not on Crowdin, so there is nothing to un-approve."
        )
    call_with_limits(
        client.string_translations.remove_approval,
        approvalId=approval_id, projectId=payload["project_id"],
    )
    # Also clear it locally. The endpoint that queued this already did, but
    # _do_approve may have re-set is_approved=1 in the meantime while filling
    # in the approval id — so without this the local row could end up
    # claiming approved while Crowdin has just been told otherwise.
    with get_conn() as conn:
        conn.execute(
            "UPDATE translations SET is_approved = 0, approval_id = NULL WHERE id = ?",
            (translation_id,),
        )


def _do_delete_translation(client, payload: dict) -> None:
    call_with_limits(
        client.string_translations.delete_translation,
        translationId=payload["translation_id"], projectId=payload["project_id"],
    )


def _do_restore_translation(client, payload: dict) -> None:
    call_with_limits(
        client.string_translations.restore_translation,
        translationId=payload["translation_id"], projectId=payload["project_id"],
    )
    # Deliberately not re-fetching the restored row + its approvals here the
    # way the live endpoint does: the offline path already re-inserted the
    # snapshot from deleted_translations, and the next resync of the file
    # reconciles it against Crowdin authoritatively.


def _do_vote(client, payload: dict) -> None:
    from crowdin_api.api_resources.string_translations.enums import VoteMark

    translation_id = payload["translation_id"]
    project_id = payload["project_id"]
    call_with_limits(
        client.string_translations.add_vote,
        mark=VoteMark.UP if payload["mark"] == "up" else VoteMark.DOWN,
        translationId=translation_id, projectId=project_id,
    )
    # Offline could only guess the tally by +/-1. Recompute it from the
    # authoritative vote list now, same as the live endpoint, so an
    # implicitly-replaced opposite vote can't leave the rating drifted.
    votes_resp = call_with_limits(
        client.string_translations.with_fetch_all().list_translation_votes,
        translationId=translation_id, projectId=project_id,
    )
    votes = [v.get("data", v) for v in votes_resp.get("data", [])]
    rating = sum(1 if v.get("mark") == "up" else -1 for v in votes)
    with get_conn() as conn:
        conn.execute("UPDATE translations SET rating = ? WHERE id = ?", (rating, translation_id))


def _do_add_comment(client, payload: dict) -> None:
    from crowdin_api.api_resources.string_comments.enums import StringCommentIssueType, StringCommentType

    from app.sync.file_content_sync import sync_string_comments

    project_id = payload["project_id"]
    string_id = payload["string_id"]
    kwargs: dict = dict(
        text=payload["text"], stringId=string_id,
        targetLanguageId=payload["language_id"], projectId=project_id,
    )
    if payload.get("issue_type"):
        kwargs["type"] = StringCommentType.ISSUE
        kwargs["issueType"] = StringCommentIssueType(payload["issue_type"])
    else:
        kwargs["type"] = StringCommentType.COMMENT
    call_with_limits(client.string_comments.add_string_comment, **kwargs)

    # Drop the negative placeholder first, then resync so the real row (with
    # Crowdin's id, author and timestamp) replaces it. Order matters: the
    # resync only upserts what Crowdin returns, so it would otherwise leave
    # the placeholder behind as a duplicate.
    local_id = payload.get("local_comment_id")
    if local_id is not None:
        with get_conn() as conn:
            conn.execute("DELETE FROM comments WHERE id = ?", (local_id,))
    sync_string_comments(project_id, string_id)


def _do_set_comment_status(client, payload: dict) -> None:
    from crowdin_api.api_resources.enums import PatchOperation
    from crowdin_api.api_resources.string_comments.enums import (
        StringCommentIssueStatus,
        StringCommentPatchPath,
    )

    resolved = payload["resolved"]
    call_with_limits(
        client.string_comments.edit_string_comment,
        stringCommentId=payload["comment_id"], projectId=payload["project_id"],
        data=[
            {
                "op": PatchOperation.REPLACE,
                "path": StringCommentPatchPath.ISSUE_STATUS,
                "value": (
                    StringCommentIssueStatus.RESOLVED if resolved else StringCommentIssueStatus.UNRESOLVED
                ),
            }
        ],
    )


_HANDLERS = {
    "add_translation": _do_add_translation,
    "add_comment": _do_add_comment,
    "set_comment_status": _do_set_comment_status,
    "approve": _do_approve,
    "unapprove": _do_unapprove,
    "delete_translation": _do_delete_translation,
    "restore_translation": _do_restore_translation,
    "vote": _do_vote,
}

# Operations that change what the project's translation memory serves, so a
# cached TM lookup taken before them is stale. Applied centrally after a
# successful drain rather than inside each handler, using the queue row's own
# language_id — the same reasoning as the live paths in main.py. Voting is
# absent on purpose: a rating doesn't change which translation the TM returns.
_AFFECTS_TM = {"add_translation", "approve", "unapprove", "delete_translation", "restore_translation"}

# Only a translation submission owns a draft. The others act on an existing
# translation, so clearing dirty for them would discard an unrelated
# in-progress edit on the same string.
_OWNS_DRAFT = {"add_translation"}


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
        op = row["operation_type"]
        try:
            handler = _HANDLERS.get(op)
            if handler is None:
                raise ValueError(f"Unknown operation_type: {op}")
            handler(client, payload)

            with get_conn() as conn:
                conn.execute("UPDATE offline_queue SET status = 'done' WHERE id = ?", (row["id"],))
                if op in _OWNS_DRAFT and row["string_id"] is not None:
                    conn.execute(
                        "UPDATE translation_drafts SET dirty = 0 WHERE string_id = ? AND language_id = ?",
                        (row["string_id"], row["language_id"]),
                    )
                file_row = conn.execute(
                    "SELECT file_id FROM source_strings WHERE id = ?", (row["string_id"],)
                ).fetchone() if row["string_id"] is not None else None
            if file_row is not None:
                invalidate_progress_for_file(file_row["file_id"], row["language_id"])
            if op in _AFFECTS_TM and row["language_id"] is not None:
                invalidate_tm_lookups(row["language_id"])
            succeeded += 1

        except Exception as exc:  # noqa: BLE001 - outbox must never crash on a bad item
            # A validation-type error (e.g. Crowdin's "duplicate
            # translation" check) will never succeed no matter how many
            # times we retry it — mark it terminal instead of retrying
            # forever every drain cycle. A ValueError from a handler is
            # likewise unfixable by retrying.
            terminal = (isinstance(exc, APIException) and not exc.should_retry) or isinstance(exc, ValueError)
            logger.warning(
                "offline_queue item %s (%s) %s: %s",
                row["id"], op, "permanently failed" if terminal else "failed again", exc,
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
                if terminal and op in _OWNS_DRAFT and row["string_id"] is not None:
                    # Same reasoning as the direct-submit rejection path
                    # in main.py: a terminal failure will never sync as-is,
                    # so the draft must stop being treated as the user's
                    # authoritative pending edit, or it silently overrides
                    # the real current translation on every future visit.
                    conn.execute(
                        "UPDATE translation_drafts SET dirty = 0 WHERE string_id = ? AND language_id = ?",
                        (row["string_id"], row["language_id"]),
                    )

    return succeeded
