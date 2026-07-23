import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
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
  onJumpToTmMatch: (fileId: number, stringId: number) => void;
  /** Whether this tab is the one currently visible — every open tab's
   * TranslationWorkspace stays mounted (see the doc comment below), so
   * this is the only signal available for "the user just switched to
   * this tab" as opposed to "this tab was opened a while ago and never
   * touched since." Drives the auto-refresh-on-activate effect below. */
  isActive: boolean;
}

const MIN_AUTO_REFRESH_INTERVAL_MS = 20_000;

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
  onJumpToTmMatch,
  isActive,
}: TranslationWorkspaceProps) {
  const queryClient = useQueryClient();
  const stringsQuery = useQuery({
    queryKey: ["file-strings", projectId, fileId, languageId],
    queryFn: () => api.getFileStrings(projectId, fileId, languageId),
  });
  const strings = stringsQuery.data?.strings ?? [];

  // get_file_strings already revalidates its local cache in the
  // background on every fetch (see its docstring), but this component
  // stays mounted for the lifetime of the tab — switching back to an
  // already-open tab is just a CSS visibility toggle, not a remount —
  // so nothing ever told the FRONTEND to re-read what that background
  // revalidation wrote. This is the fix: an explicit resync (which hits
  // Crowdin, not just the local cache) fired whenever this tab actually
  // becomes the visible one, so "switch to a tab" reliably shows
  // whatever's currently on Crowdin instead of whatever happened to be
  // cached the first time it was opened. Throttled per-instance so
  // rapidly flipping through several tabs (or double-press Prev/Next)
  // doesn't fire one live Crowdin call per flip — the manual Refresh
  // button below bypasses this throttle for an explicit forced check.
  //
  // Deliberately a plain async function + refs/useState rather than
  // useMutation: confirmed live that React 18 StrictMode's dev-only
  // double-invoke of this effect raced two mutate() calls against the
  // same useMutation observer, leaving its isPending permanently stuck
  // true (the observer's internal result never settled back to
  // success/error even though both underlying requests completed) —
  // the Refresh button stayed disabled forever after the very first
  // auto-refresh. inFlightRef is a synchronous, plain-JS reentrancy
  // guard that isn't subject to whatever that observer-lifecycle race
  // was, so a second near-simultaneous invocation just no-ops instead
  // of racing.
  const lastAutoRefreshRef = useRef(0);
  const refreshInFlightRef = useRef(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const doRefresh = async () => {
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    setIsRefreshing(true);
    try {
      await api.resyncFile(projectId, fileId, languageId);
      queryClient.invalidateQueries({ queryKey: ["file-strings", projectId, fileId, languageId] });
    } catch {
      // Best-effort — the manual Refresh button remains available to
      // retry, and get_file_strings' own background revalidation will
      // eventually catch up regardless.
    } finally {
      refreshInFlightRef.current = false;
      setIsRefreshing(false);
    }
  };
  useEffect(() => {
    if (!isActive) return;
    if (Date.now() - lastAutoRefreshRef.current < MIN_AUTO_REFRESH_INTERVAL_MS) return;
    lastAutoRefreshRef.current = Date.now();
    doRefresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive]);
  const forceRefresh = () => {
    lastAutoRefreshRef.current = Date.now();
    doRefresh();
  };

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
  const focusedSourceText = strings.find((s) => s.id === focusedStringId)?.text ?? null;

  return (
    <div className="translation-workspace">
      {/* Comfortable/Side-by-Side moved to Settings (a global preference,
          not per-tab) — this bar used to be left empty (just the
          hairline separator above the source text) but now also carries
          a manual refresh action: get_file_strings serves this tab's
          strings from the local cache first, and while a background
          revalidation does run on every fetch, this component staying
          mounted for the tab's whole lifetime means nothing else
          re-queries once that revalidation lands — see the
          auto-refresh-on-activate effect above for the automatic half
          of this, this button is the explicit "no really, check Crowdin
          right now" escape hatch. */}
      <div className="workspace-toolbar">
        <button
          className="link-button workspace-refresh-button"
          onClick={forceRefresh}
          disabled={isRefreshing}
          title="Re-check this file against Crowdin"
        >
          {isRefreshing ? "Refreshing…" : "↻ Refresh"}
        </button>
      </div>

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
          sourceText={focusedSourceText}
          width={rightPanelWidth}
          onResizeStart={onRightPanelResizeStart}
          collapsed={rightSidebarCollapsed}
          onCollapsedChange={onRightSidebarCollapsedChange}
          activeTab={rightSidebarActiveTab}
          onActiveTabChange={onRightSidebarActiveTabChange}
          onJumpToTmMatch={onJumpToTmMatch}
        />
      </div>
    </div>
  );
}
