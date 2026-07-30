import type { ProgressInfo } from "../api/client";

// Matches Crowdin's own color convention: blue for translated, green for
// approved. Approved is always a subset of translated, so both bar and
// pie encode it as a single layered indicator — green from 0 to approved%,
// blue from approved% to translated%, a neutral track for the rest —
// rather than two separate indicators. That layering also means "fully
// translated and approved" naturally renders as solid green with no
// special-casing needed... except we still collapse it to a small mark
// below, since the goal is decluttering an otherwise-solid-color pill/
// circle that no longer carries any information once there's nothing
// left incomplete.
//
// Colors come from CSS variables (--progress-translated/--progress-
// approved, defined in styles.css) rather than fixed hex here, so they
// can differ between light and dark theme — a green tuned dark enough
// to stay distinct from blue on a white background reads as almost
// invisible on a near-black one, so each theme needs its own pair.
const TRANSLATED_COLOR = "var(--progress-translated)";
const APPROVED_COLOR = "var(--progress-approved)";
const TRACK_COLOR = "rgba(128, 128, 128, 0.18)";

/** Percentages alone can't answer "how much is left" — 99% of a 5-string
 * file and 99% of a 900-string one are very different amounts of work — so
 * the raw counts go in the tooltip behind them. Words as well as strings,
 * since word count is the fairer measure when file sizes vary this much.
 * Both breakdowns already arrive in the progress response (see _counts in
 * progress_sync.py), so this costs no extra request.
 *
 * Counts are optional: rows cached before those columns existed have none,
 * and fall back to the percentages-only form rather than rendering
 * "undefined". */
export function progressTitle(p: ProgressInfo): string {
  const head = `${p.translation_progress}% translated, ${p.approval_progress}% approved`;
  if (p.phrases_total == null || p.words_total == null) return head;
  const n = (v: number) => v.toLocaleString();
  const line = (label: string, translated: number, approved: number, total: number) =>
    `${label} ${n(translated)}/${n(total)} translated, ${n(approved)}/${n(total)} approved`;
  return (
    `${head}\n` +
    `${line("Strings:", p.phrases_translated ?? 0, p.phrases_approved ?? 0, p.phrases_total)}\n` +
    `${line("Words:  ", p.words_translated ?? 0, p.words_approved ?? 0, p.words_total)}`
  );
}

// Built from stacked solid-stroke circles rather than a conic-gradient —
// see the note above .progress-bar in styles.css for why. A circle
// stroked at half its own radius, with stroke-width equal to that
// radius, fills the wedge from center to edge exactly like a pie slice;
// stroke-dasharray/dashoffset then trims that ring down to a percentage.
//
// Shared between FileTree's file rows and TabBar's tabs — same shape of
// data (ProgressInfo), same "fully done collapses to a checkmark" rule.
export function ProgressPie({ progress }: { progress: ProgressInfo }) {
  const { translation_progress: t, approval_progress: a } = progress;

  if (t === 100 && a === 100) {
    return (
      <span className="progress-mark" title={progressTitle(progress)}>
        ✓
      </span>
    );
  }

  const size = 20;
  const r = size / 4;
  const circumference = 2 * Math.PI * r;
  const dash = (pct: number) => `${(circumference * pct) / 100} ${circumference}`;

  return (
    <svg className="progress-pie" viewBox={`0 0 ${size} ${size}`}>
      <title>{progressTitle(progress)}</title>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={TRACK_COLOR} strokeWidth={size / 2} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={TRANSLATED_COLOR}
        strokeWidth={size / 2}
        strokeDasharray={dash(t)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={APPROVED_COLOR}
        strokeWidth={size / 2}
        strokeDasharray={dash(a)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}
