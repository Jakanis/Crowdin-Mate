# Crowdin Mate

*An abomination born from my local Crowdin REST proxy, built to fight
performance issues — with an offline mode bolted on top.*

A fast, offline-tolerant desktop client for translating and proofreading on
[Crowdin](https://crowdin.com/). I built this for my own use on the
[ClassicUA](https://crowdin.com/project/classicua) project after running into
real performance issues with Crowdin's own web editor there — it fits my
workflow well, and it works with any Crowdin project, so it might fit yours
too. It talks to Crowdin's official REST API v2 directly and caches
everything locally in SQLite, so the file tree, string lists, and search stay
fast, and keep working (read + queue edits) even with no network at all.

> **Not affiliated with or endorsed by Crowdin.** Crowdin Mate is an
> independent, third-party client built against Crowdin's public API. It is
> not Crowdin's own official desktop app (that's
> [`crowdin/editor-app`](https://github.com/crowdin/editor-app)).

## What this is (and isn't)

Crowdin Mate is a focused **translation and proofreading editor** — it's the
thing you open to actually translate strings, review/approve others' work,
search across a project, and check translation memory or glossary
suggestions, as fast and offline-tolerantly as possible.

It is **not** a replacement for Crowdin's own web app: project setup, team
management, integrations, vendor/workflow configuration, and anything else
under Crowdin's admin surface still happens on crowdin.com. Crowdin Mate only
needs a token with access to a project you're already a translator/proofreader
on.

## Features

- **Instant tree browsing** — the whole directory/file tree is crawled once
  and cached locally; a virtualized tree (TanStack Virtual) renders only
  what's on screen, so even a project with tens of thousands of files stays
  responsive.
- **Translate & proofread** — edit, save, approve/unapprove, vote, and delete
  translations, with per-string comments/issues, all synced back to Crowdin.
- **Nothing deleted is ever really gone** — every deletion lands in the
  "Deleted" sidebar tab, restorable any time (not just in the few seconds
  right after), matching Crowdin's own indefinitely-recoverable delete.
- **Translation memory & glossary suggestions** — inline, cached locally so
  revisiting a string is instant after the first lookup.
- **Search** — live full-project search via Crowdin's own query language,
  with a local full-text index as an offline fallback.
- **Offline-durable edits** — a translation is saved locally the instant you
  hit Save; if the live push to Crowdin fails (offline, rate-limited), it's
  queued and retried automatically, never silently lost.
- **Multi-project, multi-language** — switch between any project your token
  can see and any of its target languages from the header.
- **Cheap change detection** — a lightweight periodic check flags when a
  project has changed on Crowdin since your last sync, instead of either
  silently re-crawling everything or leaving you guessing.
- **Comfortable & side-by-side views**, resizable panels, light/dark theme,
  and an optional palette that matches Crowdin's own editor colors.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Enter` | Save the current translation |
| `Ctrl+Shift+Enter` | Approve/unapprove the selected candidate |
| `Ctrl+↑` or `←` | Previous string |
| `Ctrl+↓` or `→` | Next string |
| `Ctrl+Shift+↑` or `←` | Previous open tab |
| `Ctrl+Shift+↓` or `→` | Next open tab |
| `Esc` | Stop editing (blur the current field) |

String and tab navigation are both skipped while you're typing anywhere —
`Ctrl+←`/`→` is the standard "move cursor by word" shortcut while editing
text, so these don't hijack that. `Esc` is the way back out of a field to
use them again.

## For translators: just download it

No Python, no Node, nothing to install or run from a terminal — grab the
latest build from the [Releases page](../../releases) for your OS and
double-click it:

- **Windows** — `Crowdin-Mate-Windows.exe`. Uses Windows' own WebView2, which
  ships with Windows 10 21H2+/11 already, so there's genuinely nothing else
  to install.
- **Linux** — `Crowdin-Mate-Linux`. Mark it executable first
  (`chmod +x Crowdin-Mate-Linux`), then run it. Uses pywebview's Qt backend
  bundled with its own copy of Qt (not your system's GTK or Qt), so it works
  the same on GNOME, KDE, or anything else — it does still expect a handful
  of low-level system libraries (OpenGL, fontconfig, X11/XCB, NSS, ALSA — see
  the full list in [`release.yml`](.github/workflows/release.yml)) that are
  near-universal on any real desktop Linux install; only a bare/minimal or
  container-style setup would be missing them.

Either way, the app then walks you through connecting your own Crowdin
account (OAuth or a Personal Access Token, your choice — see "Prerequisites"
below) — nothing is pre-configured or shared between users, and no project is
hardcoded: pick any project your account has access to from the header.

### Windows may warn you about the download

You will most likely see **two different warnings**, from two separate
systems. Neither means malware was found in the file.

**1. "This file isn't commonly downloaded" / "Publisher: Unknown."** This is
SmartScreen, and it is a *popularity and identity* check, not a scan. Every
new release is a brand-new file that nobody has downloaded yet, and the
binary carries no code-signing certificate naming a publisher — so
SmartScreen has nothing to go on and says so. A brand-new file from a
well-known publisher would pass; ours fails on both counts. To open it
anyway:

- In Edge, the download will be held with a warning. Open the downloads
  list, click the **⋯** next to the file, choose **Keep**, then **Keep
  anyway** on the confirmation.
- On launching it, the blue "Windows protected your PC" dialog appears.
  Click **More info**, then **Run anyway**.
- If Windows keeps blocking it afterwards, right-click the file →
  **Properties** → tick **Unblock** at the bottom → **OK**.

This warning will keep appearing on every new release until the binary is
signed, and to a lesser extent until enough people have downloaded that
specific file.

**2. `Trojan:Win32/Wacatac.B!ml` from Windows Defender.** This one is a
malware verdict, so it deserves a real explanation rather than a shrug:

- **It is a heuristic, not a match against known malware.** The `!ml`
  suffix marks a machine-learning verdict. `Wacatac.B!ml` is a broad bucket
  that PyInstaller-built applications land in routinely, because the shape
  of the file is genuinely the shape antivirus heuristics are built to
  distrust: a single unsigned executable that unpacks a compressed payload
  into a temp directory at startup and runs a Python interpreter out of it.
  A legitimate app packaged this way and an actual dropper look similar from
  the outside.
- **We are not asking you to take that on faith.** Every release is built by
  [GitHub Actions](.github/workflows/release.yml) from the tagged source in
  this repository — you can read the workflow, read the source, and see the
  build log for the exact run that produced the file. Each binary ships with
  a `.sha256` file next to it, so you can confirm your download is
  byte-for-byte what that run produced:

  ```powershell
  Get-FileHash .\Crowdin-Mate-Windows.exe -Algorithm SHA256
  ```

  and compare it against `Crowdin-Mate-Windows.exe.sha256` from the same
  release.
- **What we cannot do yet:** the binary is unsigned. Code signing is what
  resolves the SmartScreen half outright and, as the signed publisher builds
  reputation, the Defender half too. Until then both warnings are expected
  on every release.
- **If you would rather not run an unsigned binary at all,** run from source
  instead — see "Running from source" below. It is the same code, with
  nothing packed, and neither warning applies.

If you have already downloaded it and want the detection reviewed, the file
can be submitted to Microsoft at
[microsoft.com/wdsi/filesubmission](https://www.microsoft.com/en-us/wdsi/filesubmission)
as a suspected false positive; they typically respond within a day or two,
and a cleared verdict propagates to everyone's Defender rather than just
yours.

## Prerequisites

- **Python 3.12+** and **Node.js 20+** (both installed) — only needed to run
  from source or build it yourself; skip this if you just downloaded a
  release binary above.
- **A way to authenticate with Crowdin** — pick either from the app's own
  "Connect your Crowdin account" screen once both servers are running;
  credentials are stored via your OS credential manager, never in a file in
  this repo. There's no shared/published OAuth app — each person registers
  their own if they choose that path, same as everyone already does for a
  PAT:
  - **OAuth** — one-time setup: crowdin.com → your avatar → Settings → OAuth →
    New Application, using callback URL `http://localhost:8000/oauth/callback`
    and as many scopes as you can select (projects, files, translations,
    comments, TM, glossaries). Paste the resulting Client ID/Secret into the
    app once; after that, "Connect with Crowdin" opens a normal browser
    login/authorization page and the backend's own `/oauth/callback` route
    catches the redirect. Access tokens auto-refresh (`server/app/oauth.py`)
    — no token to ever manually regenerate.
  - **Personal Access Token** — no app registration at all: crowdin.com →
    your avatar → Settings → API → New Token, pasted directly into the app.
    You're responsible for renewing it yourself once it expires.

## Running it

**Backend** (from `server/`):

```bash
pip install -r requirements.txt
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Binds to `127.0.0.1` only — it holds your Crowdin token and must never be
reachable from the network. Verify it's up: `curl http://127.0.0.1:8000/auth/status`
should return `{"configured":true}` once you've connected a token.

**Frontend** (from `frontend/`, once Node is installed):

```bash
npm install
npm run dev
```

Opens on `http://localhost:5173`. First run shows the token screen; after
connecting, pick a project from the header and click the sync button (next
to the file search box) once to crawl it into the local cache — subsequent
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

Prefer a regular browser tab over the native window — your own extensions,
devtools, multiple windows? Pass `--browser` (works the same way whether
you're running from source or a downloaded release binary, e.g.
`Crowdin-Mate-Windows.exe --browser` from a terminal or a shortcut with that
argument):

```bash
python desktop.py --browser
```

Same backend, same served frontend — this just skips creating the pywebview
window and opens your system default browser at it instead. The packaged
exe has no console, so there's nothing to watch it start; stop it like any
other local server (Task Manager, or Ctrl+C/closing the terminal if you
launched it from one).

`server/app/main.py` mounts `frontend/dist` as static files (registered
*after* every API route, so it never shadows them) whenever that directory
exists — absent in the normal dev workflow above, since Vite's own dev server
serves the frontend then. Same port (8000), same OAuth redirect_uri, same
SQLite cache under `~/.crowdin-mate` either way; only how it's launched
differs. Rebuild (`npm run build`) after any frontend change — `desktop.py`
serves whatever was last built, not live source.

The native window keeps its own browser profile under
`~/.crowdin-mate/webview` (`private_mode=False` + an explicit `storage_path`
— pywebview otherwise wipes it every run) — that's what makes open tabs,
the last-selected project/language, and panel widths still be there next
time you launch, not just within one running session.

## Building a release binary yourself

Both platforms use the same [`server/desktop.spec`](server/desktop.spec) via
[PyInstaller](https://pyinstaller.org/), producing one self-contained
executable with no separate Python/Node install required to *run* it (you
still need both to *build* it):

```bash
# 1. Build the frontend (from frontend/)
npm run build

# 2. Install backend deps + PyInstaller (from server/)
pip install -r requirements.txt
pip install pyinstaller

# 3. Build (from server/) — produces server/dist/Crowdin Mate(.exe)
pyinstaller desktop.spec --noconfirm
```

## Architecture

- `server/` — FastAPI backend. All Crowdin API calls go through one
  rate-limited wrapper (`crowdin_client.py`), and everything gets cached in a
  local SQLite database (`db.py` + `schema.sql`) that the frontend reads from
  instead of hitting Crowdin live, except for a few things that stay live by
  nature (search, TM/glossary lookups) with a local fallback for when they
  can't reach Crowdin.
- `server/app/offline_queue.py` — a durable outbox: a translation is saved
  locally before any network call, so an edit survives whether the live push
  succeeds, fails transiently (queued and retried automatically), or is
  permanently rejected.
- `frontend/` — React + TypeScript. The file tree and string list are both
  virtualized (TanStack Virtual) so even a project with tens of thousands of
  files stays responsive.
- `server/desktop.py` + `desktop.spec` — packages the same backend/frontend
  as a single native app window via `pywebview` + PyInstaller.

## License

[MIT](LICENSE).
