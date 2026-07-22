"""FastAPI backend for the ClassicUA desktop translation client.

Binds to 127.0.0.1 only (see run instructions in the README) — this holds
the Crowdin PAT and must never be reachable from the network.
"""

import logging
from concurrent.futures import ThreadPoolExecutor

from crowdin_api.exceptions import APIException
from fastapi import FastAPI, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from app import config
from app.crowdin_client import call_with_limits, get_client
from app.db import get_conn, init_db
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

_sync_executor = ThreadPoolExecutor(max_workers=1)


@app.on_event("startup")
def _startup() -> None:
    init_db()


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
