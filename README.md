# ClassicUA Desktop Translation Client

A custom Crowdin client for the [ClassicUA](https://crowdin.com/project/classicua) project,
built after profiling crowdin.com's own editor and finding it blocks the browser's main
thread for up to 16 seconds per file switch (see project history / `sequential-tinkering-sphinx`
plan for the full writeup). This client talks to Crowdin's official REST API v2 directly and
caches everything locally in SQLite, so the file tree and string lists stay instant regardless
of project size.

Current status: **Phase 0 + Phase 1 done**, verified live against the real project — token
setup, virtualized tree browsing from local cache, and reading/editing/saving translations
for a file, confirmed round-tripping correctly to crowdin.com's own editor.

## Prerequisites

- **Python 3.12+** and **Node.js 20+** (both installed).
- **A way to authenticate with Crowdin** — pick either from the app's own "Connect your
  Crowdin account" screen once both servers are running; credentials are stored via your OS
  credential manager (Windows Credential Manager here), never in a file in this repo. There's
  no shared/published OAuth app — each person registers their own if they choose that path,
  same as everyone already does for a PAT:
  - **OAuth** — one-time setup: crowdin.com → your avatar → Settings → OAuth → New
    Application, using callback URL `http://localhost:8000/oauth/callback` and as many scopes
    as you can select (projects, files, translations, comments, TM, glossaries). Paste the
    resulting Client ID/Secret into the app once; after that, "Connect with Crowdin" opens a
    normal browser login/authorization page and the backend's own `/oauth/callback` route
    catches the redirect. Access tokens auto-refresh (`server/app/oauth.py`) — no token to
    ever manually regenerate.
  - **Personal Access Token** — no app registration at all: crowdin.com → your avatar →
    Settings → API → New Token, pasted directly into the app. You're responsible for renewing
    it yourself once it expires.

## Running it

**Backend** (from `server/`):

```bash
pip install -r requirements.txt
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Binds to `127.0.0.1` only — it holds your Crowdin token and must never be reachable from the
network. Verify it's up: `curl http://127.0.0.1:8000/auth/status` should return
`{"configured":true}` once you've connected a token.

**Don't use `--reload` on Windows.** It spawns the actual worker as a detached
`multiprocessing` child process, and killing the parent PID (Ctrl+C, `taskkill`, Task
Manager) leaves that child running and still bound to the port — you end up with orphaned
servers silently answering requests with stale code. If you need to restart after a code
change, stop it and confirm the port is actually free before starting again:

```bash
# PowerShell — find what's really listening before assuming a Ctrl+C worked
Get-NetTCPConnection -LocalPort 8000 -State Listen | Select-Object OwningProcess
Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%multiprocessing%'"  # catches orphaned reload children
```

**Frontend** (from `frontend/`, once Node is installed):

```bash
npm install
npm run dev
```

Opens on `http://localhost:5173`. First run shows the token screen; after connecting, click
"Sync tree" once to crawl the ClassicUA project (393919) into the local cache — subsequent
loads read from SQLite instantly.

## Desktop app (packaged)

Runs as a real native window instead of two dev servers + a browser tab:

```bash
# from frontend/ — builds the production bundle to frontend/dist
npm run build

# from server/ — spawns the backend in a background thread, opens frontend/dist
# in a pywebview window pointed at it
python desktop.py
```

`server/app/main.py` mounts `frontend/dist` as static files (registered *after* every API
route, so it never shadows them) whenever that directory exists — absent in the normal dev
workflow above, since Vite's own dev server serves the frontend then. Same port (8000), same
OAuth redirect_uri, same SQLite cache under `~/.classicua-client` either way; only how it's
launched differs. Rebuild (`npm run build`) after any frontend change — `desktop.py` serves
whatever was last built, not live source.

## For translators: just download it

No Python, no Node, nothing to install or run from a terminal — grab the latest build from
the [Releases page](../../releases) for your OS and double-click it:

- **Windows** — `ClassicUA-Translation-Client-Windows.exe`. Uses Windows' own WebView2, which
  ships with Windows 10 21H2+/11 already, so there's genuinely nothing else to install.
- **Linux** — `ClassicUA-Translation-Client-Linux`. Mark it executable first
  (`chmod +x ClassicUA-Translation-Client-Linux`), then run it. Uses pywebview's Qt backend
  bundled with its own copy of Qt (not your system's GTK or Qt), so it works the same on
  GNOME, KDE, or anything else — it does still expect a handful of low-level system libraries
  (OpenGL, fontconfig, X11/XCB, NSS, ALSA — see the full list in
  [`release.yml`](.github/workflows/release.yml)) that are near-universal on any real desktop
  Linux install; only a bare/minimal or container-style setup would be missing them.

Either way, the app then walks you through connecting your own Crowdin account (OAuth or a
Personal Access Token, your choice — see "Prerequisites" above) — nothing is pre-configured
or shared between users.

## Building a release binary yourself

Both platforms use the same [`server/desktop.spec`](server/desktop.spec) via
[PyInstaller](https://pyinstaller.org/), producing one self-contained executable with no
separate Python/Node install required to *run* it (you still need both to *build* it):

```bash
# 1. Build the frontend (from frontend/)
npm run build

# 2. Install backend deps + PyInstaller (from server/)
pip install -r requirements.txt
pip install pyinstaller

# 3. Build (from server/) — produces server/dist/ClassicUA Translation Client(.exe)
pyinstaller desktop.spec --noconfirm
```

PyInstaller doesn't cross-compile — building the Linux binary means actually running this on
Linux (a real machine, a VM, or WSL2 with WSLg if you want to see the window while testing).
[`.github/workflows/release.yml`](.github/workflows/release.yml) does exactly this in CI for
both platforms and attaches the results to a GitHub Release whenever a tag matching `v*` is
pushed (e.g. `git tag v0.1.0 && git push --tags`) — that's the normal way to cut a release,
rather than building locally.

Windows and Linux differ only in which web-rendering backend pywebview uses (see
`desktop.py`'s own docstring): Windows uses the OS's built-in WebView2, Linux uses pywebview's
Qt backend (`PyQt5` + `PyQtWebEngine`, both platform-conditional in `requirements.txt`)
instead of its GTK default — GTK/WebKit2GTK are tied to GNOME's stack and aren't things a
KDE/Qt user should need to install just for this one app, whereas the Qt backend's wheels
bundle their own copy of Qt and need no system toolkit installed at all, GNOME included.

## Architecture

See `.claude/plans` in this session, or ask for a recap — short version:

- `server/app/crowdin_client.py` — all Crowdin API calls go through one rate-limited wrapper
  (concurrency cap + sustained req/s cap + explicit 429 backoff, since the SDK itself doesn't
  retry throttled requests — verified by reading its source).
- `server/app/sync/tree_sync.py` — crawls the whole directory/file tree in one paginated,
  recursive pass and upserts it into SQLite. Safe to re-run any time.
- `server/app/sync/file_content_sync.py` — per-file lazy fetch of source strings +
  translations, on demand when a file is opened. Never bulk-fetched.
- `server/app/offline_queue.py` — durable outbox for translation submissions. A draft is
  written to SQLite before any network call, so an edit survives regardless of whether the
  live push to Crowdin succeeds, fails transiently (queued, retried automatically), or is
  permanently rejected (surfaced to the user immediately, e.g. Crowdin's "duplicate
  translation" check — see the Phase 1 commit for the real bug this caught).
- `server/app/db.py` + `server/app/schema.sql` — the local cache. The frontend's tree view
  reads *only* from here, never live from Crowdin.
- `frontend/src/components/FileTree.tsx` — virtualized (TanStack Virtual) tree rendering.
  This is the direct fix for the profiled bug: collapsed folders contribute exactly one row
  to the DOM regardless of how many thousands of files they contain.
- `frontend/src/components/StringList.tsx` — virtualized source/translation editor per file,
  with a per-row status badge (Saving / Synced / Queued / Rejected / Failed).

## What's next (Phase 2)

TM suggestions, glossary term highlighting, and MT suggestions, cached locally so revisiting
a string is instant even though the first lookup is as slow as Crowdin's own editor (1-6s).
See the plan for the full phased roadmap (comments/QA/approvals in Phase 3, search/offline
polish in Phase 4).
