import { useEffect, useRef, useState } from "react";
import type { TreeFile } from "../api/client";

interface TabBarProps {
  openFiles: TreeFile[];
  activeFileId: number | null;
  onSelectTab: (fileId: number) => void;
  onCloseTab: (fileId: number) => void;
  onReorderTabs: (draggedFileId: number, targetFileId: number) => void;
  orientation?: "horizontal" | "vertical";
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
export function TabBar({
  openFiles,
  activeFileId,
  onSelectTab,
  onCloseTab,
  onReorderTabs,
  orientation = "horizontal",
}: TabBarProps) {
  const [draggedId, setDraggedId] = useState<number | null>(null);
  const [dragOverId, setDragOverId] = useState<number | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const tabRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const scrollRef = useRef<HTMLDivElement>(null);

  // Whichever tab becomes active — clicked directly, jumped to via the
  // picker, or reached via Ctrl+Shift+arrows in App.tsx — scrolls into
  // view within its own strip, so switching tabs never silently leaves
  // you looking at a highlighted tab that's actually scrolled off-screen.
  useEffect(() => {
    if (activeFileId == null) return;
    tabRefs.current.get(activeFileId)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeFileId]);

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
  // every scroll/wheel event) to know which edge fade(s) to show.
  useEffect(() => {
    if (orientation !== "horizontal") return;
    const el = scrollRef.current;
    if (!el) return;

    const updateFades = () => {
      setCanScrollLeft(el.scrollLeft > 0);
      setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 1);
    };
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return;
      el.scrollLeft += e.deltaY;
      e.preventDefault();
    };

    updateFades();
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("scroll", updateFades);
    const observer = new ResizeObserver(updateFades);
    observer.observe(el);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("scroll", updateFades);
      observer.disconnect();
    };
  }, [orientation, openFiles]);

  if (openFiles.length === 0) return null;

  const renderTab = (f: TreeFile) => (
    <div
      key={f.id}
      ref={(el) => {
        if (el) tabRefs.current.set(f.id, el);
        else tabRefs.current.delete(f.id);
      }}
      className={`tab${f.id === activeFileId ? " tab--active" : ""}${dragOverId === f.id ? " tab--drag-over" : ""}`}
      draggable
      onDragStart={(e) => {
        setDraggedId(f.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(e) => {
        if (draggedId == null || draggedId === f.id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDragOverId(f.id);
      }}
      onDragLeave={() => setDragOverId((prev) => (prev === f.id ? null : prev))}
      onDrop={(e) => {
        e.preventDefault();
        if (draggedId != null && draggedId !== f.id) onReorderTabs(draggedId, f.id);
        setDraggedId(null);
        setDragOverId(null);
      }}
      onDragEnd={() => {
        setDraggedId(null);
        setDragOverId(null);
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
      <span className="tab-name">{f.name}</span>
      <button
        className="tab-close"
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

  if (orientation === "vertical") {
    return <div className="tab-bar tab-bar--vertical">{openFiles.map((f) => renderTab(f))}</div>;
  }

  return (
    <div className="tab-bar-row">
      <div className="tab-bar-scroll-wrap">
        <div className="tab-bar" ref={scrollRef}>
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
                    <span className="tab-name">{f.name}</span>
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
