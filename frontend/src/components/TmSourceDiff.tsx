import { diffWords } from "diff";

interface TmSourceDiffProps {
  /** The source text actually being translated right now — the focused
   * string's own source for automatic per-string matches, or whatever
   * was typed into the search box for ad hoc TM search results. */
  currentText: string;
  /** The TM match's own source text, to diff against currentText. */
  matchText: string;
}

/** Word-level diff between a fuzzy TM match's source text and whatever
 * source text is actually being translated right now — matching
 * Crowdin's own TM panel, which shows this instead of the plain match
 * text so a translator can see at a glance what changed (a renamed
 * item, a different number, a tweaked sentence) rather than having to
 * spot it themselves by re-reading both segments side by side. Only
 * meaningful for fuzzy (< 100%) matches — an exact match has nothing to
 * diff, see the "Perfect match" label used instead in the callers. */
export function TmSourceDiff({ currentText, matchText }: TmSourceDiffProps) {
  const parts = diffWords(matchText, currentText);
  return (
    <span className="tm-source-diff">
      {parts.map((part, i) => (
        <span
          key={i}
          className={part.added ? "tm-diff-added" : part.removed ? "tm-diff-removed" : undefined}
        >
          {part.value}
        </span>
      ))}
    </span>
  );
}
