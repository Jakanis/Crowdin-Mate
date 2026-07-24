# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the packaged desktop app.

Build (from server/, with the frontend already built via `npm run build`
in frontend/ — this spec bundles whatever's currently in frontend/dist,
it does not build it):

    pyinstaller desktop.spec

Produces a single-file executable named "Crowdin Mate" (.exe on
Windows) under server/dist/. See README's "Building a release"
section for the full release process (both platforms, GitHub Actions).

Windows uses pywebview's native WebView2 backend (bundled with Windows
10 21H2+/11) — nothing Qt-related gets pulled in there. Linux uses the
Qt backend instead of GTK (see desktop.py's own docstring on why); PyQt5
and PyQtWebEngine are genuinely self-contained wheels (they bundle their
own copy of Qt), so excluding them on Windows keeps that build smaller
without losing anything it needed.
"""

import sys
from pathlib import Path

SPEC_DIR = Path(SPECPATH)  # noqa: F821 - injected into the exec globals by PyInstaller
REPO_ROOT = SPEC_DIR.parent
FRONTEND_DIST = REPO_ROOT / "frontend" / "dist"

if not FRONTEND_DIST.is_dir():
    raise SystemExit(
        f"{FRONTEND_DIST} doesn't exist — run `npm run build` in frontend/ first."
    )

IS_LINUX = sys.platform.startswith("linux")

block_cipher = None

a = Analysis(  # noqa: F821
    ["desktop.py"],
    pathex=[str(SPEC_DIR)],
    binaries=[],
    datas=[
        (str(FRONTEND_DIST), "frontend/dist"),
        (str(SPEC_DIR / "app" / "schema.sql"), "app"),
    ],
    hiddenimports=[
        # keyring picks its actual backend at runtime via entry points,
        # which PyInstaller's static import analysis can't see coming —
        # without these, the packaged app silently falls back to a
        # no-op/"fail" keyring backend and every login attempt breaks.
        "keyring.backends.Windows",
        "keyring.backends.macOS",
        "keyring.backends.SecretService",
        "keyring.backends.kwallet",
        "keyring.backends.libsecret",
        # Same story for uvicorn's protocol/loop implementations, which
        # it also selects dynamically ("auto") rather than importing
        # directly by name.
        "uvicorn.loops.auto",
        "uvicorn.protocols.http.auto",
        "uvicorn.protocols.websockets.auto",
        "uvicorn.lifespan.on",
        # Linux only: qtpy picks its actual Qt binding (PyQt5 here) at
        # runtime via its own detection, which static analysis can't
        # see coming — confirmed live the packaged binary otherwise
        # fails outright with "No module named 'qtpy'" pulling this in
        # transitively isn't enough on its own.
        "qtpy",
        "qtpy.QtWidgets",
        "qtpy.QtCore",
        "qtpy.QtGui",
    ] + (["PyQt5.QtWebEngineWidgets"] if IS_LINUX else []),
    hookspath=[],
    excludes=[] if IS_LINUX else ["PyQt5", "PyQtWebEngine"],
    noarchive=False,
)

pyz = PYZ(a.pure)  # noqa: F821

exe = EXE(  # noqa: F821
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="Crowdin Mate",
    debug=False,
    strip=False,
    upx=False,
    console=False,
)
