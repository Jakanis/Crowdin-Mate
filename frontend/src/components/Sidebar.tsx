import { useState } from "react";
import type { SourceString, TreeDirectory, TreeFile } from "../api/client";
import { FileStringsList } from "./FileStringsList";
import { FileTree } from "./FileTree";

interface SidebarProps {
  directories: TreeDirectory[];
  files: TreeFile[];
  onSelectFile: (file: TreeFile) => void;
  selectedFile: TreeFile | null;
  strings: SourceString[];
  focusedStringId: number | null;
  onFocusString: (stringId: number) => void;
}

type Tab = "files" | "strings";

/** Left sidebar, matching Crowdin's own FILES/STRINGS tabs — Files browses
 * the whole project tree, Strings lists every string in the currently
 * open file for quick jumping. Collapsible to reclaim width for the
 * editor, same as the right sidebar. */
export function Sidebar({
  directories,
  files,
  onSelectFile,
  selectedFile,
  strings,
  focusedStringId,
  onFocusString,
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
    <aside className="app-sidebar">
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
        <button className="sidebar-collapse-btn" onClick={() => setCollapsed(true)} title="Hide sidebar">
          ◂
        </button>
      </div>

      {tab === "files" || selectedFile == null ? (
        <FileTree directories={directories} files={files} onSelectFile={onSelectFile} />
      ) : (
        <FileStringsList strings={strings} focusedStringId={focusedStringId} onSelect={onFocusString} />
      )}
    </aside>
  );
}
