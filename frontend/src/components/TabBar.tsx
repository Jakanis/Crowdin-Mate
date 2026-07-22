import type { TreeFile } from "../api/client";

interface TabBarProps {
  openFiles: TreeFile[];
  activeFileId: number | null;
  onSelectTab: (fileId: number) => void;
  onCloseTab: (fileId: number) => void;
}

/** Browser-tab-like bar for files open at once — supports opening a
 * whole quest chain up front and working through it one file at a time
 * without losing your place in the others. Matches the "Pin tab" button
 * Crowdin's own editor has for the same reason. */
export function TabBar({ openFiles, activeFileId, onSelectTab, onCloseTab }: TabBarProps) {
  if (openFiles.length === 0) return null;

  return (
    <div className="tab-bar">
      {openFiles.map((f) => (
        <div
          key={f.id}
          className={`tab${f.id === activeFileId ? " tab--active" : ""}`}
          onClick={() => onSelectTab(f.id)}
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
