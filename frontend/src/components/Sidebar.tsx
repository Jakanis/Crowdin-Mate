import { useState } from "react";
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
  const [collapsed, setCollapsed] = useState(false);
  const [tab, setTab] = useState<Tab>("files");

  if (collapsed) {
    return (
      <div className="sidebar-collapsed sidebar-collapsed--left">
        <button className="sidebar-expand-btn" onClick={() => setCollapsed(false)} title="Show sidebar">
          ▸
        </button>
      </div>
    );
  }

  return (
    <>
      <aside className="app-sidebar" style={{ width }}>
      <div className="sidebar-tabs">
        <button className={tab === "files" ? "active" : ""} onClick={() => setTab("files")}>
          Files
        </button>
        <button
          className={tab === "strings" ? "active" : ""}
          onClick={() => setTab("strings")}
          disabled={selectedFile == null}
        >
          Strings
        </button>
        <button className={tab === "search" ? "active" : ""} onClick={() => setTab("search")}>
          Search
        </button>
        <button className="sidebar-collapse-btn" onClick={() => setCollapsed(true)} title="Hide sidebar">
          ◂
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
  );
}
