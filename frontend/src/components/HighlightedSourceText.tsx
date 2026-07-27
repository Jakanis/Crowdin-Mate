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

interface MatchSpan {
  start: number;
  end: number;
  match: GlossaryMatch;
}

// Crowdin's own glossary concordance search (see sync_glossary_matches'
// docstring) returns matches purely on textual occurrence, with no
// awareness of OTHER matches for the same string — confirmed live on
// "The Dragonmaw Fortress is directly east of here...": it returns both
// "Dragonmaw Fortress" (the correct, specific term) AND "The Drag" (a
// wholly unrelated, genuine glossary entry for a different WoW zone —
// Orgrimmar's "The Drag" — that just happens to share its first 8
// characters with "The Dragonmaw"). A single combined regex + one
// text.split() (the previous approach) can only ever resolve overlaps
// that start at the SAME position (sorting longest-first correctly
// prefers "The Hand of Gul'dan" over "Gul'dan" there) — it can't
// resolve this case, where "The Drag" starts and matches FIRST while
// scanning left-to-right, consuming through the exact span "Dragonmaw
// Fortress" would have needed to start from, silently hiding the
// correct longer match entirely for that occurrence.
//
// Finding every occurrence of every term independently, then resolving
// overlaps by preferring the LONGEST span regardless of which one's
// text happens to start first, fixes this generally: "Dragonmaw
// Fortress" (19 chars) beats "The Drag" (8 chars) for that shared
// stretch of text, while "The Drag" still highlights normally anywhere
// it appears on its own, unrelated to a "Dragonmaw" mention.
function findAllOccurrences(text: string, byLowerTerm: Map<string, GlossaryMatch>): MatchSpan[] {
  const spans: MatchSpan[] = [];
  for (const match of byLowerTerm.values()) {
    const re = new RegExp(escapeRegExp(match.source_term), "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      spans.push({ start: m.index, end: m.index + m[0].length, match });
    }
  }
  return spans;
}

function resolveOverlaps(spans: MatchSpan[]): MatchSpan[] {
  // Longest span first; same-length ties broken by earlier start, purely
  // for stable, deterministic output rather than any semantic reason.
  const byLengthDesc = [...spans].sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
  const chosen: MatchSpan[] = [];
  for (const span of byLengthDesc) {
    if (chosen.some((c) => span.start < c.end && span.end > c.start)) continue;
    chosen.push(span);
  }
  return chosen.sort((a, b) => a.start - b.start);
}

function renderHighlighted(text: string, matches: GlossaryMatch[], onTermClick?: (targetText: string) => void) {
  if (matches.length === 0) return text;

  // First match wins when the same term text appears more than once
  // (e.g. two glossaries with the same entry) — good enough for a
  // tooltip, not worth surfacing both.
  const byLowerTerm = new Map<string, GlossaryMatch>();
  for (const m of matches) {
    const key = m.source_term.toLowerCase();
    if (!byLowerTerm.has(key)) byLowerTerm.set(key, m);
  }
  const spans = resolveOverlaps(findAllOccurrences(text, byLowerTerm));
  if (spans.length === 0) return text;

  const nodes: (string | JSX.Element)[] = [];
  let cursor = 0;
  spans.forEach((span, i) => {
    if (span.start > cursor) nodes.push(text.slice(cursor, span.start));
    const match = span.match;
    const part = text.slice(span.start, span.end);
    nodes.push(
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
          <span className="glossary-term-tooltip-source">{match.source_term}</span>
          <br />
          <span className="glossary-term-tooltip-target">{match.target_term}</span>
          {match.description && (
            <>
              <br />
              <br />
              <span className="glossary-term-tooltip-description">{match.description}</span>
            </>
          )}
          {match.glossary_name && (
            <>
              <br />
              <br />
              <span className="glossary-term-tooltip-glossary">{match.glossary_name}</span>
            </>
          )}
        </div>
      </span>,
    );
    cursor = span.end;
  });
  if (cursor < text.length) nodes.push(text.slice(cursor));

  return nodes;
}
