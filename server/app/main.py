"""FastAPI backend for the ClassicUA desktop translation client.

Binds to 127.0.0.1 only (see run instructions in the README) — this holds
the Crowdin PAT and must never be reachable from the network.
"""

import asyncio
import json
import logging
import sqlite3
from datetime import datetime, timezone

from crowdin_api.exceptions import APIException
from fastapi import BackgroundTasks, FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app import config, offline_queue
from app.crowdin_client import call_with_limits, get_client
from app.db import get_conn, init_db
from app.sync.file_content_sync import sync_file_content, sync_string_comments
from app.sync.progress_sync import get_children_progress
from app.sync import search_index
from app.sync.suggestions_sync import has_looked_up, sync_glossary_matches, sync_tm_matches
from app.sync.tree_sync import sync_project_tree

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="ClassicUA Desktop Client API")

# Vite's default dev server origin. Tightened to a fixed allow-list rather
# than "*" since this backend holds a real credential.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(Exception)
async def _unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Starlette's default handling of a truly unhandled exception
    produces a 500 response OUTSIDE the CORS middleware, so the browser
    reports a generic "Failed to fetch" instead of the real error (this
    is how a genuine backend bug — a KeyError from an incorrect field
    name — surfaced during Phase 1 testing as a confusing network error
    even though the underlying Crowdin write had already succeeded).
    Registering a handler routes the response back through the normal
    middleware stack, including CORS, so future bugs show up as a real
    error message in the UI instead."""
    logger.exception("Unhandled exception on %s %s", request.method, request.url.path)
    return JSONResponse(status_code=500, content={"detail": f"{type(exc).__name__}: {exc}"})

_QUEUE_DRAIN_INTERVAL_SECONDS = 15
_drain_task: asyncio.Task | None = None


async def _drain_loop() -> None:
    while True:
        await asyncio.sleep(_QUEUE_DRAIN_INTERVAL_SECONDS)
        try:
            drained = await run_in_threadpool(offline_queue.drain_once)
            if drained:
                logger.info("Offline queue: drained %d item(s)", drained)
        except Exception:  # noqa: BLE001 - background loop must never die
            logger.exception("Offline queue drain failed")


@app.on_event("startup")
async def _startup() -> None:
    init_db()
    global _drain_task
    _drain_task = asyncio.create_task(_drain_loop())


@app.on_event("shutdown")
async def _shutdown() -> None:
    if _drain_task:
        _drain_task.cancel()


@app.get("/offline-queue")
async def get_offline_queue():
    """Everything not yet durably synced — 'pending' (will be retried
    automatically every _QUEUE_DRAIN_INTERVAL_SECONDS) and 'failed'
    (a permanent rejection, e.g. a duplicate-translation validation
    error, that drain_once will never retry on its own). Joined against
    source_strings/files purely so the panel can show something a
    person recognizes ("Torn Letter_216956.xml — 'Дякую...'") instead of
    a bare string id."""
    with get_conn() as conn:
        items = [
            dict(row) for row in conn.execute(
                """
                SELECT q.id, q.operation_type, q.string_id, q.language_id, q.created_at,
                       q.attempts, q.last_attempt_at, q.last_error, q.status,
                       s.text AS source_text, f.path AS file_path,
                       json_extract(q.payload_json, '$.text') AS draft_text
                FROM offline_queue q
                LEFT JOIN source_strings s ON s.id = q.string_id
                LEFT JOIN files f ON f.id = s.file_id
                WHERE q.status IN ('pending', 'failed')
                ORDER BY q.created_at
                """
            )
        ]
    return {"items": items}


@app.post("/offline-queue/drain")
async def trigger_offline_queue_drain():
    """Manual "retry now" — the background loop already retries every
    15s on its own, but a user who just reconnected shouldn't have to
    wait for it."""
    drained = await run_in_threadpool(offline_queue.drain_once)
    return {"drained": drained}


@app.post("/offline-queue/{item_id}/retry")
async def retry_offline_queue_item(item_id: int):
    """Resets one 'failed' (permanently-rejected) item back to 'pending'
    so the next drain attempts it again — for cases where the actual
    upstream condition has since changed (e.g. the conflicting duplicate
    translation was itself removed), not something the item's own retry
    logic could ever have detected on its own."""
    with get_conn() as conn:
        conn.execute("UPDATE offline_queue SET status = 'pending' WHERE id = ? AND status = 'failed'", (item_id,))
    drained = await run_in_threadpool(offline_queue.drain_once)
    return {"drained": drained}


@app.delete("/offline-queue/{item_id}")
async def delete_offline_queue_item(item_id: int):
    """Discards a queue item outright rather than retrying it — for the
    genuinely un-fixable case (e.g. Crowdin's "Duplicate translation.
    Please vote or approve the original." — retrying that forever can
    never succeed, since the fix is to vote/approve the existing one,
    not resubmit this one). Also clears the draft's dirty flag for the
    same reason the terminal-failure path in offline_queue.py does: an
    abandoned edit must stop being treated as the user's authoritative
    pending translation, or it keeps silently overriding the real
    current translation on every future visit to that string."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT string_id, language_id FROM offline_queue WHERE id = ?", (item_id,)
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="No such queue item")
        conn.execute("DELETE FROM offline_queue WHERE id = ?", (item_id,))
        conn.execute(
            "UPDATE translation_drafts SET dirty = 0 WHERE string_id = ? AND language_id = ?",
            (row["string_id"], row["language_id"]),
        )
    return {"ok": True}


