import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { usePanelDraft } from "../panelDrafts";

interface GlossaryPanelProps {
  projectId: number;
  stringId: number | null;
  languageId: string;
  sourceLanguageId: string;
  /** Bucket this panel's typed-in query survives in while the sidebar is
   * collapsed — see panelDrafts.ts. */
  draftKey: string;
}

const DEBOUNCE_MS = 300;

/** Glossary tab: two modes sharing one panel. With the search box empty,
 * shows terms found in the focused string's source text (concordance
 * search against the whole segment, so multi-word terms match too — see
 * suggestions_sync.py; same matches are also highlighted inline in the
 * source text itself, see HighlightedSourceText.tsx). Typing a query
 * switches to browsing/searching the WHOLE project glossary instead —
 * that needs an explicit one-time sync first (glossary_sync.py, tens of
 * seconds for a project this size), after which it runs entirely
 * offline against the local cache, unlike the per-string lookup above
 * which always hits Crowdin live. */
export function GlossaryPanel({ projectId, stringId, languageId, sourceLanguageId, draftKey }: GlossaryPanelProps) {
  const queryClient = useQueryClient();
  const [search, setSearch] = usePanelDraft(`${draftKey}:glossary-search`, "");
  // Seeded from the restored query — same reasoning as TmPanel's.
  const [debounced, setDebounced] = useState(search);

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(search), DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [search]);

  const searching = debounced.trim().length > 0;

  const statusQuery = useQuery({
    queryKey: ["glossary-status", projectId],
    queryFn: () => api.getGlossaryStatus(projectId),
  });

  const syncMutation = useMutation({
    mutationFn: () => api.syncGlossary(projectId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["glossary-status", projectId] }),
  });

  const searchQuery = useQuery({
    queryKey: ["glossary-search", projectId, sourceLanguageId, languageId, debounced],
    queryFn: () => api.searchGlossary(projectId, debounced, sourceLanguageId, languageId),
    enabled: searching,
  });

  const stringMatchesQuery = useQuery({
    queryKey: ["glossary-matches", projectId, stringId, languageId],
    queryFn: () => api.getGlossaryMatches(projectId, stringId as number, languageId),
    enabled: stringId != null && !searching,
  });

  const status = statusQuery.data;

  return (
    <div className="glossary-panel">
      <div className="search-input-wrap">
        <input
          className="glossary-search-input"
          type="text"
          placeholder="Search glossary…"
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
            {searchQuery.data && searchQuery.data.results.length === 0 && (
              <p className="hint">
                No matching terms{!status?.terms && " — try syncing the glossary below first"}.
              </p>
            )}
            {searchQuery.data?.results.map((m) => (
              <div key={m.concept_id} className="suggestion-item">
                <div className="suggestion-source">{m.source_term}</div>
                <div className="suggestion-target">{m.target_term}</div>
                {m.description && <div className="suggestion-description">{m.description}</div>}
              </div>
            ))}
          </>
        ) : stringId == null ? (
          <p className="hint">Select a string to see glossary terms.</p>
        ) : stringMatchesQuery.isLoading ? (
          <p className="hint">Checking glossary…</p>
        ) : stringMatchesQuery.isError ? (
          <p className="error">{(stringMatchesQuery.error as Error).message}</p>
        ) : stringMatchesQuery.data && stringMatchesQuery.data.matches.length === 0 ? (
          <p className="hint">No glossary terms in this string.</p>
        ) : (
          stringMatchesQuery.data?.matches.map((m, i) => (
            <div key={i} className="suggestion-item">
              <div className="suggestion-source">{m.source_term}</div>
              <div className="suggestion-target">{m.target_term}</div>
              {m.description && <div className="suggestion-description">{m.description}</div>}
            </div>
          ))
        )}
      </div>

      <div className="glossary-sync-status">
        <span className="hint">
          {status?.terms ? `${status.terms.toLocaleString()} terms synced for offline search` : "Search above needs a one-time sync"}
        </span>
        <button onClick={() => syncMutation.mutate()} disabled={syncMutation.isPending}>
          {syncMutation.isPending ? "Syncing…" : status?.terms ? "Re-sync" : "Sync glossary"}
        </button>
      </div>
    </div>
  );
}
