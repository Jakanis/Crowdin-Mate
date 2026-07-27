import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { notifyProgressChanged } from "../progressEvents";
import type { ViewMode } from "../theme";
import { ComfortableView } from "./ComfortableView";
import { RightSidebar } from "./RightSidebar";
import { SideBySideView } from "./SideBySideView";

interface TranslationWorkspaceProps {
  projectId: number;
  fileId: number;
  filePath: string;
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
  rightSidebarPinned: boolean;
  onRightSidebarPinnedChange: (pinned: boolean) => void;
  onJumpToTmMatch: (fileId: number, stringId: number) => void;
  /** Whether this tab is the one currently visible — every open tab's
   * TranslationWorkspace stays mounted (see the doc comment below), so
   * this is the only signal available for "the user just switched to
   * this tab" as opposed to "this tab was opened a while ago and never
   * touched since." Drives the auto-refresh-on-activate effect below. */
  isActive: boolean;
}

const MIN_AUTO_REFRESH_INTERVAL_MS = 20_000;
const ARM_TIMEOUT_MS = 3000;

function RefreshIcon({ spinning }: { spinning?: boolean }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={spinning ? "icon-spin" : undefined}
    >
      <path d="M13 4.5A5.5 5.5 0 1 1 11.5 2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M13 1.8V4.6H10.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
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
  filePath,
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
  rightSidebarPinned,
  onRightSidebarPinnedChange,
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
      // Whatever this pulled in from Crowdin can change translated/
      // approved counts — without this, the tab's progress strip (and
      // the file tree's own bar) keep showing whatever was cached
      // before the resync, same as any other action that changes them.
      notifyProgressChanged(fileId);
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

  // Prev/Next lives in the header now (alongside the file path and
  // refresh button) rather than at the bottom of ComfortableView, so it
  // reads as one consistent toolbar for the whole tab regardless of
  // which layout is active — Side-by-Side just doesn't render this part
  // of it, since there's no single "current" string to page through
  // when every row is already visible at once.
  //
  // Pressing Next past the last string (or Previous before the first)
  // doesn't jump files immediately — it "arms" with a visible hint, and
  // only a second press within a few seconds actually switches tabs. A
  // single accidental extra click at the end of a file is common and
  // shouldn't fling you into the next one unannounced.
  const [armed, setArmed] = useState<"next" | "prev" | null>(null);
  const armTimeoutRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (armTimeoutRef.current != null) window.clearTimeout(armTimeoutRef.current);
  }, []);
  const disarm = () => {
    if (armTimeoutRef.current != null) window.clearTimeout(armTimeoutRef.current);
    setArmed(null);
  };
  const arm = (direction: "next" | "prev") => {
    if (armTimeoutRef.current != null) window.clearTimeout(armTimeoutRef.current);
    setArmed(direction);
    armTimeoutRef.current = window.setTimeout(() => setArmed(null), ARM_TIMEOUT_MS);
  };

  // Ctrl+Up/Left (previous) and Ctrl+Down/Right (next) for string
  // navigation, same target as the Prev/Next buttons above and the same
  // shape as App.tsx's tab-navigation shortcut — kept as a ref (rather
  // than depending on handlePrevious/handleNext directly, which are
  // defined below the early returns further down and would make a
  // straight dependency impossible without breaking the Rules of Hooks)
  // so this effect itself can sit safely above those returns and still
  // always call whatever the latest handlers are. Only active for the
  // tab that's actually visible — every open tab's workspace stays
  // mounted (see this component's own doc comment), so without the
  // isActive gate every hidden tab would react to the same keypress
  // too. Skipped entirely while any editable field has focus — matching
  // tab-navigation, Ctrl+Left/Right is "move cursor by word" while
  // editing text, and Escape (see App.tsx) is the way out of the box to
  // use these again.
  const navHandlersRef = useRef<{ prev: () => void; next: () => void }>({ prev: () => {}, next: () => {} });
  useEffect(() => {
    if (!isActive) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey) return;
      if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
      const active = document.activeElement;
      const tag = active?.tagName;
      const isEditable =
        tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (active as HTMLElement | null)?.isContentEditable;
      if (isEditable) return;
      e.preventDefault();
      if (e.key === "ArrowUp" || e.key === "ArrowLeft") navHandlersRef.current.prev();
      else navHandlersRef.current.next();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isActive]);

  if (stringsQuery.isLoading) return <p className="hint">Loading strings…</p>;
  if (stringsQuery.isError) return <p className="error">{(stringsQuery.error as Error).message}</p>;
  if (strings.length === 0) return <p className="hint">No strings in this file.</p>;

  const canApprove = permissionsQuery.data?.is_member ?? false;
  const currentUserId = permissionsQuery.data?.user_id ?? null;
  const focusedIndex = Math.max(0, strings.findIndex((s) => s.id === focusedStringId));
  const focusedSourceText = strings.find((s) => s.id === focusedStringId)?.text ?? null;
  const isFirst = focusedIndex === 0;
  const isLast = focusedIndex === strings.length - 1;
  const goToIndex = (i: number) => onFocusChange(strings[i]?.id ?? null);

  const handlePrevious = () => {
    if (!isFirst) {
      disarm();
      goToIndex(focusedIndex - 1);
      return;
    }
    if (armed === "prev") {
      disarm();
      onNavigateFile("prev");
    } else {
      arm("prev");
    }
  };

  const handleNext = () => {
    if (!isLast) {
      disarm();
      goToIndex(focusedIndex + 1);
      return;
    }
    if (armed === "next") {
      disarm();
      onNavigateFile("next");
    } else {
      arm("next");
    }
  };

  navHandlersRef.current = { prev: handlePrevious, next: handleNext };

  return (
    <div className="translation-workspace">
      {/* One compact header for the tab: file path, Prev/Next (Comfortable
          only — Side-by-Side has no single "current" string to page
          through), and a manual refresh action, all on one line instead
          of the path sitting on its own row above everything else.
          get_file_strings serves this tab's strings from the local cache
          first, and while a background revalidation does run on every
          fetch, this component staying mounted for the tab's whole
          lifetime means nothing else re-queries once that revalidation
          lands — see the auto-refresh-on-activate effect above for the
          automatic half of this, the refresh button is the explicit "no
          really, check Crowdin right now" escape hatch. */}
      <div className="workspace-toolbar">
        <span className="workspace-file-path" title={filePath}>
          {filePath}
        </span>
        {viewMode === "comfortable" && (
          <div className="workspace-pager">
            <div className="comfortable-pager-nav">
              {armed === "prev" && (
                <span className="pager-hint pager-hint--prev">Press again for the previous file</span>
              )}
              <button
                className="icon-btn"
                onClick={handlePrevious}
                disabled={isFirst && !hasPrevFile}
                title="Previous string"
              >
                ←
              </button>
            </div>
            <span className="comfortable-pager-count">
              {focusedIndex + 1} / {strings.length}
            </span>
            <div className="comfortable-pager-nav">
              <button
                className="icon-btn"
                onClick={handleNext}
                disabled={isLast && !hasNextFile}
                title="Next string"
              >
                →
              </button>
              {armed === "next" && (
                <span className="pager-hint pager-hint--next">Press again for the next file</span>
              )}
            </div>
          </div>
        )}
        <button
          className="icon-btn workspace-refresh-button"
          onClick={forceRefresh}
          disabled={isRefreshing}
          title="Re-check this file against Crowdin"
        >
          <RefreshIcon spinning={isRefreshing} />
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
            onJumpToTmMatch={onJumpToTmMatch}
            isActive={isActive}
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
            onJumpToTmMatch={onJumpToTmMatch}
            isActive={isActive}
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
          pinned={rightSidebarPinned}
          onPinnedChange={onRightSidebarPinnedChange}
          onJumpToTmMatch={onJumpToTmMatch}
        />
      </div>
    </div>
  );
}