class TokenIn(BaseModel):
    token: str


@app.post("/auth/token")
async def set_token(body: TokenIn):
    """Store the PAT and validate it in one step. The token value itself
    is never echoed back in the response."""
    config.set_token(body.token)
    try:
        client = get_client()
        user = await run_in_threadpool(call_with_limits, client.users.get_authenticated_user)
    except APIException as exc:
        config.clear_token()
        raise HTTPException(status_code=401, detail=f"Token rejected by Crowdin: {exc.message}")

    user_data = user.get("data", user)
    # Stashed for the permission check below — get_member_info(memberId=self)
    # needs our own numeric id, and there's no "who am I in this project"
    # endpoint that takes the token alone.
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO app_config (key, value) VALUES ('user_id', ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (str(user_data.get("id")),),
        )
    return {"ok": True, "username": user_data.get("username"), "name": user_data.get("fullName")}


@app.get("/auth/status")
async def auth_status():
    token = config.get_token()
    return {"configured": token is not None}


@app.delete("/auth/token")
async def delete_token():
    config.clear_token()
    return {"ok": True}


@app.get("/projects")
async def list_projects():
    client = get_client()
    try:
        resp = await run_in_threadpool(call_with_limits, client.projects.with_fetch_all().list_projects)
    except APIException as exc:
        raise HTTPException(status_code=exc.http_status or 500, detail=exc.message)

    projects = []
    for item in resp.get("data", []):
        p = item.get("data", item)
        projects.append({"id": p["id"], "name": p.get("name"), "identifier": p.get("identifier")})
    return {"projects": projects}


@app.post("/projects/{project_id}/sync-tree")
async def trigger_tree_sync(project_id: int):
    """Runs synchronously for now (Phase 0) — a project this size crawls
    in low tens of seconds via recursion=True, acceptable for an explicit
    user-triggered action. Will move to a background job + progress
    endpoint if that stops being true in practice."""
    try:
        result = await run_in_threadpool(sync_project_tree, project_id)
    except APIException as exc:
        raise HTTPException(status_code=exc.http_status or 500, detail=exc.message)
    return result


@app.get("/projects/{project_id}/tree")
async def get_tree(project_id: int):
    """Flat list of directories + files from the LOCAL cache only — never
    hits the Crowdin API. The frontend assembles/virtualizes the tree
    client-side from this flat shape."""
    with get_conn() as conn:
        directories = [
            dict(row) for row in conn.execute(
                "SELECT id, parent_id, name, path FROM directories WHERE project_id = ? ORDER BY path",
                (project_id,),
            )
        ]
        files = [
            dict(row) for row in conn.execute(
                "SELECT id, directory_id, name, path, strings_count FROM files WHERE project_id = ? ORDER BY path",
                (project_id,),
            )
        ]
    return {"directories": directories, "files": files}


