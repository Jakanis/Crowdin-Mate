import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";

interface TmPanelProps {
  projectId: number;
  stringId: number | null;
  languageId: string;
  onJumpToMatch?: (fileId: number, stringId: number) => void;
}

function timeAgo(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Translation Memory tab: fuzzy matches for the whole focused string
 * against the project's TM (same segment-level concordance search
 * Crowdin's own "Automated Suggestions" panel runs). Informational for
 * now — copy the target text manually into the editor; wiring a direct
 * "use this" into the editor is a natural follow-up once there's a
 * shared place to route it to.
 *
 * Crowdin's own TM panel shows who/when a match was added and lets you
 * jump to it — the concordance search API itself has no such fields
 * (only the TM segment's own updatedAt), but since this project's TM
 * mirrors real project translations, the backend reverse-looks-up the
 * same target text against another string in this project to recover
 * the real user/date, which is what matched_* below comes from (see
 * get_tm_matches in main.py). Falls back to the TM segment's own
 * updated_at when no local match is found (bulk-imported entry, or the
 * originating string isn't cached locally yet). */
export function TmPanel({ projectId, stringId, languageId, onJumpToMatch }: TmPanelProps) {
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
          {(m.matched_user_name || m.updated_at) && (
            <div className="suggestion-meta">
              {m.matched_user_name ? (
                <span>
                  {m.matched_user_name} · {timeAgo(m.matched_created_at as string)}
                </span>
              ) : (
                <span>Updated {timeAgo(m.updated_at as string)}</span>
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
      ))}
    </div>
  );
}
