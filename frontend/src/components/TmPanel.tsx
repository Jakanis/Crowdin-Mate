import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";

interface TmPanelProps {
  projectId: number;
  stringId: number | null;
  languageId: string;
}

/** Translation Memory tab: fuzzy matches for the whole focused string
 * against the project's TM (same segment-level concordance search
 * Crowdin's own "Automated Suggestions" panel runs). Informational for
 * now — copy the target text manually into the editor; wiring a direct
 * "use this" into the editor is a natural follow-up once there's a
 * shared place to route it to. */
export function TmPanel({ projectId, stringId, languageId }: TmPanelProps) {
  const query = useQuery({
    queryKey: ["tm-matches", projectId, stringId, languageId],
    queryFn: () => api.getTmMatches(projectId, stringId as number, languageId),
    enabled: stringId != null,
  });

  if (stringId == null) return <p className="hint">Select a string to see TM matches.</p>;
  if (query.isLoading) return <p className="hint">Searching translation memory…</p>;
  if (query.isError) return <p className="error">{(query.error as Error).message}</p>;
  if (query.data && query.data.matches.length === 0) {
    return <p className="hint">No TM matches for this string.</p>;
  }

  return (
    <div className="suggestion-list">
      {query.data?.matches.map((m, i) => (
        <div key={i} className="suggestion-item">
          <div className="suggestion-header">
            <span className="suggestion-relevance">{m.relevant}%</span>
            {m.tm_name && <span className="suggestion-source-name">{m.tm_name}</span>}
          </div>
          <div className="suggestion-source">{m.source_text}</div>
          <div className="suggestion-target">{m.target_text}</div>
        </div>
      ))}
    </div>
  );
}