@app.get("/projects/{project_id}/tree-progress")
async def get_tree_progress(project_id: int, language_id: str, parent_id: int | None = None):
    """Translation/approval progress for the direct children (both
    subdirectories and files) of `parent_id` — or the project root if
    omitted. Called once on initial tree load (root) and again every
    time a folder is expanded, mirroring exactly which rows the tree
    actually reveals at that moment. See progress_sync module docstring
    for why this can't just be one bulk call."""
    try:
        result = await run_in_threadpool(get_children_progress, project_id, parent_id, language_id)
    except APIException as exc:
        raise HTTPException(status_code=exc.http_status or 500, detail=exc.message)
    return result


@app.get("/projects/{project_id}/permissions")
async def get_permissions(project_id: int):
    """Whether the current account can approve translations in this
    project — gates the Approve/Unapprove buttons in the UI.

    There's no direct "can I approve" flag in Crowdin's API, and the
    obvious endpoint (list_project_members, searching for yourself)
    requires manager-level access — confirmed live, it 403s for a
    translator token. get_member_info scoped to a single already-known
    member id has no such restriction, so we look ourselves up by the id
    stashed at token-set time.

    Role name alone isn't a reliable signal either: on non-Enterprise
    Crowdin, a "translator" role commonly includes approve/vote rights
    (confirmed live — this account is "translator" and successfully
    approved a translation). So the real gate is just "are you actually a
    member of this project," not a specific role string.
    """
    with get_conn() as conn:
        row = conn.execute("SELECT value FROM app_config WHERE key = 'user_id'").fetchone()

    if row is None:
        return {"is_member": False, "role": None, "user_id": None}

    user_id = int(row["value"])
    client = get_client()
    try:
        resp = await run_in_threadpool(
            call_with_limits, client.users.get_member_info,
            memberId=user_id, projectId=project_id,
        )
    except APIException as exc:
        if exc.http_status in (403, 404):
            return {"is_member": False, "role": None, "user_id": user_id}
        raise HTTPException(status_code=exc.http_status or 500, detail=exc.message)

    member = resp.get("data", resp)
    return {"is_member": True, "role": member.get("role"), "user_id": user_id}


def _revalidate_file_content(project_id: int, file_id: int, language_id: str) -> None:
    try:
        sync_file_content(project_id, file_id, language_id)
    except APIException:
        logger.exception("Background revalidation failed for file %s", file_id)


@app.post("/projects/{project_id}/files/{file_id}/resync")
async def resync_file_content(project_id: int, file_id: int, language_id: str):
    """Explicit, synchronous re-fetch of one file's strings/translations —
    used when the tree sync's changed_file_ids flags this file as updated
    upstream and the user asks to reload it. Unlike the background
    revalidation in get_file_strings below, the caller needs to know the
    fresh content has actually landed before it refetches the strings
    query, not just that a background task was scheduled."""
    try:
        result = await run_in_threadpool(sync_file_content, project_id, file_id, language_id)
    except APIException as exc:
        raise HTTPException(status_code=exc.http_status or 500, detail=exc.message)
    return result


