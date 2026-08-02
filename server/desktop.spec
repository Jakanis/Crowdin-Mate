# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the packaged desktop app.

Build (from server/, with the frontend already built via `npm run build`
in frontend/ — this spec bundles whatever's currently in frontend/dist,
it does not build it):

    pyinstaller desktop.spec

Produces the folder server/dist/Crowdin Mate/, holding an executable of
the same name (.exe on Windows) alongside everything it needs. Read the
note above EXE at the bottom before collapsing that into a single file —
Defender blocks the one-file build outright once it has been downloaded.
See README's "Building a release" section for the full release process
(both platforms, GitHub Actions).

Windows uses pywebview's native WebView2 backend (bundled with Windows
10 21H2+/11) — nothing Qt-related gets pulled in there. Linux uses the
Qt backend instead of GTK (see desktop.py's own docstring on why); PyQt5
and PyQtWebEngine are genuinely self-contained wheels (they bundle their
own copy of Qt), so excluding them on Windows keeps that build smaller
without losing anything it needed.
"""

import json
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
IS_WINDOWS = sys.platform.startswith("win")

block_cipher = None


def _write_windows_version_resource() -> str:
    """Stamp the exe with a Windows version resource, and return its path.

    Without one, the built exe has no CompanyName, ProductName, version or
    description at all — the properties dialog is blank. That is worth
    fixing on its own, and it also matters for how the binary is received:
    a brand-new unsigned executable with no metadata whatsoever is part of
    the profile Defender's ML heuristics are built to be suspicious of,
    which is how a release ends up flagged as Trojan:Win32/Wacatac.B!ml
    (an ML bucket, not a signature match).

    Metadata alone will not clear that — see README's own section — but it
    removes one of the few signals we can actually control for free.

    Version comes from frontend/package.json so there is one place to bump
    it, rather than a second copy here to forget about.
    """
    raw = json.loads((REPO_ROOT / "frontend" / "package.json").read_text(encoding="utf-8"))["version"]
    parts = [int(p) for p in raw.split(".")][:3]
    while len(parts) < 4:
        parts.append(0)
    quad = tuple(parts)
    dotted = ".".join(str(p) for p in quad)

    resource = f"""VSVersionInfo(
  ffi=FixedFileInfo(
    filevers={quad},
    prodvers={quad},
    mask=0x3f,
    flags=0x0,
    OS=0x40004,
    fileType=0x1,
    subtype=0x0,
    date=(0, 0),
  ),
  kids=[
    StringFileInfo([
      StringTable(
        '040904B0',
        [
          StringStruct('CompanyName', 'Crowdin Mate contributors'),
          StringStruct('FileDescription', 'Crowdin Mate - offline-tolerant desktop client for Crowdin'),
          StringStruct('FileVersion', '{dotted}'),
          StringStruct('InternalName', 'Crowdin Mate'),
          StringStruct('LegalCopyright', 'MIT License'),
          StringStruct('OriginalFilename', 'Crowdin Mate.exe'),
          StringStruct('ProductName', 'Crowdin Mate'),
          StringStruct('ProductVersion', '{dotted}'),
        ],
      )
    ]),
    VarFileInfo([VarStruct('Translation', [1033, 1200])]),
  ],
)
"""
    path = SPEC_DIR / "build" / "version_info.txt"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(resource, encoding="utf-8")
    return str(path)


VERSION_RESOURCE = _write_windows_version_resource() if IS_WINDOWS else None

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

# One FOLDER, not one file — and this is load-bearing, not a preference.
#
# A one-file build appends the payload to a self-extracting stub that
# unpacks ~20MB to a temp directory and runs a Python interpreter out of it
# on every launch. That is close to the textbook description of a dropper.
# Measured, not assumed: a one-file exe carrying Mark of the Web (i.e. any
# copy someone downloaded) is DETECTED AND BLOCKED OUTRIGHT by Defender as
# Trojan:Win32/Wacatac.B!ml — Windows refuses to start it at all. The same
# exe without the mark scans clean, which is why this is so easy to miss
# when testing a build you made yourself.
#
# The same test on a one-folder build: runs, no detection.
#
# One-folder has its own downloaded-only failure — .NET refuses to load the
# Mark-of-the-Web-tagged pythonnet assembly — but that one we can fix, and
# do, in desktop.py's _unblock_bundled_dotnet_assemblies. A Defender block
# we cannot.
#
# One-folder also starts about a second faster (2.3s vs 3.4s median), since
# nothing is unpacked per launch.
exe = EXE(  # noqa: F821
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="Crowdin Mate",
    debug=False,
    strip=False,
    # Left off deliberately. UPX-packing is one of the strongest single
    # triggers for heuristic malware detection, and it buys nothing here —
    # the payload is compressed already.
    upx=False,
    console=False,
    version=VERSION_RESOURCE,
)

coll = COLLECT(  # noqa: F821
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="Crowdin Mate",
)
