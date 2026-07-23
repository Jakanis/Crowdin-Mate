"""Desktop entrypoint: runs the FastAPI backend in a background thread
and opens it in a native window via pywebview, instead of a browser tab.

Requires the frontend to already be built (`npm run build` in
frontend/, producing frontend/dist) — main.py mounts that directory as
static files when it's present. See README's "Desktop app" section.

The backend is otherwise unchanged from dev mode: same port (8000),
same OAuth redirect_uri (http://localhost:8000/oauth/callback), same
SQLite cache under ~/.classicua-client. Only how it's launched differs.
"""

import logging
import threading
import time
import urllib.request

import uvicorn
import webview

from app.main import app

HOST = "127.0.0.1"
PORT = 8000
STARTUP_TIMEOUT_SECONDS = 15

logger = logging.getLogger(__name__)


def _run_server() -> None:
    # warning, not info — this window has no terminal a user watches;
    # only real problems are worth its (still-visible, on Windows) console.
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
        "ClassicUA Translation Client",
        f"http://{HOST}:{PORT}",
        width=1360,
        height=880,
        min_size=(960, 640),
    )
    webview.start()


if __name__ == "__main__":
    main()
