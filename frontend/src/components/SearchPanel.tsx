import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, type SearchResult } from "../api/client";

interface SearchPanelProps {
  projectId: number;
  languageId: string;
  languageName: string;
  onJumpToResult: (fileId: number, stringId: number) => void;
}

const DEBOUNCE_MS = 300;

/** Renders a snippet string with ⟦match⟧ markers (from the backend's
 * FTS5 snippet()) as <mark> spans — safer than trusting HTML from the
 * response, and lets us pick our own wrapper. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/⟦(.+?)⟧/g);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? <mark key={i}>{part}</mark> : <span key={i}>{part}</span>,
      )}
    </>
  );
}

/** Search tab content for the left sidebar: live, whole-project search via
 * Crowdin's CroQL query language (see live_search.py) — covers every file,
 * not just what's been opened. Falls back to the local FTS index
 * (whatever's cached) if the API call fails, e.g. offline — the explicit
 * opt-in "build full index" job below exists for that offline case, not
 * for search coverage in general anymore. */
export function SearchPanel({ projectId, languageId, languageName, onJumpToResult }: SearchPanelProps) {
  const queryClient = useQueryClient();
  const [input, setInput] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(input), DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [input]);

  const searchQuery = useQuery({
    queryKey: ["search", projectId, languageId, debounced],
    queryFn: () => api.searchStrings(projectId, debounced, languageId),
    enabled: debounced.trim().length > 0,
  });

  const indexStatus = useQuery({
    queryKey: ["search-index-status", projectId, languageId],
    queryFn: () => api.getSearchIndexStatus(projectId, languageId),
    refetchInterval: (query) => (query.state.data?.running ? 1000 : false),
  });

  const build = useMutation({
    mutationFn: () => api.buildSearchIndex(projectId, languageId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["search-index-status", projectId, languageId] }),
  });
  const stop = useMutation({
    mutationFn: () => api.stopSearchIndex(projectId, languageId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["search-index-status", projectId, languageId] }),
  });

  const status = indexStatus.data;
  const results = searchQuery.data?.results ?? [];

  return (
    <div className="search-panel">
      <div className="search-input-wrap">
        <input
          className="search-input"
          type="text"
          placeholder={`Search source or ${languageName} text…`}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          autoFocus
        />
        {input && (
          <button className="search-input-clear" onClick={() => setInput("")} title="Clear search">
            ×
          </button>
        )}
      </div>

      {debounced.trim().length === 0 && <p className="hint">Type to search the whole project.</p>}
      {searchQuery.isLoading && <p className="hint">Searching…</p>}
      {debounced.trim().length > 0 && searchQuery.data && results.length === 0 && (
        <p className="hint">No matches.</p>
      )}

      <div className="search-results">
        {results.map((r: SearchResult) => (
          <button
            key={r.string_id}
            className="search-result"
            onClick={() => onJumpToResult(r.file_id, r.string_id)}
          >
            <div className="search-result-path">
              {r.file_path}
              {r.identifier && <span className="string-identifier">🔑 {r.identifier}</span>}
            </div>
            <div className="search-result-source">
              <Snippet text={r.source_snippet} />
            </div>
            {r.target_snippet && (
              <div className="search-result-target">
                <Snippet text={r.target_snippet} />
              </div>
            )}
          </button>
        ))}
      </div>

      {status && (
        <div className="search-index-status">
          <div className="search-index-label">
            {status.synced.toLocaleString()} / {status.total.toLocaleString()} files indexed
            {status.running && " — building…"}
          </div>
          <div className="search-index-bar">
            <div
              className="search-index-bar-fill"
              style={{ width: `${status.total ? (status.synced / status.total) * 100 : 0}%` }}
            />
          </div>
          {status.running ? (
            <button onClick={() => stop.mutate()} disabled={stop.isPending}>
              Stop indexing
            </button>
          ) : (
            <button
              onClick={() => build.mutate()}
              disabled={build.isPending || status.synced >= status.total}
              title={
                status.synced >= status.total
                  ? undefined
                  : `Search itself already covers the whole project live — this index is only for ` +
                    `when you're offline. Building it makes one API call per remaining file ` +
                    `(${(status.total - status.synced).toLocaleString()} left) — expect this to ` +
                    `take hours, not minutes.`
              }
            >
              {status.synced >= status.total ? "Fully indexed" : "Index all files for search"}
            </button>
          )}
          {status.errors > 0 && <span className="hint">{status.errors} file(s) failed to sync</span>}
          {status.running && status.current_file_path && (
            <div className="hint search-index-current">{status.current_file_path}</div>
          )}
        </div>
      )}
    </div>
  );
}
