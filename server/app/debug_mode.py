"""Developer-only testing toggles.

Deliberately in-memory only, never written to SQLite or keyring — a
toggle you can accidentally leave on should reset itself the next time
the backend restarts, rather than silently persisting across sessions
and quietly breaking real translation work days later.
"""

_simulate_offline = False


def is_simulate_offline() -> bool:
    return _simulate_offline


def set_simulate_offline(enabled: bool) -> None:
    global _simulate_offline
    _simulate_offline = enabled
