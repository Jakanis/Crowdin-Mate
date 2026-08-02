"""Desktop entrypoint: runs the FastAPI backend in a background thread
and opens it in a native window via pywebview, instead of a browser tab
— pass --browser to get a plain browser tab instead (see BROWSER_MODE).

Requires the frontend to already be built (`npm run build` in
frontend/, producing frontend/dist) — main.py mounts that directory as
static files when it's present. See README's "Desktop app" section.

The backend is otherwise unchanged from dev mode: same OAuth
redirect_uri (http://localhost:8000/oauth/callback), same SQLite cache
under ~/.crowdin-mate. Only how it's launched differs — and, since a
fixed port, differs in one more way: see _pick_port below.
"""

import logging
import os
import socket
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

import uvicorn


def _unblock_bundled_dotnet_assemblies() -> None:
    """Strip Mark of the Web from our own bundled .NET assemblies.

    Windows tags downloaded files with a Zone.Identifier stream, and
    extracting a zip in Explorer copies that tag onto every extracted file.
    The .NET Framework then refuses to load a tagged assembly — so
    pywebview's WinForms backend dies on `import clr` with:

        RuntimeError: Failed to resolve Python.Runtime.Loader.Initialize
        from ...\\_internal\\pythonnet\\runtime\\Python.Runtime.dll

    Reported by a user on v0.4.1 and reproduced here by tagging a local
    build's files with ZoneId=3. It doesn't happen when running from source
    or from a build you made yourself, which is exactly why it shipped.

    Scope is our own bundle directory, only on Windows, only when frozen.
    Every .dll in it, not a hand-picked list: a first attempt limited to
    pythonnet/runtime got past the error above and straight into the same
    failure on webview/lib/Microsoft.Web.WebView2.Core.dll. Whichever
    assemblies pywebview reaches for is its business, not something worth
    tracking here, so the whole bundle is cleared in one pass.

    Only .dll files. Ordinary Python extension modules load through
    LoadLibrary, which ignores this tag entirely — .NET assembly loading is
    the only thing that consults it — and leaving the executable's own mark
    alone matters: that one is SmartScreen's business, not ours.

    This isn't defeating a security control: nothing runs that the user
    hasn't already chosen to run — they had to get past SmartScreen to
    launch this executable at all — and it only ever touches files that
    shipped inside this application's own directory. An installer would
    have the same effect by writing files that were never tagged.

    Best-effort throughout. A read-only install directory, or a build with
    no .NET in it, just means there's nothing to do here.
    """
    if sys.platform != "win32" or not getattr(sys, "frozen", False):
        return
    bundle_dir = Path(getattr(sys, "_MEIPASS", "") or Path(sys.executable).parent)
    if not bundle_dir.is_dir():
        return
    for dll in bundle_dir.rglob("*.dll"):
        try:
            os.remove(f"{dll}:Zone.Identifier")
        except OSError:
            # Not tagged (the normal case), or not ours to change.
            pass


# Has to run before pywebview is imported: importing it pulls in clr, which
# is what actually fails on a tagged assembly.
_unblock_bundled_dotnet_assemblies()

import webview  # noqa: E402

from app.config import DATA_DIR  # noqa: E402
from app.main import app  # noqa: E402

HOST = "127.0.0.1"
PREFERRED_PORT = 8000
STARTUP_TIMEOUT_SECONDS = 15

# Some people would rather have this in a regular browser tab — their
# own extensions/devtools, multiple windows, whatever — than the native
# window. No separate build for that: same exe, same server, just skip
# creating the webview window and open the system browser instead. The
# packaged exe has no console (see desktop.spec), so this only really
# announces itself via the browser tab that opens; stop it the same way
# you'd stop any other local server (Task Manager, or Ctrl+C / closing
# the terminal if launched from one).
BROWSER_MODE = "--browser" in sys.argv

logger = logging.getLogger(__name__)

# `sys.frozen` is set by PyInstaller (and other freezers) on the packaged
# build, never when running from source. The packaged exe is windowed (no
# console — see the PyInstaller spec), so a startup crash would otherwise
# be completely silent and unreportable; logging to a file here is the
# packaged build's only real diagnostic trail. Dev-mode keeps logging to
# its actual terminal instead, unchanged.
FROZEN = getattr(sys, "frozen", False)
if FROZEN:
    log_path = DATA_DIR / "desktop.log"
    logging.basicConfig(
        filename=log_path,
        level=logging.WARNING,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )


