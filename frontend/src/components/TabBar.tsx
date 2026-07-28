import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import type { ProgressInfo, TreeFile } from "../api/client";
import { progressTitle } from "./ProgressPie";

interface TabBarProps {
  openFiles: TreeFile[];
  activeFileId: number | null;
  onSelectTab: (fileId: number) => void;
  onCloseTab: (fileId: number) => void;
  onReorderTabs: (draggedFileId: number, targetFileId: number, side: "before" | "after") => void;
  orientation?: "horizontal" | "vertical";
  // Translation/approval progress per open file, keyed by file id — see
  // useOpenFilesProgress. Undefined (not just an empty Map) while the
  // caller hasn't wired progress in at all, vs. a Map simply missing an
  // entry once a fetch is still in flight for that file's directory.
  fileProgress?: Map<number, ProgressInfo>;
}

/** Browser-tab-like bar for files open at once — supports opening a
 * whole quest chain up front and working through it one file at a time
 * without losing your place in the others. Matches the "Pin tab" button
 * Crowdin's own editor has for the same reason. Tabs are also
 * drag-reorderable (native HTML5 DnD, no library needed) — order lives
 * in openFiles itself, so App.tsx's existing tab-persistence effect
 * picks up a reorder for free.
 *
 * Two orientations: "horizontal" (default, above the editor) scrolls
 * its own region — every open tab stays in the same strip in the same
 * order, none folded away, you just scroll (plain mouse wheel, drag,
 * trackpad) to reach ones off the edge. A soft fade at whichever edge
 * still has more tabs hints there's more to scroll to — the tab
 * underneath it stays genuinely clickable (the fade is purely visual,
 * pointer-events: none in CSS), so clicking straight into that sliver
 * jumps to it like any other tab. The "▾" picker next to it lists every
 * open tab regardless of scroll position, for jumping straight to one
 * without hunting for it. "vertical" (opt-in via Settings, rendered
 * inside the left sidebar below the file tree, like a browser's
 * vertical-tabs mode) just grows a scrollable list the same way — no
 * picker or fade needed there, since the whole list is already one
 * glance away. */
// Matches .tab-close's own width in styles.css — kept as a constant here
// (rather than measured off a DOM ref) since it only ever needs to be
// approximately right: the width below which we protect against an
// accidental close, not a pixel-exact hit-test.
const CLOSE_BTN_WIDTH = 26;
// Extra scroll past whatever brought a tab fully into view, so the next
// tab's edge still peeks in rather than landing flush with the strip's
// own edge — reinforces "there's more here" the same way the fade does,
// instead of a click quietly hiding the very affordance that triggered it.
// Tied to CLOSE_BTN_WIDTH (1.5x) rather than its own arbitrary number, so
// the peek is always comfortably wider than the sliver the close-button
// guard above treats as "too narrow to close" — the point of peeking is
// to reveal enough of the next tab to read, not just its close button.
const TAB_PEEK_PX = CLOSE_BTN_WIDTH * 1.5;

// Steps of 10 rather than a continuous fill, so telling "almost done"
// from "actually done" never requires zooming in or hovering for the
// exact percentage (the tooltip still has that, for whoever wants it).
// Floors rather than rounds — same reasoning as _percent() on the
// backend (progress_sync.py): rounding 99% up to the 100% bucket would
// claim a file is fully done when one string genuinely isn't yet.
function bucketPercent(pct: number): number {
  return Math.floor(pct / 10) * 10;
}

// A thin vertical strip along the tab's left edge rather than a pie/
// checkmark icon competing with the name and close button for room in an
// already-tight strip. Same single-bar overlay as before — green
// (approval) from the bottom up to its own bucket, blue (translation)
// continuing from there up to its bucket, on a neutral track — just
// fed bucketed 10%-step values instead of the raw percentages, so
// "almost done" reads as visibly different from "done" without needing
// to zoom in or hover for the exact number.
function TabProgressStrip({ progress }: { progress: ProgressInfo }) {
  const { translation_progress: t, approval_progress: a } = progress;
  const tb = bucketPercent(t);
  const ab = bucketPercent(a);
  return (
    <span className="tab-progress-strip" title={progressTitle(progress)}>
      <span className="tab-progress-strip-translated" style={{ bottom: `${ab}%`, height: `${tb - ab}%` }} />
      <span className="tab-progress-strip-approved" style={{ height: `${ab}%` }} />
    </span>
  );
}

