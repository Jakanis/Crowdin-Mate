import { useQuery } from "@tanstack/react-query";
import { api, type GlossaryMatch } from "../api/client";

interface HighlightedSourceTextProps {
  projectId: number;
  stringId: number;
  languageId: string;
  text: string;
  className: string;
  /** Clicking a highlighted term inserts its translation into the
   * active translation editor at the cursor — see
   * TranslationEditorHandle. Optional since not every place this
   * renders (if any, in the future) necessarily has an editor to insert
   * into. */
  onTermClick?: (targetText: string) => void;
}

/** Source text with any matching project glossary terms highlighted
 * inline, multi-word terms included — same idea as Crowdin's own
 * editor. Runs the identical query GlossaryPanel already uses
 * (queryKey ["glossary-matches", ...]), so TanStack Query dedupes
 * rather than double-fetching when both are visible at once; this is
 * what makes the (slow, first-lookup-only) concordance search happen
 * as soon as a string is focused, not gated behind opening the
 * sidebar's Glossary tab — matching how Crowdin's editor itself always
 * highlights terms in the source regardless of whether that panel is
 * open. Hovering (or focusing, for keyboard nav) a highlighted term
 * shows its translation + description in a tooltip (pure CSS, no open/
 * close state needed); clicking it pastes the translation into the
 * editor at the cursor — both match Crowdin's own behavior. */
export function HighlightedSourceText({
  projectId,
  stringId,
  languageId,
  text,
  className,
  onTermClick,
}: HighlightedSourceTextProps) {
  const query = useQuery({
    queryKey: ["glossary-matches", projectId, stringId, languageId],
    queryFn: () => api.getGlossaryMatches(projectId, stringId, languageId),
  });

  const matches = query.data?.matches ?? [];
  return <div className={className}>{renderHighlighted(text, matches, onTermClick)}</div>;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderHighlighted(text: string, matches: GlossaryMatch[], onTermClick?: (targetText: string) => void) {
  if (matches.length === 0) return text;

  // Longest term first, so an overlapping shorter term (e.g. "Gul'dan")
  // doesn't win over a longer one containing it (e.g. "The Hand of
  // Gul'dan") purely because of match order. First match wins when the
  // same term text appears more than once (e.g. two glossaries with the
  // same entry) — good enough for a tooltip, not worth surfacing both.
  const byLowerTerm = new Map<string, GlossaryMatch>();
  for (const m of matches) {
    const key = m.source_term.toLowerCase();
    if (!byLowerTerm.has(key)) byLowerTerm.set(key, m);
  }
  const terms = [...byLowerTerm.keys()].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(`(${terms.map((t) => escapeRegExp(byLowerTerm.get(t)!.source_term)).join("|")})`, "gi");
  const parts = text.split(pattern);

  return parts.map((part, i) => {
    if (i % 2 === 0) return part;
    const match = byLowerTerm.get(part.toLowerCase());
    if (!match) return part;
    return (
      <span key={i} className="glossary-term-highlight-wrap">
        <mark
          className="glossary-term-highlight"
          role="button"
          tabIndex={0}
          title={`${match.target_term} — click to insert`}
          onClick={(e) => {
            e.stopPropagation();
            onTermClick?.(match.target_term);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onTermClick?.(match.target_term);
            }
          }}
        >
          {part}
        </mark>
        <div className="glossary-term-tooltip">
          <div className="glossary-term-tooltip-source">{match.source_term}</div>
          <div className="glossary-term-tooltip-target">{match.target_term}</div>
          {match.description && <div className="glossary-term-tooltip-description">{match.description}</div>}
          {match.glossary_name && <div className="glossary-term-tooltip-glossary">{match.glossary_name}</div>}
        </div>
      </span>
    );
  });
}
