import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";

interface GlossaryPanelProps {
  projectId: number;
  stringId: number | null;
  languageId: string;
}

/** Glossary tab: project glossary terms found in the focused string's
 * source text (concordance search against the whole segment, so
 * multi-word terms match too — see suggestions_sync.py). Same matches
 * are also highlighted inline in the source text itself, see
 * HighlightedSourceText.tsx. */
export function GlossaryPanel({ projectId, stringId, languageId }: GlossaryPanelProps) {
  const query = useQuery({
    queryKey: ["glossary-matches", projectId, stringId, languageId],
    queryFn: () => api.getGlossaryMatches(projectId, stringId as number, languageId),
    enabled: stringId != null,
  });

  if (stringId == null) return <p className="hint">Select a string to see glossary terms.</p>;
  if (query.isLoading) return <p className="hint">Checking glossary…</p>;
  if (query.isError) return <p className="error">{(query.error as Error).message}</p>;
  if (query.data && query.data.matches.length === 0) {
    return <p className="hint">No glossary terms in this string.</p>;
  }

  return (
    <div className="suggestion-list">
      {query.data?.matches.map((m, i) => (
        <div key={i} className="suggestion-item">
          <div className="glossary-term-row">
            <strong>{m.source_term}</strong>
            <span className="glossary-arrow">→</span>
            <strong>{m.target_term}</strong>
          </div>
          {m.description && <div className="suggestion-description">{m.description}</div>}
        </div>
      ))}
    </div>
  );
}