function dirSegments(file: TreeFile): string[] {
  return file.path.split("/").filter(Boolean).slice(0, -1);
}

// Two files with the same name but different folders (a common Crowdin
// pattern — the same quest/item name reused across expansions, e.g.
// gossip_tbc/B/ and chats_tbc/B/ both holding a "Borak Son of Oronok"
// file) otherwise show up as identical, indistinguishable tabs. Trims
// away whatever directory segments the whole same-name group already
// agrees on — both a common leading part (rare) and a common trailing
// part right above the filename (the usual case, like the shared "B"
// subfolder above) — collapsing each into a bare ".." (no surrounding
// slashes — this is a compact label, not a real path) and keeping only
// the segment(s) that actually differ: "gossip_tbc..Borak Son of
// Oronok_21293.xml" vs. "chats_tbc..Borak Son of Oronok_21293.xml".
function disambiguatedLabel(file: TreeFile, group: TreeFile[]): string {
  if (group.length <= 1) return file.name;

  const mySegs = dirSegments(file);
  const allSegs = group.map(dirSegments);
  const minLen = Math.min(...allSegs.map((s) => s.length));

  let prefixLen = 0;
  while (prefixLen < minLen && allSegs.every((s) => s[prefixLen] === mySegs[prefixLen])) {
    prefixLen++;
  }

  let suffixLen = 0;
  while (
    suffixLen < minLen - prefixLen &&
    allSegs.every((s) => s[s.length - 1 - suffixLen] === mySegs[mySegs.length - 1 - suffixLen])
  ) {
    suffixLen++;
  }

  const middle = mySegs.slice(prefixLen, mySegs.length - suffixLen);
  if (prefixLen === 0 && middle.length === 0 && suffixLen === 0) return file.name;

  // Real path segments join with "/"; a collapsed-common run glues
  // directly onto its neighbor with no slash, since ".." itself already
  // reads as a separator (that's the whole point of shortening it).
  const bits = [...(prefixLen > 0 ? [".."] : []), ...middle, ...(suffixLen > 0 ? [".."] : []), file.name];
  let label = "";
  for (let i = 0; i < bits.length; i++) {
    if (i > 0 && bits[i] !== ".." && bits[i - 1] !== "..") label += "/";
    label += bits[i];
  }
  return label;
}

