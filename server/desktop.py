"""Desktop entrypoint: runs the FastAPI backend in a background thread
and opens it in a native window via pywebview, instead of a browser tab.

Requires the frontend to already be built (`npm run build` in
frontend/, producing frontend/dist) — main.py mounts that directory as
static files when it's present. See README's "Desktop app" section.

The backend is otherwise unchanged from dev mode: same port (8000),
same OAuth redirect_uri (http://localhost:8000/oauth/callback), same
SQLite cache under ~/.crowdin-mate. Only how it's launched differs.
"""

import logging
import sys
import threading
import time
import urllib.request

import uvicorn
import webview

from app.config import DATA_DIR
from app.main import app

HOST = "127.0.0.1"
PORT = 8000
STARTUP_TIMEOUT_SECONDS = 15

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


def _run_server() -> None:
    # warning, not info — nobody's watching a console for this (never true
    # even in dev-mode strictly, but doubly so once packaged/windowed);
    # only real problems are worth surfacing at all.
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")


def _wait_until_ready(timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    url = f"http://{HOST}:{PORT}/auth/status"
    while time.monotonic() < deadline:
        try:
            urllib.request.urlopen(url, timeout=0.5)
            return True
        except Exception:
            time.sleep(0.2)
    return False


def main() -> None:
    server_thread = threading.Thread(target=_run_server, daemon=True)
    server_thread.start()

    if not _wait_until_ready(STARTUP_TIMEOUT_SECONDS):
        logger.error("Backend didn't come up within %ss — opening the window anyway.", STARTUP_TIMEOUT_SECONDS)

    webview.create_window(
        "Crowdin Mate",
        f"http://{HOST}:{PORT}",
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
    if sys.platform.startswith("linux"):
        webview.start(gui="qt")
    else:
        webview.start()


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
