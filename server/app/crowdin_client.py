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


class SimulatedOfflineError(ConnectionError):
    """Raised instead of actually calling Crowdin when debug_mode's
    simulate-offline toggle is on. Deliberately a ConnectionError
    subclass, not some bespoke exception type: every existing
    except-clause downstream (submit_translation, offline_queue.drain_once)
    only ever special-cases `isinstance(exc, APIException)` to decide
    terminal-vs-queue, never the exact exception type — so this is
    genuinely indistinguishable to that logic from a real network
    outage, and exercises the actual enqueue/drain/retry code path
    rather than a fake UI-only state."""


_client: CrowdinClient | None = None
_client_token: str | None = None


def get_client() -> CrowdinClient:
    """Returns a CrowdinClient bound to the currently stored token.

    Rebuilds the client if the token changed (e.g. the user re-entered a
    new PAT) so we never hold a stale credential.
    """
    global _client, _client_token
    token = get_token()
    if token is None:
        raise RuntimeError("No Crowdin token configured. Call POST /auth/token first.")

    if _client is None or _client_token != token:
        _client = CrowdinClient(
            token=token,
            max_retries=3,   # SDK-level retry, for transient 5xx only
            retry_delay=0.5,
        )
        _client_token = token

    return _client


def call_with_limits(fn, *args, **kwargs):
    """Run one Crowdin SDK call under the concurrency + rate + 429 guards.

    Usage: call_with_limits(client.source_files.list_files, projectId=393919)
    """
    if debug_mode.is_simulate_offline():
        # Checked before the concurrency gate/rate limiter too — a
        # simulated outage shouldn't consume a real rate-limit slot or
        # wait behind other in-flight calls, it should fail instantly
        # like a real dead connection would.
        raise SimulatedOfflineError("Simulated offline mode is enabled (see debug_mode.py)")

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
