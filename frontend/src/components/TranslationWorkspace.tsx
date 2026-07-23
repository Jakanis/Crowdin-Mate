import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { api } from "../api/client";
import type { ViewMode } from "../theme";
import { ComfortableView } from "./ComfortableView";
import { RightSidebar } from "./RightSidebar";
import { SideBySideView } from "./SideBySideView";

interface TranslationWorkspaceProps {
  projectId: number;
  fileId: number;
  languageId: string;
  sourceLanguageId: string;
  focusedStringId: number | null;
  onFocusChange: (stringId: number | null) => void;
  autoAdvance: boolean;
  viewMode: ViewMode;
  hasNextFile: boolean;
  hasPrevFile: boolean;
  onNavigateFile: (direction: "next" | "prev") => void;
  rightPanelWidth: number;
  onRightPanelResizeStart: (e: React.MouseEvent) => void;
  rightSidebarCollapsed: boolean;
  onRightSidebarCollapsedChange: (collapsed: boolean) => void;
  rightSidebarActiveTab: string;
  onRightSidebarActiveTabChange: (tab: string) => void;
}

/** One instance per open tab (see App.tsx) — each keeps its own strings
 * query and stays mounted (hidden via CSS) even when a different tab is
 * active, so switching tabs never loses scroll position or which string
 * you had focused. React Query dedupes the strings fetch by queryKey,
 * so having one instance per open tab costs no extra network requests
 * beyond what each distinct file needs. viewMode is a global Settings
 * preference (useViewMode in theme.ts, lifted to App.tsx) rather than
 * local state here — it used to be a per-file toggle in the toolbar
 * below, which meant switching layout in one tab left every other tab
 * on whatever it happened to already be showing. */
export function TranslationWorkspace({
  projectId,
  fileId,
  languageId,
  sourceLanguageId,
  focusedStringId,
  onFocusChange,
  autoAdvance,
  viewMode,
  hasNextFile,
  hasPrevFile,
  onNavigateFile,
  rightPanelWidth,
  onRightPanelResizeStart,
  rightSidebarCollapsed,
  onRightSidebarCollapsedChange,
  rightSidebarActiveTab,
  onRightSidebarActiveTabChange,
}: TranslationWorkspaceProps) {
  const stringsQuery = useQuery({
    queryKey: ["file-strings", projectId, fileId, languageId],
    queryFn: () => api.getFileStrings(projectId, fileId, languageId),
  });
  const strings = stringsQuery.data?.strings ?? [];

  const permissionsQuery = useQuery({
    queryKey: ["permissions", projectId],
    queryFn: () => api.getPermissions(projectId),
    staleTime: 5 * 60_000,
  });

  // Default focus to the first string once this tab's data has actually
  // loaded. Keyed on fileId so re-visiting an already-open tab doesn't
  // reset a focus the user already moved away from.
  const initializedForFileId = useRef<number | null>(null);
  useEffect(() => {
    if (strings.length > 0 && initializedForFileId.current !== fileId && focusedStringId == null) {
      onFocusChange(strings[0].id);
      initializedForFileId.current = fileId;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, strings]);

  if (stringsQuery.isLoading) return <p className="hint">Loading strings…</p>;
  if (stringsQuery.isError) return <p className="error">{(stringsQuery.error as Error).message}</p>;
  if (strings.length === 0) return <p className="hint">No strings in this file.</p>;

  const canApprove = permissionsQuery.data?.is_member ?? false;
  const currentUserId = permissionsQuery.data?.user_id ?? null;
  const focusedIndex = Math.max(0, strings.findIndex((s) => s.id === focusedStringId));

  return (
    <div className="translation-workspace">
      {/* Comfortable/Side-by-Side moved to Settings (a global preference,
          not per-tab) — this bar is now just the hairline separator
          above the source text; left empty rather than removed
          entirely, since removing it would bring back the gap it was
          added to fix. */}
      <div className="workspace-toolbar" />

      <div className="workspace-body">
        {viewMode === "comfortable" ? (
          <ComfortableView
            projectId={projectId}
            fileId={fileId}
            languageId={languageId}
            strings={strings}
            focusedIndex={focusedIndex}
            onFocusChange={(i) => onFocusChange(strings[i]?.id ?? null)}
            canApprove={canApprove}
            currentUserId={currentUserId}
            autoAdvance={autoAdvance}
            hasNextFile={hasNextFile}
            hasPrevFile={hasPrevFile}
            onNavigateFile={onNavigateFile}
          />
        ) : (
          <SideBySideView
            projectId={projectId}
            fileId={fileId}
            languageId={languageId}
            strings={strings}
            focusedStringId={focusedStringId}
            onFocusChange={onFocusChange}
            canApprove={canApprove}
            currentUserId={currentUserId}
          />
        )}

        <RightSidebar
          projectId={projectId}
          stringId={focusedStringId}
          languageId={languageId}
          sourceLanguageId={sourceLanguageId}
          width={rightPanelWidth}
          onResizeStart={onRightPanelResizeStart}
          collapsed={rightSidebarCollapsed}
          onCollapsedChange={onRightSidebarCollapsedChange}
          activeTab={rightSidebarActiveTab}
          onActiveTabChange={onRightSidebarActiveTabChange}
        />
      </div>
    </div>
  );
}
