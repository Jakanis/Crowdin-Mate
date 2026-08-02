import { useRef, useState } from "react";
import { createPortal } from "react-dom";
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

function hasCounts(p: ProgressInfo): boolean {
  return p.phrases_total != null && p.words_total != null;
}

/** One unit's block, laid out like Crowdin's own progress popover: the unit
 * name heads the label column, Todo and Done are the two number columns.
 *
 * Todo is derived rather than stored — the API reports what's done, and
 * "how much is left" is the question a progress indicator is actually being
 * asked. */
function UnitTable({
  unit, total, translated, approved,
}: { unit: string; total: number; translated: number; approved: number }) {
  const n = (v: number) => v.toLocaleString();
  return (
    <table className="progress-card-table">
      <thead>
        <tr>
          <th>{unit}</th>
          <th>Todo</th>
          <th>Done</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td className="progress-card-label progress-card-label--translated">Translated</td>
          <td>{n(Math.max(0, total - translated))}</td>
          <td>{n(translated)}</td>
        </tr>
        <tr>
          <td className="progress-card-label progress-card-label--approved">Approved</td>
          <td>{n(Math.max(0, total - approved))}</td>
          <td>{n(approved)}</td>
        </tr>
      </tbody>
      <tfoot>
        <tr>
          <td colSpan={3} className="progress-card-total">Total: {n(total)}</td>
        </tr>
      </tfoot>
    </table>
  );
}

function ProgressCard({ progress: p, x, y }: { progress: ProgressInfo; x: number; y: number }) {
  return (
    <div className="progress-card" style={{ left: x, top: y }} role="tooltip">
      <div className="progress-card-head">
        {p.translation_progress}% translated, {p.approval_progress}% approved
      </div>
      <UnitTable
        unit="Strings"
        total={p.phrases_total ?? 0}
        translated={p.phrases_translated ?? 0}
        approved={p.phrases_approved ?? 0}
      />
      <UnitTable
        unit="Words"
        total={p.words_total ?? 0}
        translated={p.words_translated ?? 0}
        approved={p.words_approved ?? 0}
      />
    </div>
  );
}

const CARD_W = 210;
const CARD_H = 230;

/** Hover card wrapper for a progress indicator.
 *
 * A native `title` can't do this — it's plain text, and its proportional
 * font won't hold columns aligned. So this renders a real element, into a
 * portal on document.body: every one of these sits inside a scroll
 * container with `overflow` set (the virtualized file tree, the tab bar),
 * which would otherwise clip the card.
 *
 * Falls back to a plain `title` when counts are missing — rows cached
 * before those columns existed have none, and an empty table would say
 * less than the percentages alone. */
export function ProgressHover({
  progress, className, children,
}: { progress: ProgressInfo; className?: string; children: React.ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  if (!hasCounts(progress)) {
    return (
      <span className={className} title={progressTitle(progress)}>
        {children}
      </span>
    );
  }

  const show = () => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Flip toward whichever side has room, so a card on a tab at the far
    // right or a deep tree row near the bottom stays fully on screen.
    const x = Math.min(r.left, window.innerWidth - CARD_W - 8);
    const y = r.bottom + CARD_H > window.innerHeight ? r.top - CARD_H - 6 : r.bottom + 6;
    setPos({ x: Math.max(8, x), y: Math.max(8, y) });
  };

  return (
    <span
      ref={ref}
      className={className}
      onMouseEnter={show}
      onMouseLeave={() => setPos(null)}
    >
      {children}
      {pos && createPortal(<ProgressCard progress={progress} x={pos.x} y={pos.y} />, document.body)}
    </span>
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
      <ProgressHover progress={progress} className="progress-mark">
        ✓
      </ProgressHover>
    );
  }

  const size = 20;
  const r = size / 4;
  const circumference = 2 * Math.PI * r;
  const dash = (pct: number) => `${(circumference * pct) / 100} ${circumference}`;

  // The class goes on the HOVER WRAPPER, not just the svg. ProgressHover
  // renders a span around its children, so margin-left:auto on the svg only
  // ever pushed it within a span already shrunk to fit it — leaving the pie
  // sitting against the filename while folder bars, which do pass their
  // class through here, sat at the right edge.
  return (
    <ProgressHover progress={progress} className="progress-pie-wrap">
    <svg className="progress-pie" viewBox={`0 0 ${size} ${size}`}>
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
    </ProgressHover>
  );
}
