"""App-level configuration and secret storage.

The Crowdin credentials (PAT, or OAuth client secret + access/refresh
tokens) are the one piece of data that must never land in a plaintext
file, a log line, or a response body sent to the frontend. They live
exclusively in the OS credential store via `keyring` (Windows Credential
Manager on this machine) and are read back only inside this module.
"""

import json
import time
from pathlib import Path

import keyring

KEYRING_SERVICE = "classicua-desktop-client"
KEYRING_USERNAME = "crowdin-pat"
KEYRING_OAUTH_CLIENT = "crowdin-oauth-client"  # {"client_id", "client_secret"} - short, fits fine as JSON
# access_token/refresh_token stored as SEPARATE entries, not one combined
# JSON blob — Windows Credential Manager caps a single credential's blob
# around 2560 bytes (and keyring's win32 backend stores it as UTF-16,
# roughly doubling the effective size), and Crowdin's two tokens
# together as JSON blew past that, failing with a raw pywin32 CredWrite
# error ("The stub received bad data") instead of a clear error message.
KEYRING_OAUTH_ACCESS_TOKEN = "crowdin-oauth-access-token"
KEYRING_OAUTH_REFRESH_TOKEN = "crowdin-oauth-refresh-token"
KEYRING_OAUTH_EXPIRES_AT = "crowdin-oauth-expires-at"

DATA_DIR = Path.home() / ".classicua-client"
DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / "cache.sqlite3"


def _get_json(username: str) -> dict | None:
    raw = keyring.get_password(KEYRING_SERVICE, username)
    return json.loads(raw) if raw else None


def _set_json(username: str, value: dict) -> None:
    keyring.set_password(KEYRING_SERVICE, username, json.dumps(value))


def _clear(username: str) -> None:
    try:
        keyring.delete_password(KEYRING_SERVICE, username)
    except keyring.errors.PasswordDeleteError:
        pass


def get_pat() -> str | None:
    return keyring.get_password(KEYRING_SERVICE, KEYRING_USERNAME)


def set_pat(token: str) -> None:
    keyring.set_password(KEYRING_SERVICE, KEYRING_USERNAME, token)


def clear_pat() -> None:
    _clear(KEYRING_USERNAME)


def get_oauth_client() -> dict | None:
    return _get_json(KEYRING_OAUTH_CLIENT)


def set_oauth_client(client_id: str, client_secret: str) -> None:
    _set_json(KEYRING_OAUTH_CLIENT, {"client_id": client_id, "client_secret": client_secret})


def get_oauth_tokens() -> dict | None:
    access_token = keyring.get_password(KEYRING_SERVICE, KEYRING_OAUTH_ACCESS_TOKEN)
    if access_token is None:
        return None
    refresh_token = keyring.get_password(KEYRING_SERVICE, KEYRING_OAUTH_REFRESH_TOKEN)
    expires_at = keyring.get_password(KEYRING_SERVICE, KEYRING_OAUTH_EXPIRES_AT)
    return {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "expires_at": float(expires_at) if expires_at else 0.0,
    }


def set_oauth_tokens(access_token: str, refresh_token: str, expires_in: int) -> None:
    # expires_at trimmed by 60s so a call that starts just before the real
    # expiry doesn't get a token that dies mid-request.
    keyring.set_password(KEYRING_SERVICE, KEYRING_OAUTH_ACCESS_TOKEN, access_token)
    keyring.set_password(KEYRING_SERVICE, KEYRING_OAUTH_REFRESH_TOKEN, refresh_token)
    keyring.set_password(KEYRING_SERVICE, KEYRING_OAUTH_EXPIRES_AT, str(time.time() + expires_in - 60))


def clear_oauth_tokens() -> None:
    """Only the access/refresh tokens — NOT the client_id/secret, which
    the user registered by hand and shouldn't have to re-enter just
    because a token exchange failed partway through."""
    _clear(KEYRING_OAUTH_ACCESS_TOKEN)
    _clear(KEYRING_OAUTH_REFRESH_TOKEN)
    _clear(KEYRING_OAUTH_EXPIRES_AT)


def clear_oauth() -> None:
    _clear(KEYRING_OAUTH_CLIENT)
    _clear(KEYRING_OAUTH_ACCESS_TOKEN)
    _clear(KEYRING_OAUTH_REFRESH_TOKEN)
    _clear(KEYRING_OAUTH_EXPIRES_AT)


def get_token() -> str | None:
    """The single bearer token get_client() actually uses — OAuth's
    access_token when an OAuth login has been completed (refreshing
    first if it's expired), else the legacy PAT. Crowdin's API accepts
    both identically as `Authorization: Bearer <token>`, so nothing
    downstream needs to know which mode is active."""
    from app import oauth  # local import: avoids a circular import at module load time

    tokens = get_oauth_tokens()
    if tokens is not None:
        if tokens["expires_at"] <= time.time():
            tokens = oauth.refresh_access_token()
        return tokens["access_token"] if tokens else None
    return get_pat()


def clear_token() -> None:
    """Disconnects whichever auth mode is currently active."""
    clear_pat()
    clear_oauth()
