# Crowdin Mate

A fast, offline-tolerant desktop client for translating and proofreading on
[Crowdin](https://crowdin.com/).

It talks to Crowdin's REST API v2 directly and caches everything locally in
SQLite, so the file tree, string lists and search stay fast even on projects
with tens of thousands of files — and keep working, including queued edits,
with no network at all.

> **Not affiliated with or endorsed by Crowdin.** This is an independent
> third-party client built against Crowdin's public API, not Crowdin's own
> [editor app](https://github.com/crowdin/editor-app).

It's an editor, not a replacement for the web app: project setup, team
management and everything else under Crowdin's admin surface still happens on
crowdin.com. You only need access to a project you already translate or
proofread on.

## Features

- Browse the whole project tree instantly, cached locally
- Translate, approve, vote, and comment, synced back to Crowdin
- Deleted translations stay restorable, not just for a few seconds
- Translation memory and glossary suggestions
- Full-project search, with an offline fallback index
- Edits are saved locally first and retried if Crowdin can't be reached
- Multiple projects and target languages
- Comfortable and side-by-side views, light/dark theme

## Download

Grab the latest build from the [Releases page](../../releases).

- **Windows** — `Crowdin-Mate-Windows.zip`. Extract it, then run
  `Crowdin Mate.exe` from inside the folder, keeping the folder together.
  Uses the WebView2 runtime already included in Windows 10 21H2+/11.
- **Linux** — `Crowdin-Mate-Linux.tar.gz`. Extract it and run
  `"Crowdin Mate/Crowdin Mate"` (`chmod +x` it first if needed). Bundles its
  own Qt, so it works on any desktop environment.

The app then walks you through connecting your Crowdin account.

### Windows SmartScreen warning

Releases aren't code-signed, so Windows will say the publisher is unknown and
that the file isn't commonly downloaded. That's an identity and popularity
check, not a virus scan — it appears on every unsigned release.

To run it anyway: in Edge, open the downloads list, click **⋯** → **Keep** →
**Keep anyway**. On launch, click **More info** → **Run anyway**. If Windows
still blocks it, right-click the file → **Properties** → **Unblock**.

Every release is built by [GitHub Actions](.github/workflows/release.yml) from
the tagged source, and ships a `.sha256` file so you can check your download:

```powershell
Get-FileHash .\Crowdin-Mate-Windows.zip -Algorithm SHA256
```

If you'd rather not run an unsigned build, run from source instead.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Enter` | Save the current translation |
| `Ctrl+Shift+Enter` | Approve/unapprove the selected candidate |
| `Ctrl+↑` or `←` | Previous string |
| `Ctrl+↓` or `→` | Next string |
| `Ctrl+Shift+↑` or `←` | Previous open tab |
| `Ctrl+Shift+↓` or `→` | Next open tab |
| `Esc` | Stop editing |

Navigation shortcuts are ignored while you're typing, so they don't hijack
normal text editing. `Esc` gets you back out of a field.

## Connecting your account

Credentials are stored in your OS credential manager, never in a file. Pick
either method from the app's own connect screen:

- **Personal Access Token** — crowdin.com → avatar → Settings → API → New
  Token, pasted into the app. You renew it yourself when it expires.
- **OAuth** — crowdin.com → avatar → Settings → OAuth → New Application, with
  callback URL `http://localhost:8000/oauth/callback` and as many scopes as
  you can select. Paste the Client ID and Secret into the app once; tokens
  refresh automatically after that.

## Running from source

Requires Python 3.12+ and Node.js 20+.

Backend, from `server/`:

```bash
pip install -r requirements.txt
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

It binds to `127.0.0.1` only — it holds your Crowdin token and must not be
reachable from the network.

Frontend, from `frontend/`:

```bash
npm install
npm run dev
```

Then open `http://localhost:5173`, connect your account, pick a project, and
click the sync button next to the file search to cache it locally.

### As a desktop app

```bash
npm run build       # from frontend/
python desktop.py   # from server/
```

`desktop.py` serves the built frontend and opens it in a native window.
Rebuild the frontend after changing it — the packaged app serves the last
build, not live source.

To use your normal browser instead of the app window, either set
**Settings → Open in → Browser**, or pass `--browser`.

## Building a release

Both platforms use [`server/desktop.spec`](server/desktop.spec) via
[PyInstaller](https://pyinstaller.org/):

```bash
npm run build                       # from frontend/
pip install -r requirements.txt     # from server/
pip install pyinstaller
pyinstaller desktop.spec --noconfirm
```

The result is `server/dist/Crowdin Mate/`, containing the executable and
everything it needs.

## Architecture

- `server/` — FastAPI backend. Crowdin calls go through one rate-limited
  client and are cached in SQLite; the frontend reads the cache rather than
  hitting Crowdin live, apart from search and TM/glossary lookups, which have
  local fallbacks.
- `server/app/offline_queue.py` — durable outbox. Edits are saved locally
  before any network call and retried if the push fails.
- `frontend/` — React + TypeScript, with a virtualized file tree and string
  list.
- `server/desktop.py` + `desktop.spec` — packages both halves as a desktop
  app via pywebview and PyInstaller.

## License

[MIT](LICENSE).