@app.get("/projects/{project_id}/search")
async def search_strings(project_id: int, q: str, language_id: str, limit: int = 50):
    """Full-text search over whatever's cached locally — instant, no
    Crowdin call. Coverage is only as wide as what's been synced (see
    strings_fts in schema.sql): opened files, plus anything pulled in by
    an explicit /search-index/build run. Query is treated as a literal
    phrase with a prefix match on the trailing word (quoting sidesteps
    FTS5's own query-syntax special characters), which reads sensibly
    for search-as-you-type."""
    q = q.strip()
    if not q:
        return {"results": []}

    fts_query = '"' + q.replace('"', '""') + '"*'
    with get_conn() as conn:
        try:
            rows = conn.execute(
                """
                SELECT
                    strings_fts.rowid AS string_id,
                    ss.file_id,
                    ss.identifier,
                    f.path AS file_path,
                    snippet(strings_fts, 1, '⟦', '⟧', '…', 12) AS source_snippet,
                    snippet(strings_fts, 2, '⟦', '⟧', '…', 12) AS target_snippet
                FROM strings_fts
                JOIN source_strings ss ON ss.id = strings_fts.rowid
                JOIN files f ON f.id = ss.file_id
                WHERE strings_fts MATCH ? AND ss.project_id = ?
                ORDER BY rank
                LIMIT ?
                """,
                (fts_query, project_id, limit),
            ).fetchall()
        except sqlite3.OperationalError as exc:
            raise HTTPException(status_code=400, detail=f"Bad search query: {exc}")

    return {"results": [dict(r) for r in rows]}


@app.post("/projects/{project_id}/search-index/build")
async def build_search_index(project_id: int, language_id: str):
    """Kicks off the (potentially hours-long) background job that syncs
    every not-yet-cached file's content so search covers the whole
    project, not just what's been opened. See search_index.py — safe to
    call repeatedly; a build already in progress is left alone."""
    started = search_index.start(project_id, language_id)
    return {"started": started, **search_index.get_status(project_id)}


@app.get("/projects/{project_id}/search-index/status")
async def get_search_index_status(project_id: int):
    return search_index.get_status(project_id)


@app.post("/projects/{project_id}/search-index/stop")
async def stop_search_index(project_id: int):
    search_index.request_stop()
    return search_index.get_status(project_id)


@app.get("/projects/{project_id}/files/{file_id}/strings")
async def get_file_strings(project_id: int, file_id: int, language_id: str, background_tasks: BackgroundTasks):
    """Reads from the local cache first — instant even for a large file —
    then revalidates in the background. On a file that's never been
    opened before (content_synced_at is null) we sync synchronously once,
    since there's nothing useful to show from an empty cache yet."""
    with get_conn() as conn:
        content_synced_at = conn.execute(
            "SELECT content_synced_at FROM files WHERE id = ?", (file_id,)
        ).fetchone()

    if content_synced_at is None or content_synced_at["content_synced_at"] is None:
        try:
            await run_in_threadpool(sync_file_content, project_id, file_id, language_id)
        except APIException as exc:
            raise HTTPException(status_code=exc.http_status or 500, detail=exc.message)
    else:
        background_tasks.add_task(_revalidate_file_content, project_id, file_id, language_id)

    with get_conn() as conn:
        strings = [
            dict(row) for row in conn.execute(
                """
                SELECT id, identifier, text, context, max_length, has_plurals, is_hidden, label_ids_json
                FROM source_strings WHERE file_id = ? ORDER BY id
                """,
                (file_id,),
            )
        ]
        label_titles = {
            row["id"]: row["title"] for row in conn.execute("SELECT id, title FROM labels WHERE project_id = ?", (project_id,))
        }
        # All translations per string, approved first then newest — the
        # order a proofreader wants (canonical text on top, latest
        # candidates next).
        translations_by_string: dict[int, list] = {}
        for row in conn.execute(
            """
            SELECT t.string_id, t.id, t.text, t.user_id, t.user_name, t.rating,
                   t.is_approved, t.approval_id, t.created_at
            FROM translations t
            JOIN source_strings s ON s.id = t.string_id
            WHERE s.file_id = ? AND t.language_id = ?
            ORDER BY t.is_approved DESC, t.created_at DESC
            """,
            (file_id, language_id),
        ):
            translations_by_string.setdefault(row["string_id"], []).append(dict(row))

        # Comment counts per string (from whatever's cached; the panel
        # fetches fresh on open). Lets the UI show a "has comments" hint
        # without a per-string call up front.
        comment_counts = {
            row["string_id"]: row["n"]
            for row in conn.execute(
                """
                SELECT c.string_id, COUNT(*) n
                FROM comments c
                JOIN source_strings s ON s.id = c.string_id
                WHERE s.file_id = ?
                GROUP BY c.string_id
                """,
                (file_id,),
            )
        }
        drafts = {
            row["string_id"]: dict(row)
            for row in conn.execute(
                """
                SELECT d.string_id, d.draft_text, d.dirty
                FROM translation_drafts d
                JOIN source_strings s ON s.id = d.string_id
                WHERE s.file_id = ? AND d.language_id = ?
                """,
                (file_id, language_id),
            )
        }

    for s in strings:
        s["translations"] = translations_by_string.get(s["id"], [])
        s["draft"] = drafts.get(s["id"])
        s["comment_count"] = comment_counts.get(s["id"], 0)
        label_ids = json.loads(s.pop("label_ids_json") or "[]")
        s["labels"] = [{"id": lid, "title": label_titles[lid]} for lid in label_ids if lid in label_titles]

    return {"strings": strings}


