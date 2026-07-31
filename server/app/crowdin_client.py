"""Rate-limited wrapper around the official `crowdin-api-client` SDK.

Every Crowdin API call in this app goes through `get_client()` /
`call_with_limits`. Two things the raw SDK does NOT do on its own, verified
by reading crowdin_api/requester.py and exceptions.py directly:

- It does not retry 429 (Throttled) responses. `APIException.should_retry`
  defaults to False for any status in [300, 499], which includes 429 — the
  SDK's built-in retry loop only ever fires for 5xx/network-level errors.
  So we handle 429 ourselves: honor `Retry-After` when present, otherwise
  exponential backoff with jitter.
- It has no concurrency cap. We add a semaphore so a background sync job
  and interactive requests can never together exceed a safe number of
  simultaneous in-flight calls (Crowdin's rate limits aren't precisely
  documented; community reports point to ~20 req/s/token as safe and
  60-70 parallel requests failing, so we stay well under that).
"""

import logging
import random
import threading
import time
from collections import deque

import requests
from crowdin_api import CrowdinClient
from crowdin_api.exceptions import Throttled

from app import debug_mode
from app.config import get_token

logger = logging.getLogger(__name__)

MAX_CONCURRENT = 6
SUSTAINED_RATE_PER_SEC = 8
MAX_RETRIES_ON_THROTTLE = 6

_concurrency_gate = threading.Semaphore(MAX_CONCURRENT)
_rate_lock = threading.Lock()
_recent_call_times: deque[float] = deque()


def _throttle_for_sustained_rate() -> None:
    """Sliding-window limiter: block until under SUSTAINED_RATE_PER_SEC."""
    with _rate_lock:
        now = time.monotonic()
        window_start = now - 1.0
        while _recent_call_times and _recent_call_times[0] < window_start:
            _recent_call_times.popleft()

        if len(_recent_call_times) >= SUSTAINED_RATE_PER_SEC:
            sleep_for = _recent_call_times[0] + 1.0 - now
        else:
            sleep_for = 0.0

    if sleep_for > 0:
        time.sleep(sleep_for)

    with _rate_lock:
        _recent_call_times.append(time.monotonic())


# Simulated offline points the SDK at a hostname that can never resolve,
# rather than short-circuiting before the call. `.invalid` is reserved by
# RFC 2606 precisely so it can never become a real name, so DNS fails
# immediately and requests raises the very same ConnectionError a dead
# connection produces.
#
# This replaces an earlier SimulatedOfflineError raised from a branch at
# the top of call_with_limits. That version never touched the transport,
# so it could only ever exercise the except-clauses — not the SDK's own
# retry logic, not the rate limiter's bookkeeping, and not any code that
# assumes a request was actually attempted. Failing for real at the
# client boundary means "simulated offline" and "genuinely offline" run
# the identical path, which is the only way testing offline mode proves
# anything about being offline.
_OFFLINE_BASE_URL = "simulated-offline.invalid/api/v2/"

# What "couldn't reach Crowdin" actually looks like, defined once so every
# endpoint that needs to fall back to cache agrees on it.
#
# Worth stating explicitly, because it is a trap: requests' ConnectionError
# is NOT a subclass of Python's builtin ConnectionError — it derives from
# RequestException(IOError). So `except ConnectionError` catches no real
# outage at all. That, combined with endpoints catching only APIException,
# is why a dead connection surfaced as a raw 500 instead of degrading.
#
# APIException is deliberately NOT in here: that means Crowdin answered
# and refused. A refusal is an answer, not an outage, and must not be
# masked by serving stale cache.
OFFLINE_ERRORS = (requests.exceptions.RequestException,)

_client: CrowdinClient | None = None
_client_key: tuple[str, bool] | None = None


def get_client() -> CrowdinClient:
    """Returns a CrowdinClient bound to the currently stored token.

    Rebuilds the client if the token changed (e.g. the user re-entered a
    new PAT) so we never hold a stale credential — and likewise if the
    simulate-offline toggle flipped, since that's baked into the client's
    base URL and the SDK builds its request-maker once per instance.
    """
    global _client, _client_key
    token = get_token()
    if token is None:
        raise RuntimeError("No Crowdin token configured. Call POST /auth/token first.")

    offline = debug_mode.is_simulate_offline()
    key = (token, offline)
    if _client is None or _client_key != key:
        _client = CrowdinClient(
            token=token,
            # 1, not 0: the SDK does `max_retries or self.MAX_RETRIES`, so a
            # falsy 0 would silently restore its own default of 5.
            max_retries=1 if offline else 3,   # SDK-level retry, for transient 5xx only
            retry_delay=0.5,
            base_url=_OFFLINE_BASE_URL if offline else None,
        )
        _client_key = key

    return _client


def add_translation(client, project_id: int, string_id: int, language_id: str, text: str,
                    provider: str | None = None):
    """add_translation, plus the `provider` field the SDK doesn't expose.

    Crowdin records where a translation came from — "tm" for one taken from
    a translation-memory suggestion — and shows it in its own editor. Its
    add_translation() builds a fixed request_data dict with no room for it,
    so this mirrors that method and adds the field, going through the same
    requester (same session, auth and base URL, so simulated offline still
    applies) rather than a bare requests call.

    Confirmed live against TestProjectYK: posting provider="tm" returns 201
    with provider='tm', a control post without it returns provider=None, and
    re-reading both from the API shows the value persisted server-side — so
    it's accepted and stored, merely undocumented in the SDK.
    """
    resource = client.string_translations
    data = {"stringId": string_id, "languageId": language_id, "text": text}
    if provider:
        data["provider"] = provider
    return resource.requester.request(
        method="post",
        path=resource.get_translations_path(projectId=project_id),
        request_data=data,
    )


def call_with_limits(fn, *args, **kwargs):
    """Run one Crowdin SDK call under the concurrency + rate + 429 guards.

    Usage: call_with_limits(client.source_files.list_files, projectId=393919)
    """
    # No simulate-offline branch here on purpose — see _OFFLINE_BASE_URL
    # above. An outage is a transport failure, so it belongs at the client
    # boundary, not in a guard that skips the transport entirely.
    with _concurrency_gate:
        attempt = 0
        while True:
            _throttle_for_sustained_rate()
            try:
                return fn(*args, **kwargs)
            except Throttled as exc:
                attempt += 1
                if attempt > MAX_RETRIES_ON_THROTTLE:
                    raise

                retry_after = exc.headers.get("Retry-After") if exc.headers else None
                if retry_after is not None:
                    try:
                        delay = float(retry_after)
                    except ValueError:
                        delay = 2.0 ** attempt
                else:
                    delay = min(2.0 ** attempt, 30.0)

                delay += random.uniform(0, delay * 0.25)  # jitter
                logger.warning(
                    "Crowdin API throttled (attempt %s/%s), backing off %.1fs",
                    attempt, MAX_RETRIES_ON_THROTTLE, delay,
                )
                time.sleep(delay)
