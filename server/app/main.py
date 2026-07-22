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
from app.sync.file_content_sync import sync_file_content, sync_string_comments
from app.sync.progress_sync import get_children_progress
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
        return {"is_member": False, "role": None}

    client = get_client()
    try:
        resp = await run_in_threadpool(
            call_with_limits, client.users.get_member_info,
            memberId=int(row["value"]), projectId=project_id,
        )
    except APIException as exc:
        if exc.http_status in (403, 404):
            return {"is_member": False, "role": None}
        raise HTTPException(status_code=exc.http_status or 500, detail=exc.message)

    member = resp.get("data", resp)
    return {"is_member": True, "role": member.get("role")}


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
        # All translations per string, approved first then newest — the
        # order a proofreader wants (canonical text on top, latest
        # candidates next).
        translations_by_string: dict[int, list] = {}
        for row in conn.execute(
            """
            SELECT t.string_id, t.id, t.text, t.user_name, t.rating,
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


@app.post("/projects/{project_id}/strings/{string_id}/comments")
async def add_string_comment(project_id: int, string_id: int, body: CommentIn):
    """Post a plain comment (not an issue) on a string. Re-syncs the
    string's comments afterward so the returned list includes the new one
    with its server-assigned id and timestamp."""
    from crowdin_api.api_resources.string_comments.enums import StringCommentType

    client = get_client()
    try:
        await run_in_threadpool(
            call_with_limits, client.string_comments.add_string_comment,
            text=body.text, stringId=string_id, targetLanguageId=body.language_id,
            type=StringCommentType.COMMENT, projectId=project_id,
        )
        comments = await run_in_threadpool(sync_string_comments, project_id, string_id)
    except APIException as exc:
        raise HTTPException(status_code=exc.http_status or 500, detail=exc.message)

    return {"status": "posted", "count": len(comments)}


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
