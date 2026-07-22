"""App-level configuration and secret storage.

The Crowdin Personal Access Token is the one piece of data that must never
land in a plaintext file, a log line, or a response body sent to the
frontend. It lives exclusively in the OS credential store via `keyring`
(Windows Credential Manager on this machine) and is read back only inside
this module.
"""

from pathlib import Path

import keyring

KEYRING_SERVICE = "classicua-desktop-client"
KEYRING_USERNAME = "crowdin-pat"

DATA_DIR = Path.home() / ".classicua-client"
DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / "cache.sqlite3"


def get_token() -> str | None:
    return keyring.get_password(KEYRING_SERVICE, KEYRING_USERNAME)


def set_token(token: str) -> None:
    keyring.set_password(KEYRING_SERVICE, KEYRING_USERNAME, token)


def clear_token() -> None:
    try:
        keyring.delete_password(KEYRING_SERVICE, KEYRING_USERNAME)
    except keyring.errors.PasswordDeleteError:
        pass
