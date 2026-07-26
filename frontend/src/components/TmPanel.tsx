import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, type TmMatch } from "../api/client";
import { fullDateTime, timeAgo } from "../timeAgo";
import { TmSourceDiff } from "./TmSourceDiff";

interface TmPanelProps {
  projectId: number;
  stringId: number | null;
  languageId: string;
  sourceLanguageId: string;
  /** The focused string's own source text — diffed against each fuzzy
   * (< 100%) match's source below, matching Crowdin's own TM panel. Not
   * used while searching (see TmPanel's own doc comment). */
  sourceText: string | null;
  onJumpToMatch?: (fileId: number, stringId: number) => void;
}

const DEBOUNCE_MS = 300;

function TmMatchItem({
  m,
  compareText,
  onJumpToMatch,
}: {
  m: TmMatch;
  compareText?: string | null;
  onJumpToMatch?: (fileId: number, stringId: number) => void;
}) {
  const isPerfect = m.relevant >= 100;
  return (
    <div className="suggestion-item">
      <div className="suggestion-header">
        <span className={`suggestion-relevance${isPerfect ? " suggestion-relevance--perfect" : ""}`}>
          {isPerfect ? "Perfect match" : `${m.relevant}%`}
        </span>
        {m.tm_name && <span className="suggestion-source-name">{m.tm_name}</span>}
      </div>
      <div className="suggestion-source">
        {!isPerfect && compareText ? (
          <TmSourceDiff currentText={compareText} matchText={m.source_text} />
        ) : (
          m.source_text
        )}
      </div>
      <div className="suggestion-target">{m.target_text}</div>
      {(m.matched_user_name || m.updated_at) && (
        <div className="suggestion-meta">
          {m.matched_user_name ? (
            <span title={fullDateTime(m.matched_created_at as string)}>
              {m.matched_user_name} · {timeAgo(m.matched_created_at as string)}
            </span>
          ) : (
            <span title={fullDateTime(m.updated_at as string)}>Updated {timeAgo(m.updated_at as string)}</span>
          )}
          {m.matched_string_id != null && m.matched_file_id != null && (
            <button
              className="link-button"
              onClick={() => onJumpToMatch?.(m.matched_file_id as number, m.matched_string_id as number)}
              title={m.matched_file_path ?? undefined}
            >
              Go to string →
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Translation Memory tab: two modes sharing one panel, same split as
 * GlossaryPanel. With the search box empty, shows fuzzy matches for the
 * whole focused string against the project's TM (same segment-level
 * concordance search Crowdin's own "Automated Suggestions" panel runs).
 * Typing a query switches to an ad hoc concordance search against
 * whatever text was typed instead — always live against Crowdin (see
 * search_tm_live's docstring on why this isn't synced/cached locally
 * the way the glossary search is; TM is just too large).
 *
 * Crowdin's own TM panel shows who/when a match was added and lets you
 * jump to it — the concordance search API itself has no such fields
 * (only the TM segment's own updatedAt), but since this project's TM
 * mirrors real project translations, the backend reverse-looks-up the
 * same target text against another string in this project to recover
 * the real user/date, which is what matched_* below comes from (see
 * _augment_tm_matches_with_source in main.py). Falls back to the TM
 * segment's own updated_at when no local match is found (bulk-imported
 * entry, or the originating string isn't cached locally yet). */
export function TmPanel({ projectId, stringId, languageId, sourceLanguageId, sourceText, onJumpToMatch }: TmPanelProps) {
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(search), DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [search]);

  const searching = debounced.trim().length > 0;

  const searchQuery = useQuery({
    queryKey: ["tm-search", projectId, sourceLanguageId, languageId, debounced],
    queryFn: () => api.searchTm(projectId, debounced, sourceLanguageId, languageId),
    enabled: searching,
  });

  const stringMatchesQuery = useQuery({
    queryKey: ["tm-matches", projectId, stringId, languageId],
    queryFn: () => api.getTmMatches(projectId, stringId as number, languageId),
    enabled: stringId != null && !searching,
  });

  return (
    <div className="tm-panel">
      <div className="search-input-wrap">
        <input
          className="glossary-search-input"
          type="text"
          placeholder="Search translation memory…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {search && (
          <button className="search-input-clear" onClick={() => setSearch("")} title="Clear search">
            ×
          </button>
        )}
      </div>

      <div className="suggestion-list">
        {searching ? (
          <>
            {searchQuery.isLoading && <p className="hint">Searching…</p>}
            {searchQuery.isError && <p className="error">{(searchQuery.error as Error).message}</p>}
            {searchQuery.data && searchQuery.data.matches.length === 0 && (
              <p className="hint">No matching TM segments.</p>
            )}
            {searchQuery.data?.matches.map((m, i) => (
              <TmMatchItem key={i} m={m} compareText={debounced} onJumpToMatch={onJumpToMatch} />
            ))}
          </>
        ) : stringId == null ? (
          <p className="hint">Select a string to see TM matches.</p>
        ) : stringMatchesQuery.isLoading ? (
          <p className="hint">Searching translation memory…</p>
        ) : stringMatchesQuery.isError ? (
          <p className="error">{(stringMatchesQuery.error as Error).message}</p>
        ) : stringMatchesQuery.data && stringMatchesQuery.data.matches.length === 0 ? (
          <p className="hint">No TM matches for this string.</p>
        ) : (
          stringMatchesQuery.data?.matches.map((m, i) => (
            <TmMatchItem key={i} m={m} compareText={sourceText} onJumpToMatch={onJumpToMatch} />
          ))
        )}
      </div>
    </div>
  );
}
