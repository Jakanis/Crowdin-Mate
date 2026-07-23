"""Crowdin OAuth 2.0 (authorization code flow) — the alternative to
pasting in a Personal Access Token.

Endpoints and behavior confirmed against Crowdin's own docs
(support.crowdin.com/developer/authorizing-oauth-apps/):
- Authorize: GET https://accounts.crowdin.com/oauth/authorize
- Token exchange / refresh: POST https://accounts.crowdin.com/oauth/token
- access_token lives 7200s (2h) and comes with a refresh_token

The redirect_uri is fixed to this same backend's own /oauth/callback
route (see main.py) — no separate listener needed, and it must exactly
match whatever URL the user registers when creating the OAuth app in
their Crowdin account settings (profile picture → Settings → OAuth tab
→ New Application).

State (CSRF) is tracked in memory, not the DB — this is a single-user,
single-process local app, and the state's only job is to survive the
few seconds between "open the authorize URL" and "Crowdin redirects
back," not to persist across restarts.
"""

import secrets
from urllib.parse import urlencode

import requests

from app import config

REDIRECT_URI = "http://localhost:8000/oauth/callback"
AUTHORIZE_URL = "https://accounts.crowdin.com/oauth/authorize"
TOKEN_URL = "https://accounts.crowdin.com/oauth/token"
# Real scope names, confirmed against Crowdin's own scopes reference
# (support.crowdin.com/developer/understanding-scopes/) — the earlier
# guesses ("translation", "translation.approval", "comment") aren't
# real scopes and made Crowdin reject the authorize request with a 403.
# `project` covers general project access (including comments, which
# has no scope of its own); `project.translation` covers translations
# + approvals; `tm`/`glossary` cover their own resources.
SCOPES = "project project.translation tm glossary"

_pending_state: str | None = None


def build_authorize_url() -> str:
    global _pending_state
    client = config.get_oauth_client()
    if client is None:
        raise RuntimeError("No OAuth client configured — call POST /auth/oauth/client first.")

    _pending_state = secrets.token_urlsafe(24)
    params = {
        "client_id": client["client_id"],
        "redirect_uri": REDIRECT_URI,
        "response_type": "code",
        "scope": SCOPES,
        "state": _pending_state,
    }
    return f"{AUTHORIZE_URL}?{urlencode(params)}"


def is_valid_state(state: str) -> bool:
    return _pending_state is not None and secrets.compare_digest(state, _pending_state)


def exchange_code(code: str) -> dict:
    client = config.get_oauth_client()
    if client is None:
        raise RuntimeError("No OAuth client configured.")

    resp = requests.post(
        TOKEN_URL,
        data={
            "grant_type": "authorization_code",
            "client_id": client["client_id"],
            "client_secret": client["client_secret"],
            "redirect_uri": REDIRECT_URI,
            "code": code,
        },
        timeout=15,
    )
    resp.raise_for_status()
    data = resp.json()
    config.set_oauth_tokens(data["access_token"], data["refresh_token"], data["expires_in"])
    return config.get_oauth_tokens()


def refresh_access_token() -> dict | None:
    """Called from config.get_token() when the stored access_token has
    expired. Returns None (rather than raising) on failure — e.g. the
    user revoked the app on Crowdin's side — so callers fall through to
    "not authenticated" instead of crashing on an unrelated request."""
    client = config.get_oauth_client()
    tokens = config.get_oauth_tokens()
    if client is None or tokens is None:
        return None

    try:
        resp = requests.post(
            TOKEN_URL,
            data={
                "grant_type": "refresh_token",
                "client_id": client["client_id"],
                "client_secret": client["client_secret"],
                "refresh_token": tokens["refresh_token"],
            },
            timeout=15,
        )
        resp.raise_for_status()
    except requests.RequestException:
        return None

    data = resp.json()
    # A refresh response doesn't always include a new refresh_token —
    # keep the old one if Crowdin didn't rotate it.
    config.set_oauth_tokens(
        data["access_token"], data.get("refresh_token", tokens["refresh_token"]), data["expires_in"]
    )
    return config.get_oauth_tokens()
