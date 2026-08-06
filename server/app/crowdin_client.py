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
from contextlib import contextmanager

import requests
from crowdin_api import CrowdinClient
from crowdin_api.exceptions import Throttled

from app import debug_mode
from app.config import get_token

logger = logging.getLogger(__name__)

MAX_CONCURRENT = 6
SUSTAINED_RATE_PER_SEC = 8
MAX_RETRIES_ON_THROTTLE = 6

# Background jobs — the tree crawl, the offline pre-cache — get a slice of
# the budget, not all of it. They issue hundreds of calls back to back, and
# with one shared limiter they starved everything the user was doing:
# measured during a full tree crawl, comment lookups that normally answer in
# 0.2s took 1.8s to 9.8s, and a file resync took 7.2s. That is what "opening
# a file was slow" and "approve ignored my first click" actually were — the
# request was queued behind a crawl nobody asked for, and the app looked
# broken rather than busy.
#
# Two limits, because they fail differently: the semaphore stops background
# work occupying every connection slot, and the rate reserve stops it
# consuming the whole calls-per-second budget with slots to spare.
MAX_CONCURRENT_BACKGROUND = 2
INTERACTIVE_RESERVE_PER_SEC = 3

_concurrency_gate = threading.Semaphore(MAX_CONCURRENT)
_background_gate = threading.Semaphore(MAX_CONCURRENT_BACKGROUND)
_rate_lock = threading.Lock()
_recent_call_times: deque[float] = deque()
_local = threading.local()


@contextmanager
def background_work():
    """Marks everything called inside as background, on this thread.

    A context manager rather than a parameter threaded through every
    call_with_limits call site: the jobs that need it are whole functions
    deep in a call stack (sync_project_tree, the pre-cache loop), and each
    already runs on its own thread, so wrapping the job is both a smaller
    change and harder to get half-right than tagging individual calls.
    """
    previous = getattr(_local, "background", False)
    _local.background = True
    try:
        yield
    finally:
        _local.background = previous


def _is_background() -> bool:
    return getattr(_local, "background", False)


@contextmanager
def _null_gate():
    """Stand-in so the `with` below can name one gate or the other without
    branching into two near-identical copies of the retry loop."""
    yield


def _throttle_for_sustained_rate(background: bool = False) -> None:
    """Sliding-window limiter: block until under SUSTAINED_RATE_PER_SEC.

    Background callers stop short of the full budget, so a burst of them
    can never leave an interactive request with nothing to spend.
    """
    ceiling = SUSTAINED_RATE_PER_SEC - (INTERACTIVE_RESERVE_PER_SEC if background else 0)
    with _rate_lock:
        now = time.monotonic()
        window_start = now - 1.0
        while _recent_call_times and _recent_call_times[0] < window_start:
            _recent_call_times.popleft()

        if len(_recent_call_times) >= ceiling:
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

# Nothing this app asks Crowdin for legitimately takes half a minute, and
# the SDK's own 60s default applies to connecting as well as reading, then
# gets multiplied by its retries. A tighter bound turns a dead connection
# from a wait long enough to look like a freeze into a normal error.
REQUEST_TIMEOUT_SECONDS = 20

# How long the pooled connections may sit unused before they're replaced.
# Aimed squarely at "came back from a break and the first thing I opened
# hung": five minutes is far longer than any gap within active use, so
# ordinary work never pays the reconnect, while any real break does.
CLIENT_MAX_IDLE_SECONDS = 300

_client: CrowdinClient | None = None
_client_key: tuple[str, bool] | None = None
_client_last_used: float = 0.0
_client_lock = threading.Lock()


def get_client() -> CrowdinClient:
    """Returns a CrowdinClient bound to the currently stored token.

    Rebuilds the client if the token changed (e.g. the user re-entered a
    new PAT) so we never hold a stale credential — and likewise if the
    simulate-offline toggle flipped, since that's baked into the client's
    base URL and the SDK builds its request-maker once per instance.

    Also rebuilds after a long idle period. The SDK holds one
    requests.Session, so its connections are pooled and reused — and a
    pooled connection that went idle while the machine slept, changed
    network, or simply sat there long enough for something in the middle to
    drop it is usually not detectably dead. Writing to it blocks until the
    read timeout rather than failing, which is what turns "open a file I
    haven't opened before, after a break" into a long hang: that path syncs
    the file's content synchronously, so the whole request waits on it.
    Throwing the pool away after an idle spell costs one TCP+TLS handshake
    on the next call and removes the whole failure mode.
    """
    global _client, _client_key, _client_last_used
    token = get_token()
    if token is None:
        raise RuntimeError("No Crowdin token configured. Call POST /auth/token first.")

    offline = debug_mode.is_simulate_offline()
    key = (token, offline)
    now = time.monotonic()
    with _client_lock:
        idle_too_long = (
            _client is not None and now - _client_last_used > CLIENT_MAX_IDLE_SECONDS
        )
        if _client is None or _client_key != key or idle_too_long:
            if idle_too_long:
                logger.info(
                    "Crowdin client idle for over %ss — reconnecting rather than risking a "
                    "stale pooled connection.", CLIENT_MAX_IDLE_SECONDS,
                )
            _client = CrowdinClient(
                token=token,
                # 1, not 0: the SDK does `max_retries or self.MAX_RETRIES`, so a
                # falsy 0 would silently restore its own default of 5.
                max_retries=1 if offline else 3,   # SDK-level retry, for transient 5xx only
                retry_delay=0.5,
                # The SDK's own default is 60s, applied to both connect and
                # read, and its retries multiply it. That is a fine ceiling
                # for a batch job and far too long for a click: nothing here
                # legitimately takes half a minute, so waiting three of them
                # to find out the connection was dead is all downside.
                timeout=REQUEST_TIMEOUT_SECONDS,
                base_url=_OFFLINE_BASE_URL if offline else None,
            )
            _client_key = key
        _client_last_used = now

    return _client


def _mark_client_used() -> None:
    global _client_last_used
    _client_last_used = time.monotonic()


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
    background = _is_background()
    # Nested so a background call holds BOTH gates: it still counts against
    # the overall cap, it just can't take more than its own share of it.
    with _background_gate if background else _null_gate(), _concurrency_gate:
        attempt = 0
        while True:
            _throttle_for_sustained_rate(background)
            # Every call, not just get_client(): a long-running job holds one
            # client reference for its whole run, so without this the pool
            # would look idle throughout and get recycled mid-job.
            _mark_client_used()
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
