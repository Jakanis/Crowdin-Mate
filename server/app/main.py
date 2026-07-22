"""FastAPI backend for the ClassicUA desktop translation client.

Binds to 127.0.0.1 only (see run instructions in the README) — this holds
the Crowdin PAT and must never be reachable from the network.
"""

import asyncio
import logging
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
from app.sync.file_content_sync import sync_file_content
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


def _revalidate_file_content(project_id: int, file_id: int, language_id: str) -> None:
    try:
        sync_file_content(project_id, file_id, language_id)
    except APIException:
        logger.exception("Background revalidation failed for file %s", file_id)


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
                SELECT id, identifier, text, context, max_length, has_plurals, is_hidden
                FROM source_strings WHERE file_id = ? ORDER BY id
                """,
                (file_id,),
            )
        ]
        translations = {
            row["string_id"]: dict(row)
            for row in conn.execute(
                """
                SELECT t.string_id, t.id, t.text, t.user_name, t.created_at
                FROM translations t
                JOIN source_strings s ON s.id = t.string_id
                WHERE s.file_id = ? AND t.language_id = ?
                """,
                (file_id, language_id),
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
        s["translation"] = translations.get(s["id"])
        s["draft"] = drafts.get(s["id"])

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
    except APIException as exc:
        if exc.should_retry:
            # Transient (network/5xx/429-after-retries) — durable, will be
            # drained automatically once conditions recover.
            logger.warning("Live translation submit failed for string %s, queuing: %s", string_id, exc.message)
            await run_in_threadpool(
                offline_queue.enqueue_add_translation, project_id, string_id, body.language_id, body.text
            )
            return {"status": "queued", "reason": exc.message}

        # Permanent (validation errors, e.g. Crowdin's "duplicate
        # translation" check) — retrying won't ever help, so surface it
        # to the user immediately instead of silently queuing forever.
        logger.info("Translation submit rejected for string %s: %s", string_id, exc.message)
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
    import json

    try:
        payload = json.loads(exc.context)
        return payload["errors"][0]["error"]["errors"][0]["message"]
    except (ValueError, KeyError, IndexError, TypeError):
        return exc.message or "Rejected by Crowdin"
