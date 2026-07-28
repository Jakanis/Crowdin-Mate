"""Live, project-wide search via Crowdin's own CroQL query language —
covers every string in the project regardless of what's cached locally,
unlike search_strings' local FTS index (search_index.py), which only
reaches whatever's been opened or explicitly indexed.

Two calls: CroQL against source_strings.list_strings finds matching
strings (source text OR any translation, in any language — CroQL
doesn't support filtering the translations sub-query by language, see
below), then one batch call to string_translations.list_language_translations
fetches just the target-language translations for those specific
string ids, to build a real target-language snippet and figure out
which strings actually have a target-language translation at all.

CroQL has no working escape sequence for a literal `"` inside a string
literal (confirmed live — `\\"` is rejected as invalid syntax), so
quote and backslash characters are stripped from the query before
embedding it, rather than escaped.
"""

from app.crowdin_client import call_with_limits, get_client

SNIPPET_CONTEXT_CHARS = 60


def _unwrap(item: dict) -> dict:
    return item.get("data", item) if isinstance(item, dict) else item


def _iso(value) -> str | None:
    """Same normalization file_content_sync.py's own _iso does — the SDK
    parses timestamp fields into datetime objects (or leaves them None)
    rather than raw strings."""
    if value is None:
        return None
    if isinstance(value, str):
        return value
    return value.isoformat()


def _croql_literal(q: str) -> str:
    return q.replace('"', "").replace("\\", "")


def _make_snippet(text: str, query: str) -> str:
    """Mimics FTS5's snippet() output shape (⟦match⟧ + … ellipsis) that
    SearchPanel.tsx already knows how to render, so the frontend needs
    no changes regardless of which search path produced the result."""
    lower_text = text.lower()
    lower_query = query.lower()
    pos = lower_text.find(lower_query)
    if pos == -1:
        # Matched via CroQL but not a literal substring of this exact
        # text (e.g. a different translation matched) — just show the
        # start of it, untruncated-highlighted.
        clipped = text[: SNIPPET_CONTEXT_CHARS * 2]
        return clipped + ("…" if len(text) > len(clipped) else "")

    start = max(0, pos - SNIPPET_CONTEXT_CHARS)
    end = min(len(text), pos + len(query) + SNIPPET_CONTEXT_CHARS)
    prefix = "…" if start > 0 else ""
    suffix = "…" if end < len(text) else ""
    before = text[start:pos]
    match = text[pos : pos + len(query)]
    after = text[pos + len(query) : end]
    return f"{prefix}{before}⟦{match}⟧{after}{suffix}"


def search_project_live(project_id: int, query: str, target_language_id: str, limit: int) -> list[dict]:
    """Returns dicts shaped like {string_id, file_id, identifier,
    source_text, source_snippet, target_snippet, translator_name,
    submitted_at, is_approved} — file_path is added by the caller from
    the local files cache (already synced via tree_sync, no extra API
    call needed for that part)."""
    literal = _croql_literal(query)
    if not literal.strip():
        return []

    client = get_client()
    croql = f'text contains "{literal}" or (count of translations where (text contains "{literal}") > 0)'
    resp = call_with_limits(
        client.source_strings.list_strings,
        projectId=project_id,
        croql=croql,
        limit=limit,
    )
    strings = [_unwrap(item) for item in resp.get("data", [])]
    if not strings:
        return []

    string_ids = [s["id"] for s in strings]
    translations_resp = call_with_limits(
        client.string_translations.list_language_translations,
        projectId=project_id,
        languageId=target_language_id,
        stringIds=string_ids,
        limit=len(string_ids) * 5,
    )
    translations_by_string: dict[int, list[dict]] = {}
    for item in translations_resp.get("data", []):
        t = _unwrap(item)
        translations_by_string.setdefault(t["stringId"], []).append(t)

    # Approval status isn't in the response above at all (it's a wholly
    # separate resource) — one call per DISTINCT file among the matched
    # strings, same file-scoped endpoint file_content_sync.py already
    # uses for an open file, just applied here across however many
    # different files this search's results happen to span. Bounded by
    # unique files in this one page of results (typically well under
    # `limit`, since a query's hits often cluster in a handful of
    # related files), not by the total project size — but a search
    # whose matches happen to land in `limit` entirely different files
    # would cost `limit` extra calls, same tradeoff as any per-file
    # lookup in this codebase.
    approved_translation_ids: set[int] = set()
    file_ids_in_results = {s["fileId"] for s in strings if s.get("fileId") is not None}
    for file_id in file_ids_in_results:
        approvals_resp = call_with_limits(
            client.string_translations.with_fetch_all().list_translation_approvals,
            projectId=project_id,
            fileId=file_id,
            languageId=target_language_id,
        )
        for item in approvals_resp.get("data", []):
            approved_translation_ids.add(_unwrap(item)["translationId"])

    results = []
    for s in strings:
        source_text = s.get("text", "")
        candidates = translations_by_string.get(s["id"], [])
        # Prefer whichever translation actually contains the query, so
        # the target snippet (and the who/when/approved shown alongside
        # it) is the relevant one when a string has several contributor
        # translations.
        chosen = next((t for t in candidates if literal.lower() in t.get("text", "").lower()), None)
        if chosen is None and candidates:
            chosen = candidates[0]
        target_text = chosen.get("text") if chosen else None
        user = (chosen or {}).get("user") or {}

        results.append(
            {
                "string_id": s["id"],
                "file_id": s.get("fileId"),
                "identifier": s.get("identifier"),
                "source_snippet": _make_snippet(source_text, literal),
                "target_snippet": _make_snippet(target_text, literal) if target_text else None,
                "translator_name": (user.get("fullName") or user.get("username")) if chosen else None,
                "submitted_at": _iso(chosen.get("createdAt")) if chosen else None,
                "is_approved": bool(chosen and chosen.get("translationId") in approved_translation_ids),
            }
        )
    return results
