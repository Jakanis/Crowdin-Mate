import { useState } from "react";
import type { TreeFile } from "../api/client";

interface TabBarProps {
  openFiles: TreeFile[];
  activeFileId: number | null;
  onSelectTab: (fileId: number) => void;
  onCloseTab: (fileId: number) => void;
  onReorderTabs: (draggedFileId: number, targetFileId: number) => void;
}

/** Browser-tab-like bar for files open at once — supports opening a
 * whole quest chain up front and working through it one file at a time
 * without losing your place in the others. Matches the "Pin tab" button
 * Crowdin's own editor has for the same reason. Tabs are also
 * drag-reorderable (native HTML5 DnD, no library needed) — order lives
 * in openFiles itself, so App.tsx's existing tab-persistence effect
 * picks up a reorder for free. */
export function TabBar({ openFiles, activeFileId, onSelectTab, onCloseTab, onReorderTabs }: TabBarProps) {
  const [draggedId, setDraggedId] = useState<number | null>(null);
  const [dragOverId, setDragOverId] = useState<number | null>(null);

  if (openFiles.length === 0) return null;

  return (
    <div className="tab-bar">
      {openFiles.map((f) => (
        <div
          key={f.id}
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
      ))}
    </div>
  );
}
