import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type GlossaryMatch } from "../api/client";

interface HighlightedSourceTextProps {
  projectId: number;
  stringId: number;
  languageId: string;
  text: string;
  className: string;
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
 * open. Each highlighted term is clickable, opening a small tooltip
 * with its translation and description, also matching Crowdin. */
export function HighlightedSourceText({ projectId, stringId, languageId, text, className }: HighlightedSourceTextProps) {
  const query = useQuery({
    queryKey: ["glossary-matches", projectId, stringId, languageId],
    queryFn: () => api.getGlossaryMatches(projectId, stringId, languageId),
  });
  const [openKey, setOpenKey] = useState<string | null>(null);

  const matches = query.data?.matches ?? [];
  return (
    <div className={className}>
      {renderHighlighted(text, matches, openKey, setOpenKey)}
    </div>
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderHighlighted(
  text: string,
  matches: GlossaryMatch[],
  openKey: string | null,
  setOpenKey: (key: string | null) => void,
) {
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
    const key = `${i}-${part}`;
    return (
      <span key={i} className="glossary-term-highlight-wrap">
        <mark
          className="glossary-term-highlight"
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            setOpenKey(openKey === key ? null : key);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setOpenKey(openKey === key ? null : key);
            }
          }}
        >
          {part}
        </mark>
        {openKey === key && (
          <GlossaryTermTooltip match={match} onClose={() => setOpenKey(null)} />
        )}
      </span>
    );
  });
}

function GlossaryTermTooltip({ match, onClose }: { match: GlossaryMatch; onClose: () => void }) {
  return (
    <>
      <div className="glossary-term-tooltip-backdrop" onClick={onClose} />
      <div className="glossary-term-tooltip" onClick={(e) => e.stopPropagation()}>
        <div className="glossary-term-tooltip-source">{match.source_term}</div>
        <div className="glossary-term-tooltip-target">{match.target_term}</div>
        {match.description && <div className="glossary-term-tooltip-description">{match.description}</div>}
        {match.glossary_name && <div className="glossary-term-tooltip-glossary">{match.glossary_name}</div>}
      </div>
    </>
  );
}