class TranslationIn(BaseModel):
    language_id: str
    text: str


@app.post("/projects/{project_id}/strings/{string_id}/translations")
async def submit_translation(project_id: int, string_id: int, body: TranslationIn):
    """Writes the draft to SQLite first (durable regardless of what
    happens next), then tries to push it to Crowdin immediately. On
    failure it's queued in `offline_queue` and drained later — the
    request still returns 200 with status "queued" rather than an error,
    since the user's edit is never lost either way."""
    now = datetime.now(timezone.utc).isoformat()
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO translation_drafts (string_id, language_id, draft_text, local_updated_at, dirty)
            VALUES (?, ?, ?, ?, 1)
            ON CONFLICT(string_id, language_id) DO UPDATE SET
                draft_text=excluded.draft_text,
                local_updated_at=excluded.local_updated_at,
                dirty=1
            """,
            (string_id, body.language_id, body.text, now),
        )

    client = get_client()
    try:
        resp = await run_in_threadpool(
            call_with_limits,
            client.string_translations.add_translation,
            projectId=project_id,
            stringId=string_id,
            languageId=body.language_id,
            text=body.text,
        )
    except Exception as exc:  # noqa: BLE001 - see the terminal-vs-queue split below
        # Genuine offline (no network at all) raises requests.ConnectionError/
        # Timeout, not an APIException — those aren't in Crowdin's exception
        # hierarchy at all, since they never got far enough to receive an
        # HTTP response to classify. Catching only APIException here (as an
        # earlier version of this code did) meant a translation typed while
        # offline never reached the queue - it just surfaced as a raw 500,
        # silently discarding the edit. Default to "queue it" for anything
        # that isn't a confirmed-permanent APIException, matching the same
        # terminal-vs-retry split drain_once already uses.
        terminal = isinstance(exc, APIException) and not exc.should_retry
        if not terminal:
            # Transient (network/offline/5xx/429-after-retries) — durable,
            # will be drained automatically once conditions recover.
            logger.warning("Live translation submit failed for string %s, queuing: %s", string_id, exc)
            await run_in_threadpool(
                offline_queue.enqueue_add_translation, project_id, string_id, body.language_id, body.text
            )
            return {"status": "queued", "reason": str(exc)}

        # Permanent (validation errors, e.g. Crowdin's "duplicate
        # translation" check) — retrying won't ever help, so surface it
        # to the user immediately instead of silently queuing forever.
        #
        # Clear dirty here too: this draft was written unconditionally at
        # the top of this function before the live call, and a rejection
        # means it will never successfully sync as-is. Leaving dirty=1
        # would make get_file_strings keep serving this dead-end text as
        # if it were the user's authoritative pending edit on every
        # future visit to this string, silently overriding whatever the
        # real current translation actually is — confirmed live, this is
        # exactly what happened to a draft from early testing that got
        # stuck this way for the rest of the session.
        logger.info("Translation submit rejected for string %s: %s", string_id, exc.message)
        with get_conn() as conn:
            conn.execute(
                "UPDATE translation_drafts SET dirty = 0 WHERE string_id = ? AND language_id = ?",
                (string_id, body.language_id),
            )
        return {"status": "rejected", "reason": _extract_validation_message(exc)}

    # add_translation's response shape uses `id` for the new translation
    # (confirmed live) — distinct from list_language_translations, which
    # uses `translationId` in its joined view. Different endpoints,
    # different serializers.
    t = resp.get("data", resp)
    user = t.get("user") or {}
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO translations (id, string_id, language_id, text, user_id, user_name, created_at, synced_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                text=excluded.text, user_id=excluded.user_id, user_name=excluded.user_name,
                created_at=excluded.created_at, synced_at=excluded.synced_at
            """,
            (
                t["id"],
                string_id,
                body.language_id,
                t.get("text", body.text),
                user.get("id"),
                user.get("fullName") or user.get("username"),
                t.get("createdAt").isoformat() if hasattr(t.get("createdAt"), "isoformat") else t.get("createdAt"),
                now,
            ),
        )
        conn.execute(
            "UPDATE translation_drafts SET dirty = 0 WHERE string_id = ? AND language_id = ?",
            (string_id, body.language_id),
        )

    return {
        "status": "synced",
        "translation": {
            "id": t["id"],
            "text": t.get("text", body.text),
            "user_name": user.get("fullName") or user.get("username"),
        },
    }


