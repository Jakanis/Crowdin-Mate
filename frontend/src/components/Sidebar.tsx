import { useEffect, useState } from "react";
import type { SourceString, TreeDirectory, TreeFile } from "../api/client";
import { FileStringsList } from "./FileStringsList";
import { FileTree } from "./FileTree";
import { SearchPanel } from "./SearchPanel";

interface SyncState {
  trigger: () => void;
  isPending: boolean;
  changed: boolean;
  progress: number | null;
}

interface SidebarProps {
  projectId: number;
  languageId: string;
  languageName: string;
  sync: SyncState;
  lastFullSyncAt: string | null;
  directories: TreeDirectory[];
  files: TreeFile[];
  onSelectFile: (file: TreeFile) => void;
  /** Passed straight through to FileTree — see its own prop doc. */
  revealRequest?: { fileId: number; n: number } | null;
  selectedFile: TreeFile | null;
  strings: SourceString[];
  focusedStringId: number | null;
  onFocusString: (stringId: number) => void;
  onJumpToSearchResult: (fileId: number, stringId: number) => void;
  width: number;
  onResizeStart: (e: React.MouseEvent) => void;
  openFilesSection?: React.ReactNode;
}

type Tab = "files" | "strings" | "search";

const TABS: { key: Tab; label: string; icon: string }[] = [
  { key: "files", label: "Files", icon: "📁" },
  { key: "strings", label: "Strings", icon: "📄" },
  { key: "search", label: "Search", icon: "🔍" },
];

const COLLAPSED_KEY = "crowdin-mate-left-sidebar-collapsed";
const PINNED_KEY = "crowdin-mate-left-sidebar-pinned";

/** Left sidebar, matching Crowdin's own FILES/STRINGS tabs — Files browses
 * the whole project tree, Strings lists every string in the currently
 * open file for quick jumping. Collapsible to reclaim width for the
 * editor, same as the right sidebar. */
export function Sidebar({
  projectId,
  languageId,
  languageName,
  sync,
  lastFullSyncAt,
  directories,
  files,
  onSelectFile,
  revealRequest,
  selectedFile,
  strings,
  focusedStringId,
  onFocusString,
  onJumpToSearchResult,
  width,
  onResizeStart,
  openFilesSection,
}: SidebarProps) {
  const [collapsed, setCollapsedState] = useState<boolean>(
    () => localStorage.getItem(COLLAPSED_KEY) === "1",
  );
  const [pinned, setPinnedState] = useState<boolean>(() => {
    const stored = localStorage.getItem(PINNED_KEY);
    // Defaults pinned — that's how this panel behaved before it could
    // auto-hide, so upgrading changes nothing until you unpin it.
    return stored === null ? true : stored === "1";
  });
  const [tab, setTab] = useState<Tab>("files");

  const setCollapsed = (next: boolean) => {
    localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
    setCollapsedState(next);
  };
  const setPinned = (next: boolean) => {
    localStorage.setItem(PINNED_KEY, next ? "1" : "0");
    setPinnedState(next);
  };

  // Same rule as the right sidebar: unpinned means "get out of the way once
  // I'm done", and looking elsewhere is what marks being done.
  useEffect(() => {
    if (collapsed || pinned) return;
    const onPointerDown = (e: MouseEvent) => {
      const el = e.target as Element | null;
      if (el?.closest?.(".left-sidebar")) return;
      setCollapsed(true);
    };
    document.addEventListener("mousedown", onPointerDown, true);
    return () => document.removeEventListener("mousedown", onPointerDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapsed, pinned]);

  // Clicking the open tab's own icon closes the panel, so one control both
  // opens and dismisses — same as the right sidebar's rail.
  const selectTab = (key: Tab) => {
    if (!collapsed && key === tab) {
      setCollapsed(true);
    } else {
      setTab(key);
      setCollapsed(false);
    }
  };

  const activeLabel = TABS.find((t) => t.key === tab)?.label ?? "Files";

  return (
    <div className="left-sidebar">
      {/* Vertical rail, always visible — including while collapsed, which is
          the point: a horizontal tab row can't survive the panel narrowing,
          so there'd be nothing left to click to get back. Labels live in
          tooltips, mirroring the right sidebar. */}
      <div className="left-sidebar-rail">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`rail-icon${!collapsed && tab === t.key ? " active" : ""}`}
            onClick={() => selectTab(t.key)}
            disabled={t.key === "strings" && selectedFile == null}
            title={t.label}
          >
            {t.icon}
          </button>
        ))}
      </div>

      {!collapsed && (
      <>
      <aside className="app-sidebar" style={{ width }}>
      <div className="sidebar-header">
        <h3 className="sidebar-title">{activeLabel}</h3>
        <button
          className={`right-sidebar-pin${pinned ? " right-sidebar-pin--active" : ""}`}
          onClick={() => setPinned(!pinned)}
          title={pinned ? "Unpin — hides when you click away" : "Pin — keeps this panel open"}
        >
          📌
        </button>
      </div>

      {/* All panels stay mounted always, toggled via CSS rather than
          conditional rendering — otherwise switching tabs and back would
          remount FileTree (losing expanded-folders state) or SearchPanel
          (losing the in-progress query) each time. */}
      <div className="sidebar-panel" hidden={!(tab === "files" || (tab === "strings" && selectedFile == null))}>
        <FileTree
          projectId={projectId}
          languageId={languageId}
          directories={directories}
          files={files}
          onSelectFile={onSelectFile}
          revealRequest={revealRequest}
          sync={sync}
          lastFullSyncAt={lastFullSyncAt}
        />
      </div>
      <div className="sidebar-panel" hidden={!(tab === "strings" && selectedFile != null)}>
        <FileStringsList strings={strings} focusedStringId={focusedStringId} onSelect={onFocusString} />
      </div>
      <div className="sidebar-panel" hidden={tab !== "search"}>
        <SearchPanel
          projectId={projectId}
          languageId={languageId}
          languageName={languageName}
          onJumpToResult={onJumpToSearchResult}
        />
      </div>
      {openFilesSection}
      </aside>
      <div className="resize-handle" onMouseDown={onResizeStart} />
      </>
      )}
    </div>
  );
}
