import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";

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
 * open. */
export function HighlightedSourceText({ projectId, stringId, languageId, text, className }: HighlightedSourceTextProps) {
  const query = useQuery({
    queryKey: ["glossary-matches", projectId, stringId, languageId],
    queryFn: () => api.getGlossaryMatches(projectId, stringId, languageId),
  });

  const terms = query.data?.matches.map((m) => m.source_term) ?? [];
  return <div className={className}>{highlightTerms(text, terms)}</div>;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightTerms(text: string, terms: string[]) {
  if (terms.length === 0) return text;

  // Longest term first, so an overlapping shorter term (e.g. "Gul'dan")
  // doesn't win over a longer one containing it (e.g. "The Hand of
  // Gul'dan") purely because of match order.
  const unique = [...new Set(terms)].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(`(${unique.map(escapeRegExp).join("|")})`, "gi");
  const parts = text.split(pattern);

  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="glossary-term-highlight">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}
