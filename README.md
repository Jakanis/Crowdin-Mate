# ClassicUA Desktop Translation Client

A custom Crowdin client for the [ClassicUA](https://crowdin.com/project/classicua) project,
built after profiling crowdin.com's own editor and finding it blocks the browser's main
thread for up to 16 seconds per file switch (see project history / `sequential-tinkering-sphinx`
plan for the full writeup). This client talks to Crowdin's official REST API v2 directly and
caches everything locally in SQLite, so the file tree and string lists stay instant regardless
of project size.

Current status: **Phase 0** — token setup, project tree crawl, virtualized tree browsing from
local cache. String editing (Phase 1) is not built yet.

## Prerequisites

- **Python 3.12+** (already set up in this environment).
- **Node.js 20+** — **not yet installed on this machine.** Install it from
  [nodejs.org](https://nodejs.org/) (LTS) before running the frontend. Everything under
  `frontend/` is written and ready, but hasn't been run or built here — verify it once Node
  is installed.
- **A Crowdin Personal Access Token** — create one at crowdin.com → your avatar → Settings →
  API → **New Token**. You'll paste it directly into the app's own "Connect your Crowdin
  account" screen once both servers are running; it's stored via your OS credential manager
  (Windows Credential Manager here), never in a file in this repo.

## Running it

**Backend** (from `server/`):

```bash
pip install -r requirements.txt
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

Binds to `127.0.0.1` only — it holds your Crowdin token and must never be reachable from the
network. Verify it's up: `curl http://127.0.0.1:8000/auth/status` should return
`{"configured":false}` on first run.

**Frontend** (from `frontend/`, once Node is installed):

```bash
npm install
npm run dev
```

Opens on `http://localhost:5173`. First run shows the token screen; after connecting, click
"Sync tree" once to crawl the ClassicUA project (393919) into the local cache — subsequent
loads read from SQLite instantly.

## Architecture

See `.claude/plans` in this session, or ask for a recap — short version:

- `server/app/crowdin_client.py` — all Crowdin API calls go through one rate-limited wrapper
  (concurrency cap + sustained req/s cap + explicit 429 backoff, since the SDK itself doesn't
  retry throttled requests — verified by reading its source).
- `server/app/sync/tree_sync.py` — crawls the whole directory/file tree in one paginated,
  recursive pass and upserts it into SQLite. Safe to re-run any time.
- `server/app/db.py` + `server/app/schema.sql` — the local cache. The frontend's tree view
  reads *only* from here, never live from Crowdin.
- `frontend/src/components/FileTree.tsx` — virtualized (TanStack Virtual) tree rendering.
  This is the direct fix for the profiled bug: collapsed folders contribute exactly one row
  to the DOM regardless of how many thousands of files they contain.

## What's next (Phase 1)

Read/write translations for a single file: paginated string + translation fetch, an editable
row list, submit-back-to-Crowdin with an offline queue for reliability. See the plan for the
full phased roadmap (TM/glossary/MT suggestions in Phase 2, comments/QA/approvals in Phase 3,
search/offline polish in Phase 4).