def _extract_validation_message(exc: APIException) -> str:
    """Crowdin's validation errors are nested JSON in `context`, not
    `exc.message` — pull out the human-readable bit if present."""
    try:
        payload = json.loads(exc.context)
        return payload["errors"][0]["error"]["errors"][0]["message"]
    except (ValueError, KeyError, IndexError, TypeError):
        return exc.message or "Rejected by Crowdin"


@app.post("/projects/{project_id}/translations/{translation_id}/approve")
async def approve_translation(project_id: int, translation_id: int):
    """Approve a translation and record the resulting approval id locally
    (needed to un-approve it later). Approving is idempotent-ish on
    Crowdin's side but we just reflect whatever it returns."""
    client = get_client()
    try:
        resp = await run_in_threadpool(
            call_with_limits, client.string_translations.add_approval,
            translationId=translation_id, projectId=project_id,
        )
    except APIException as exc:
        raise HTTPException(status_code=exc.http_status or 500, detail=exc.message)

    approval = resp.get("data", resp)
    with get_conn() as conn:
        conn.execute(
            "UPDATE translations SET is_approved = 1, approval_id = ? WHERE id = ?",
            (approval["id"], translation_id),
        )
    return {"status": "approved", "approval_id": approval["id"]}


@app.delete("/projects/{project_id}/translations/{translation_id}/approve")
async def unapprove_translation(project_id: int, translation_id: int):
    """Remove an approval. Crowdin's remove endpoint is keyed by the
    approval id, not the translation id, so we look up the one we stored."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT approval_id FROM translations WHERE id = ?", (translation_id,)
        ).fetchone()

    if row is None or row["approval_id"] is None:
        raise HTTPException(status_code=404, detail="No stored approval for this translation")

    client = get_client()
    try:
        await run_in_threadpool(
            call_with_limits, client.string_translations.remove_approval,
            approvalId=row["approval_id"], projectId=project_id,
        )
    except APIException as exc:
        raise HTTPException(status_code=exc.http_status or 500, detail=exc.message)

    with get_conn() as conn:
        conn.execute(
            "UPDATE translations SET is_approved = 0, approval_id = NULL WHERE id = ?",
            (translation_id,),
        )
    return {"status": "unapproved"}


@app.delete("/projects/{project_id}/translations/{translation_id}")
async def delete_translation_endpoint(project_id: int, translation_id: int):
    """Own translations are always deletable; the frontend gates the
    button itself for other people's (moderator/canApprove only) — same
    split Crowdin's own editor uses, since "translator" role commonly
    includes moderation rights on non-Enterprise projects (see the
    get_permissions docstring above)."""
    client = get_client()
    try:
        await run_in_threadpool(
            call_with_limits, client.string_translations.delete_translation,
            translationId=translation_id, projectId=project_id,
        )
    except APIException as exc:
        raise HTTPException(status_code=exc.http_status or 500, detail=exc.message)

    with get_conn() as conn:
        conn.execute("DELETE FROM translations WHERE id = ?", (translation_id,))
    return {"status": "deleted"}


class VoteIn(BaseModel):
    mark: str  # "up" | "down"


@app.post("/projects/{project_id}/translations/{translation_id}/vote")
async def vote_translation(project_id: int, translation_id: int, body: VoteIn):
    from crowdin_api.api_resources.string_translations.enums import VoteMark

    client = get_client()
    try:
        await run_in_threadpool(
            call_with_limits, client.string_translations.add_vote,
            mark=VoteMark.UP if body.mark == "up" else VoteMark.DOWN,
            translationId=translation_id, projectId=project_id,
        )
    except APIException as exc:
        raise HTTPException(status_code=exc.http_status or 500, detail=exc.message)

    # add_vote's response is just the vote record, not the translation's
    # aggregate tally — recompute rating from the authoritative vote list
    # rather than guessing +1/-1 locally, so it can never drift from what
    # Crowdin actually has (e.g. if the user had a prior opposite vote
    # that this call implicitly replaced).
    try:
        votes_resp = await run_in_threadpool(
            call_with_limits, client.string_translations.with_fetch_all().list_translation_votes,
            translationId=translation_id, projectId=project_id,
        )
    except APIException as exc:
        raise HTTPException(status_code=exc.http_status or 500, detail=exc.message)

    votes = [v.get("data", v) for v in votes_resp.get("data", [])]
    rating = sum(1 if v.get("mark") == "up" else -1 for v in votes)
    with get_conn() as conn:
        conn.execute("UPDATE translations SET rating = ? WHERE id = ?", (rating, translation_id))
    return {"status": "voted", "rating": rating}


@app.get("/projects/{project_id}/strings/{string_id}/comments")
async def get_string_comments(project_id: int, string_id: int):
    """Fetches fresh from Crowdin (comments are the least cache-critical
    data and change independently of translations), caches, and returns."""
    try:
        await run_in_threadpool(sync_string_comments, project_id, string_id)
    except APIException as exc:
        raise HTTPException(status_code=exc.http_status or 500, detail=exc.message)

    with get_conn() as conn:
        comments = [
            dict(row) for row in conn.execute(
                """
                SELECT id, text, user_name, type, issue_type, issue_status,
                       is_resolved, created_at
                FROM comments WHERE string_id = ? ORDER BY created_at
                """,
                (string_id,),
            )
        ]
    return {"comments": comments}


class CommentIn(BaseModel):
    text: str
    language_id: str
    # None -> plain comment. Otherwise one of Crowdin's issue types
    # (general_question/translation_mistake/context_request/source_mistake)
    # and the comment posts as an issue instead.
    issue_type: str | None = None


@app.post("/projects/{project_id}/strings/{string_id}/comments")
async def add_string_comment(project_id: int, string_id: int, body: CommentIn):
    """Post a comment, or an issue if issue_type is set. Re-syncs the
    string's comments afterward so the returned list includes the new one
    with its server-assigned id and timestamp."""
    from crowdin_api.api_resources.string_comments.enums import StringCommentIssueType, StringCommentType

    client = get_client()
    kwargs: dict = dict(
        text=body.text, stringId=string_id, targetLanguageId=body.language_id, projectId=project_id,
    )
    if body.issue_type:
        kwargs["type"] = StringCommentType.ISSUE
        kwargs["issueType"] = StringCommentIssueType(body.issue_type)
    else:
        kwargs["type"] = StringCommentType.COMMENT

    try:
        await run_in_threadpool(call_with_limits, client.string_comments.add_string_comment, **kwargs)
        comments = await run_in_threadpool(sync_string_comments, project_id, string_id)
    except APIException as exc:
        raise HTTPException(status_code=exc.http_status or 500, detail=exc.message)

    return {"status": "posted", "count": len(comments)}


async def _set_comment_issue_status(project_id: int, string_id: int, comment_id: int, resolved: bool) -> None:
    from crowdin_api.api_resources.enums import PatchOperation
    from crowdin_api.api_resources.string_comments.enums import StringCommentIssueStatus, StringCommentPatchPath

    client = get_client()
    try:
        await run_in_threadpool(
            call_with_limits, client.string_comments.edit_string_comment,
            stringCommentId=comment_id, projectId=project_id,
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
        await run_in_threadpool(sync_string_comments, project_id, string_id)
    except APIException as exc:
        raise HTTPException(status_code=exc.http_status or 500, detail=exc.message)


@app.post("/projects/{project_id}/strings/{string_id}/comments/{comment_id}/resolve")
async def resolve_comment(project_id: int, string_id: int, comment_id: int):
    await _set_comment_issue_status(project_id, string_id, comment_id, resolved=True)
    return {"status": "resolved"}


@app.delete("/projects/{project_id}/strings/{string_id}/comments/{comment_id}/resolve")
async def unresolve_comment(project_id: int, string_id: int, comment_id: int):
    await _set_comment_issue_status(project_id, string_id, comment_id, resolved=False)
    return {"status": "unresolved"}


def _get_source_text_and_language(project_id: int, string_id: int) -> tuple[str, str]:
    with get_conn() as conn:
        string_row = conn.execute(
            "SELECT text FROM source_strings WHERE id = ?", (string_id,)
        ).fetchone()
        project_row = conn.execute(
            "SELECT source_language FROM projects WHERE id = ?", (project_id,)
        ).fetchone()

    if string_row is None:
        raise HTTPException(status_code=404, detail="Unknown string")
    return string_row["text"], (project_row["source_language"] if project_row else "en")


@app.get("/projects/{project_id}/strings/{string_id}/tm-matches")
async def get_tm_matches(project_id: int, string_id: int, language_id: str):
    """Cached indefinitely once fetched — a TM match for a given source
    text doesn't change on its own the way comments or translations do,
    so there's no background revalidation here, only an explicit re-fetch
    if it's never been looked up before."""
    if not has_looked_up(string_id, language_id, "tm"):
        source_text, source_lang = _get_source_text_and_language(project_id, string_id)
        try:
            await run_in_threadpool(sync_tm_matches, project_id, string_id, source_text, source_lang, language_id)
        except APIException as exc:
            raise HTTPException(status_code=exc.http_status or 500, detail=exc.message)

    with get_conn() as conn:
        matches = [
            dict(row) for row in conn.execute(
                """
                SELECT source_text, target_text, relevant, tm_name
                FROM tm_matches WHERE string_id = ? AND language_id = ?
                ORDER BY relevant DESC
                """,
                (string_id, language_id),
            )
        ]
    return {"matches": matches}


@app.get("/projects/{project_id}/strings/{string_id}/glossary-matches")
async def get_glossary_matches(project_id: int, string_id: int, language_id: str):
    """Same caching approach as TM matches — see docstring above."""
    if not has_looked_up(string_id, language_id, "glossary"):
        source_text, source_lang = _get_source_text_and_language(project_id, string_id)
        try:
            await run_in_threadpool(
                sync_glossary_matches, project_id, string_id, source_text, source_lang, language_id
            )
        except APIException as exc:
            raise HTTPException(status_code=exc.http_status or 500, detail=exc.message)

    with get_conn() as conn:
        matches = [
            dict(row) for row in conn.execute(
                """
                SELECT source_term, target_term, description, glossary_name
                FROM glossary_matches WHERE string_id = ? AND language_id = ?
                ORDER BY source_term
                """,
                (string_id, language_id),
            )
        ]
    return {"matches": matches}
