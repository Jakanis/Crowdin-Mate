"""App-level configuration and secret storage.

The Crowdin credentials (PAT, or OAuth client secret + access/refresh
tokens) are the one piece of data that must never land in a plaintext
file, a log line, or a response body sent to the frontend. They live
exclusively in the OS credential store via `keyring` (Windows Credential
Manager on this machine) and are read back only inside this module.
"""

import json
import logging
import os
import time
from pathlib import Path

import keyring

logger = logging.getLogger(__name__)

# Pre-rename service name (this app used to be ClassicUA-specific) —
# kept only so _migrate_legacy_keyring below can move existing installs'
# credentials over without forcing a re-login.
_OLD_KEYRING_SERVICE = "classicua-desktop-client"
KEYRING_SERVICE = "crowdin-mate"
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


def _migrate_legacy_keyring() -> None:
    """One-time migration for this app's pre-rename keyring service name
    — copies any existing credentials over under the new service name so
    renaming the app doesn't force an existing install to re-enter its
    PAT or redo OAuth. Safe to run every startup: each entry is deleted
    from the old service once moved, so this is a no-op after the first
    run (or on a fresh install with nothing to migrate).

    Runs at import time, so it must tolerate there being no usable
    keyring backend at all (a bare Linux CI runner or a minimal install
    with no secret service running) — confirmed live this raises
    NoKeyringError rather than just returning None, which would
    otherwise crash the whole app on import before it ever gets a
    chance to show its own "connect your account" screen."""
    try:
        for username in (
            KEYRING_USERNAME,
            KEYRING_OAUTH_CLIENT,
            KEYRING_OAUTH_ACCESS_TOKEN,
            KEYRING_OAUTH_REFRESH_TOKEN,
            KEYRING_OAUTH_EXPIRES_AT,
        ):
            if keyring.get_password(KEYRING_SERVICE, username) is not None:
                continue
            old_value = keyring.get_password(_OLD_KEYRING_SERVICE, username)
            if old_value is not None:
                keyring.set_password(KEYRING_SERVICE, username, old_value)
                try:
                    keyring.delete_password(_OLD_KEYRING_SERVICE, username)
                except keyring.errors.PasswordDeleteError:
                    pass
    except keyring.errors.KeyringError:
        pass


_migrate_legacy_keyring()

# Pre-rename data directory — same reasoning as the keyring migration
# above: move it wholesale (cache + everything else in it) rather than
# leave an existing install's local cache orphaned by the rename.
#
# CROWDIN_MATE_DATA_DIR redirects the whole cache elsewhere. This exists so
# offline mode can actually be tested: a throwaway instance otherwise shares
# the real cache.sqlite3, so exercising the offline queue writes junk rows
# into the database the user is translating against, and any cache the test
# populates or invalidates is the live one.
#
# Deliberately only the data dir, not the keyring — a test instance should
# still authenticate as you, since re-entering a token to test offline
# behaviour would be its own obstacle. Cache is per-instance; credentials
# are per-machine.
#
# The legacy rename is skipped when overridden: it moves an old install's
# real cache, which has nothing to do with a scratch directory.
DEFAULT_DATA_DIR = Path.home() / ".crowdin-mate"
_ENV_DATA_DIR = os.environ.get("CROWDIN_MATE_DATA_DIR")
if _ENV_DATA_DIR:
    DATA_DIR = Path(_ENV_DATA_DIR).expanduser()
else:
    _OLD_DATA_DIR = Path.home() / ".classicua-client"
    DATA_DIR = DEFAULT_DATA_DIR
    if _OLD_DATA_DIR.exists() and not DATA_DIR.exists():
        _OLD_DATA_DIR.rename(DATA_DIR)
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
            try:
                tokens = oauth.refresh_access_token()
            except oauth.RefreshUnavailable:
                # Offline. Keep the expired token rather than reporting no
                # credentials at all: being unable to REFRESH is not being
                # logged out, and treating it as such is what asked people
                # to sign in again — over a network they don't have — and
                # left translations unsaveable, since nothing downstream
                # had a token to make the attempt that would have been
                # queued.
                #
                # The expired token is knowingly useless as a credential.
                # It doesn't need to work: with no connection the call
                # fails at the transport, which is the offline path that
                # queues the write. Once there's a connection again, the
                # next refresh succeeds and this never comes up.
                logger.info("Token refresh unavailable (offline); keeping the stored session.")
        return tokens["access_token"] if tokens else None
    return get_pat()


def clear_token() -> None:
    """Disconnects whichever auth mode is currently active."""
    clear_pat()
    clear_oauth()