export function TabBar({
  openFiles,
  activeFileId,
  onSelectTab,
  onCloseTab,
  onReorderTabs,
  orientation = "horizontal",
  fileProgress,
}: TabBarProps) {
  const [draggedId, setDraggedId] = useState<number | null>(null);
  // Which side of the hovered tab the dragged tab would land on — shown
  // as a thin line right at that edge (the actual boundary between two
  // tabs) rather than highlighting the hovered tab's own border, which
  // said "here" but not "before or after this one". Side is recomputed
  // from cursor position on every dragover, not inferred from drag
  // direction, so what's drawn always matches exactly where it'll drop.
  const [dragOver, setDragOver] = useState<{ id: number; side: "before" | "after" } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  // Tabs whose currently-visible sliver is too narrow to safely carry a
  // separately-clickable close button — see the close button's own
  // onClick below for what "too narrow" does instead of closing.
  const [closeBlockedIds, setCloseBlockedIds] = useState<Set<number>>(new Set());

  const tabRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const scrollRef = useRef<HTMLDivElement>(null);

  // Only disambiguates within the currently open set — a same-named file
  // sitting elsewhere in the project that isn't open right now is no
  // source of confusion, so it shouldn't cost every tab extra path noise.
  const tabLabels = useMemo(() => {
    const byName = new Map<string, TreeFile[]>();
    for (const f of openFiles) {
      const group = byName.get(f.name);
      if (group) group.push(f);
      else byName.set(f.name, [f]);
    }
    const labels = new Map<number, string>();
    for (const f of openFiles) {
      labels.set(f.id, disambiguatedLabel(f, byName.get(f.name)!));
    }
    return labels;
  }, [openFiles]);

  // Whichever tab becomes active — clicked directly, jumped to via the
  // picker, or reached via Ctrl+Shift+arrows in App.tsx — scrolls into
  // view within its own strip, so switching tabs never silently leaves
  // you looking at a highlighted tab that's actually scrolled off-screen.
  // Horizontal mode deliberately doesn't use scrollIntoView: that stops
  // the instant the tab is flush with the edge, which can leave the
  // strip looking like it has no more tabs beyond it. Scrolling TAB_PEEK_PX
  // further keeps the next tab (or the fade over it) visibly peeking in.
  useEffect(() => {
    if (activeFileId == null) return;
    const tab = tabRefs.current.get(activeFileId);
    if (!tab) return;

    if (orientation !== "horizontal") {
      tab.scrollIntoView({ block: "nearest", inline: "nearest" });
      return;
    }
    const container = scrollRef.current;
    if (!container) return;
    const tabLeft = tab.offsetLeft;
    const tabRight = tabLeft + tab.offsetWidth;
    const viewLeft = container.scrollLeft;
    const viewRight = viewLeft + container.clientWidth;
    if (tabLeft < viewLeft) {
      container.scrollLeft = Math.max(0, tabLeft - TAB_PEEK_PX);
    } else if (tabRight > viewRight) {
      container.scrollLeft = Math.min(
        container.scrollWidth - container.clientWidth,
        tabRight - container.clientWidth + TAB_PEEK_PX,
      );
    }
  }, [activeFileId, orientation]);

  // Plain vertical wheel scrolls this strip horizontally — without this,
  // a normal mouse (no horizontal wheel, no Shift held) can't scroll it
  // at all, since a plain overflow-x: auto region only responds to
  // Shift+wheel or an actual horizontal scroll gesture by default. Native
  // addEventListener with { passive: false } rather than JSX's onWheel:
  // React registers wheel listeners as passive by default (a Chrome-
  // driven change from React 17 on), which silently no-ops
  // preventDefault() inside a handler passed via onWheel.
  //
  // Also tracks scroll position (mount, resize, tab-set changes, and
  // every scroll/wheel event) to know which edge fade(s) to show, and
  // which tabs currently show too little of themselves to safely carry
  // a separately-clickable close button (see the close button below).
  useEffect(() => {
    if (orientation !== "horizontal") return;
    const el = scrollRef.current;
    if (!el) return;

    const updateScrollState = () => {
      setCanScrollLeft(el.scrollLeft > 0);
      setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 1);

      const viewLeft = el.scrollLeft;
      const viewRight = viewLeft + el.clientWidth;
      const blocked = new Set<number>();
      for (const [fileId, tab] of tabRefs.current) {
        const tabLeft = tab.offsetLeft;
        const tabRight = tabLeft + tab.offsetWidth;
        const visibleWidth = Math.min(tabRight, viewRight) - Math.max(tabLeft, viewLeft);
        if (visibleWidth < CLOSE_BTN_WIDTH * 2) blocked.add(fileId);
      }
      setCloseBlockedIds(blocked);
    };
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return;
      el.scrollLeft += e.deltaY;
      e.preventDefault();
    };

    updateScrollState();
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("scroll", updateScrollState);
    const observer = new ResizeObserver(updateScrollState);
    observer.observe(el);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("scroll", updateScrollState);
      observer.disconnect();
    };
  }, [orientation, openFiles]);

  if (openFiles.length === 0) return null;

  const renderTab = (f: TreeFile) => {
    const progress = fileProgress?.get(f.id);
    return (
    <div
      key={f.id}
      ref={(el) => {
        if (el) tabRefs.current.set(f.id, el);
        else tabRefs.current.delete(f.id);
      }}
      className={`tab${f.id === activeFileId ? " tab--active" : ""}`}
      draggable
      onDragStart={(e) => {
        setDraggedId(f.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(e) => {
        if (draggedId == null || draggedId === f.id) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const side: "before" | "after" =
          orientation === "vertical"
            ? e.clientY - rect.top < rect.height / 2
              ? "before"
              : "after"
            : e.clientX - rect.left < rect.width / 2
              ? "before"
              : "after";

        // Dropping "after" the tab immediately to the dragged tab's own
        // left, or "before" the one immediately to its right, would just
        // reinsert it exactly where it already sits — not a real move, so
        // don't offer it: no marker, and no preventDefault() means the
        // browser falls back to its own "not allowed" cursor instead of
        // "move".
        const draggedIdx = openFiles.findIndex((x) => x.id === draggedId);
        const targetIdx = openFiles.findIndex((x) => x.id === f.id);
        const isNoOp =
          (side === "after" && targetIdx === draggedIdx - 1) ||
          (side === "before" && targetIdx === draggedIdx + 1);
        if (isNoOp) {
          setDragOver((prev) => (prev?.id === f.id ? null : prev));
          return;
        }

        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDragOver((prev) => (prev?.id === f.id && prev.side === side ? prev : { id: f.id, side }));
      }}
      onDragLeave={() => setDragOver((prev) => (prev?.id === f.id ? null : prev))}
      onDrop={(e) => {
        e.preventDefault();
        if (draggedId != null && dragOver?.id === f.id) onReorderTabs(draggedId, f.id, dragOver.side);
        setDraggedId(null);
        setDragOver(null);
      }}
      onDragEnd={() => {
        setDraggedId(null);
        setDragOver(null);
      }}
      onClick={() => onSelectTab(f.id)}
      onMouseDown={(e) => {
        // Chromium starts its middle-click autoscroll on mousedown,
        // before click/auxclick ever fires — preventDefault() in the
        // auxclick handler below is too late to stop it. Has to be
        // stopped here instead.
        if (e.button === 1) e.preventDefault();
      }}
      onAuxClick={(e) => {
        // Middle-click closes the tab, matching real browser tabs —
        // auxclick is the correct event for non-primary buttons
        // (click only fires for the primary/left button).
        if (e.button === 1) {
          e.preventDefault();
          onCloseTab(f.id);
        }
      }}
      title={f.path}
    >
      {dragOver?.id === f.id && <span className={`tab-drop-indicator tab-drop-indicator--${dragOver.side}`} />}
      {progress && <TabProgressStrip progress={progress} />}
      <span className="tab-name">{tabLabels.get(f.id) ?? f.name}</span>
      <button
        className={`tab-close${closeBlockedIds.has(f.id) ? " tab-close--blocked" : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          onCloseTab(f.id);
        }}
        title="Close"
      >
        ×
      </button>
    </div>
    );
  };

  // The 2px flex gap between tabs (where the drop-position line itself
  // visually sits) has no element under it at all — the tabs' own
  // onDragOver never fires there since neither tab's box actually covers
  // those pixels — so without this, that sliver was a dead zone where the
  // browser fell back to its default "not allowed" cursor despite the
  // line pointing right at it. Only engages when the pointer is directly
  // over the container's own background (not bubbled up from a tab —
  // that's the tabs' own handler's job) and simply keeps whatever
  // dragOver a neighboring tab last set, since the gap is far too narrow
  // for the target to have genuinely changed since then.
  const onGapDragOver = (e: DragEvent) => {
    if (e.target !== e.currentTarget || draggedId == null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };
  const onGapDrop = (e: DragEvent) => {
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    if (draggedId != null && dragOver != null) onReorderTabs(draggedId, dragOver.id, dragOver.side);
    setDraggedId(null);
    setDragOver(null);
  };

  if (orientation === "vertical") {
    return (
      <div className="tab-bar tab-bar--vertical" onDragOver={onGapDragOver} onDrop={onGapDrop}>
        {openFiles.map((f) => renderTab(f))}
      </div>
    );
  }

  return (
    <div className="tab-bar-row">
      <div className="tab-bar-scroll-wrap">
        <div className="tab-bar" ref={scrollRef} onDragOver={onGapDragOver} onDrop={onGapDrop}>
          {openFiles.map((f) => renderTab(f))}
        </div>
        <div className={`tab-bar-fade tab-bar-fade--left${canScrollLeft ? " tab-bar-fade--visible" : ""}`} />
        <div className={`tab-bar-fade tab-bar-fade--right${canScrollRight ? " tab-bar-fade--visible" : ""}`} />
      </div>
      {openFiles.length > 1 && (
        <div className="tab-picker">
          <button
            className="tab-picker-btn"
            onClick={() => setPickerOpen((v) => !v)}
            title="Switch tabs"
            aria-expanded={pickerOpen}
          >
            ▾
          </button>
          {pickerOpen && (
            <>
              <div className="tab-picker-backdrop" onClick={() => setPickerOpen(false)} />
              <div className="tab-picker-menu">
                {openFiles.map((f) => (
                  <button
                    key={f.id}
                    className={`tab-picker-item${f.id === activeFileId ? " tab-picker-item--active" : ""}`}
                    onClick={() => {
                      onSelectTab(f.id);
                      setPickerOpen(false);
                    }}
                    title={f.path}
                  >
                    <span className="tab-name">{tabLabels.get(f.id) ?? f.name}</span>
                    <span
                      className="tab-picker-close"
                      onClick={(e) => {
                        e.stopPropagation();
                        onCloseTab(f.id);
                      }}
                      title="Close"
                    >
                      ×
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