def _pick_port(preferred: int) -> int:
    """Prefer the well-known fixed port — oauth.py's REDIRECT_URI, and
    whatever the user registered as their OAuth app's callback URL on
    crowdin.com, are both hardcoded to it — but fall back to an
    OS-assigned free port if something else already holds it, rather
    than trusting it's free and finding out later the hard way.

    Confirmed live: the previous version always used the fixed port and
    only checked readiness via an HTTP request, not an actual bind. A
    leftover process already listening there (e.g. a dev-mode backend
    left running from a previous session) made that check succeed
    against the WRONG server — this app's own window then loaded
    whatever THAT process served (or didn't), with nothing to indicate
    it wasn't talking to itself. Binding here first means "success"
    only ever means our own process actually holds the port.

    Deliberately no SO_REUSEADDR on this probe socket — on Windows it
    can let a bind succeed even while another process is genuinely
    still listening on that port (unlike its TIME_WAIT-only behavior
    on Linux/macOS), which would silently defeat this exact check."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind((HOST, preferred))
        except OSError:
            sock.bind((HOST, 0))
        return sock.getsockname()[1]


def _run_server(port: int) -> None:
    # warning, not info — nobody's watching a console for this (never true
    # even in dev-mode strictly, but doubly so once packaged/windowed);
    # only real problems are worth surfacing at all.
    uvicorn.run(app, host=HOST, port=port, log_level="warning")


def _wait_until_ready(port: int, timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    url = f"http://{HOST}:{port}/auth/status"
    while time.monotonic() < deadline:
        try:
            urllib.request.urlopen(url, timeout=0.5)
            return True
        except Exception:
            time.sleep(0.2)
    return False


def main() -> None:
    port = _pick_port(PREFERRED_PORT)
    if port != PREFERRED_PORT:
        logger.warning(
            "Port %s was unavailable, using %s instead. A Personal Access "
            "Token still works normally, and an already-connected OAuth "
            "session keeps refreshing fine either way — but starting a "
            "brand-new OAuth connection won't work this session, since "
            "its callback URL is fixed to port %s.",
            PREFERRED_PORT, port, PREFERRED_PORT,
        )

    server_thread = threading.Thread(target=_run_server, args=(port,), daemon=True)
    server_thread.start()

    if not _wait_until_ready(port, STARTUP_TIMEOUT_SECONDS):
        logger.error("Backend didn't come up within %ss — opening the window anyway.", STARTUP_TIMEOUT_SECONDS)

    url = f"http://{HOST}:{port}"

    if BROWSER_MODE:
        # No native window at all — open the system default browser at
        # the running backend, then just block forever so the process
        # (and the daemon server thread with it) doesn't exit the moment
        # main() would otherwise return.
        webbrowser.open(url)
        server_thread.join()
        return

    webview.create_window(
        "Crowdin Mate",
        url,
        width=1360,
        height=880,
        min_size=(960, 640),
    )
    # Windows/macOS: leave the gui unspecified so pywebview picks its native
    # backend (WebView2 on Windows, already part of Windows 10 21H2+/11 —
    # genuinely zero extra install for almost everyone).
    #
    # Linux has no equivalent OS-provided web renderer, and pywebview's
    # default there is the GTK backend (webkit2gtk + PyGObject), which are
    # system packages tied to GNOME's stack — fine on a GNOME desktop, but
    # asking a KDE/Qt user to pull in GTK+WebKit2GTK just to run this one
    # app is exactly the kind of cross-toolkit friction worth avoiding.
    # Forcing the Qt backend instead (PyQt5 + PyQtWebEngine, see
    # requirements.txt) sidesteps that entirely: those wheels bundle their
    # own copy of Qt's shared libraries, so the packaged Linux binary needs
    # no system GTK *or* Qt pre-installed — same "just run it" experience
    # regardless of desktop environment.
    # pywebview defaults to private_mode=True — nothing the window itself
    # stores (localStorage, cookies) survives past this process exiting,
    # regardless of what the frontend tries to persist (open tabs, the
    # last-selected project/language, panel widths — see App.tsx). Off,
    # with our own storage_path alongside everything else this app
    # already keeps under DATA_DIR, rather than pywebview's own default
    # (~/.pywebview or %APPDATA%\pywebview) — one place to find or wipe
    # this app's local state, not two.
    storage_path = str(DATA_DIR / "webview")
    if sys.platform.startswith("linux"):
        webview.start(gui="qt", private_mode=False, storage_path=storage_path)
    else:
        webview.start(private_mode=False, storage_path=storage_path)


if __name__ == "__main__":
    if FROZEN:
        # Windowed builds have no console to print a traceback to — log it
        # to desktop.log instead of vanishing silently on a crash.
        try:
            main()
        except Exception:
            logger.exception("Fatal error in desktop app")
            raise
    else:
        main()
