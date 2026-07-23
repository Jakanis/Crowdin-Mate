import { useLayoutEffect, useRef, useState } from "react";
import type { TreeFile } from "../api/client";

interface TabBarProps {
  openFiles: TreeFile[];
  activeFileId: number | null;
  onSelectTab: (fileId: number) => void;
  onCloseTab: (fileId: number) => void;
  onReorderTabs: (draggedFileId: number, targetFileId: number) => void;
  orientation?: "horizontal" | "vertical";
}

const OVERFLOW_BUTTON_WIDTH = 40;
const TAB_GAP = 2;

/** Browser-tab-like bar for files open at once — supports opening a
 * whole quest chain up front and working through it one file at a time
 * without losing your place in the others. Matches the "Pin tab" button
 * Crowdin's own editor has for the same reason. Tabs are also
 * drag-reorderable (native HTML5 DnD, no library needed) — order lives
 * in openFiles itself, so App.tsx's existing tab-persistence effect
 * picks up a reorder for free.
 *
 * Two orientations: "horizontal" (default, above the editor — this is
 * the one that can run out of room, so it measures tabs against the
 * available width and folds whatever doesn't fit into a "▾ N" dropdown
 * rather than relying on horizontal scroll) and "vertical" (opt-in via
 * Settings, rendered inside the left sidebar below the file tree, like
 * a browser's vertical-tabs mode — that one just grows a scrollable
 * list, no overflow logic needed). */
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
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [hiddenIds, setHiddenIds] = useState<Set<number>>(new Set());

  const containerRef = useRef<HTMLDivElement>(null);
  const measureRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  // The measurer below always renders every tab at natural width (off
  // screen), so this can read real widths regardless of which tabs are
  // currently visible — recomputed whenever the open-file set/order
  // changes or the available width does (window resize, side-panel
  // drag). Only the horizontal bar needs this; the vertical sidebar
  // list just scrolls, same as the file tree already does.
  useLayoutEffect(() => {
    if (orientation !== "horizontal") return;
    const container = containerRef.current;
    if (!container) return;

    const recompute = () => {
      const available = container.clientWidth;
      const widths = openFiles.map((f) => measureRefs.current.get(f.id)?.offsetWidth ?? 0);
      const totalWidth = widths.reduce((sum, w) => sum + w, 0) + Math.max(0, openFiles.length - 1) * TAB_GAP;

      if (totalWidth <= available) {
        setHiddenIds(new Set());
        return;
      }

      const budget = available - OVERFLOW_BUTTON_WIDTH;
      let used = 0;
      let fitCount = 0;
      for (let i = 0; i < widths.length; i++) {
        const next = used + widths[i] + (i > 0 ? TAB_GAP : 0);
        if (next > budget) break;
        used = next;
        fitCount++;
      }
      fitCount = Math.max(1, fitCount);

      // Keep the active tab visible even if it wouldn't naturally fall
      // within the first `fitCount` tabs — bump it in, swapping out
      // whichever fitting tab was last, rather than leaving the
      // workspace's own active file invisible in its own tab strip.
      const activeIndex = openFiles.findIndex((f) => f.id === activeFileId);
      const visibleIndexes = new Set<number>();
      for (let i = 0; i < fitCount; i++) visibleIndexes.add(i);
      if (activeIndex >= fitCount && activeIndex !== -1) {
        visibleIndexes.delete(fitCount - 1);
        visibleIndexes.add(activeIndex);
      }

      const hidden = new Set<number>();
      openFiles.forEach((f, i) => {
        if (!visibleIndexes.has(i)) hidden.add(f.id);
      });
      setHiddenIds(hidden);
    };

    recompute();
    const observer = new ResizeObserver(recompute);
    observer.observe(container);
    return () => observer.disconnect();
  }, [openFiles, activeFileId, orientation]);

  if (openFiles.length === 0) return null;

  const renderTab = (f: TreeFile, ref?: (el: HTMLDivElement | null) => void) => (
    <div
      key={f.id}
      ref={ref}
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

  const hiddenFiles = openFiles.filter((f) => hiddenIds.has(f.id));

  return (
    <div className="tab-bar-row">
      {/* Off-screen, always renders every tab at its natural width so
          overflow can be measured even for tabs currently folded into
          the dropdown below. */}
      <div className="tab-bar-measure" aria-hidden="true">
        {openFiles.map((f) =>
          renderTab(f, (el) => {
            if (el) measureRefs.current.set(f.id, el);
            else measureRefs.current.delete(f.id);
          }),
        )}
      </div>
      <div className="tab-bar" ref={containerRef}>
        {openFiles.filter((f) => !hiddenIds.has(f.id)).map((f) => renderTab(f))}
      </div>
      {hiddenFiles.length > 0 && (
        <div className="tab-overflow">
          <button
            className="tab-overflow-btn"
            onClick={() => setDropdownOpen((v) => !v)}
            title={`${hiddenFiles.length} more tab${hiddenFiles.length === 1 ? "" : "s"}`}
          >
            ▾ {hiddenFiles.length}
          </button>
          {dropdownOpen && (
            <>
              <div className="tab-overflow-backdrop" onClick={() => setDropdownOpen(false)} />
              <div className="tab-overflow-menu">
                {hiddenFiles.map((f) => (
                  <button
                    key={f.id}
                    className={`tab-overflow-item${f.id === activeFileId ? " tab-overflow-item--active" : ""}`}
                    onClick={() => {
                      onSelectTab(f.id);
                      setDropdownOpen(false);
                    }}
                    title={f.path}
                  >
                    <span className="tab-name">{f.name}</span>
                    <span
                      className="tab-overflow-close"
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
