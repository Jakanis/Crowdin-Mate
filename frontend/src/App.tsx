import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, type Project, type TreeFile } from "./api/client";
import { OfflineIndicator } from "./components/OfflineIndicator";
import { ProjectPicker } from "./components/ProjectPicker";
import { Sidebar } from "./components/Sidebar";
import { SettingsMenu } from "./components/SettingsMenu";
import { TabBar } from "./components/TabBar";
import { TokenSetup } from "./components/TokenSetup";
import { TranslationWorkspace } from "./components/TranslationWorkspace";
import { useRightSidebarState } from "./rightSidebarState";
import { useAutoAdvance, useOpenTabsLayout, useViewMode } from "./theme";
import { useResizableWidth } from "./useResizableWidth";
import { useSyncTree } from "./useSyncTree";

const SELECTED_PROJECT_KEY = "crowdin-mate-selected-project";

function tabsStorageKey(projectId: number) {
  return `crowdin-mate-open-tabs-${projectId}`;
}
function selectedLanguageKey(projectId: number) {
  return `crowdin-mate-selected-language-${projectId}`;
}

interface PersistedTabs {
  openFileIds: number[];
  activeFileId: number | null;
  focusedStringIdByFile: Record<number, number | null>;
}

function loadPersistedTabs(projectId: number): PersistedTabs | null {
  try {
    const raw = localStorage.getItem(tabsStorageKey(projectId));
    return raw ? (JSON.parse(raw) as PersistedTabs) : null;
  } catch {
    return null;
  }
}

function pickDefaultLanguage(project: Project): string | null {
  const persisted = localStorage.getItem(selectedLanguageKey(project.id));
  if (persisted && project.target_languages.some((l) => l.id === persisted)) return persisted;
  return project.target_languages[0]?.id ?? null;
}

export function App() {
  const queryClient = useQueryClient();

  // Which project + target language is currently open. null until the
  // project list has loaded and a default has been picked (see the
  // effect below) — everything downstream waits on that.
  const [projectId, setProjectId] = useState<number | null>(null);
  const [languageId, setLanguageId] = useState<string | null>(null);

  // Multiple files can be open at once (a quest-chain workflow: open
  // several related files up front, work through them one by one) —
  // openFiles is the tab strip, activeFileId which one is visible.
  // Each open file gets its own focusedStringId so switching tabs
  // doesn't disturb where you were in the others. All reset when the
  // project switches — tabs are per-project (see handleSelectProject).
  const [openFiles, setOpenFiles] = useState<TreeFile[]>([]);
  const [activeFileId, setActiveFileId] = useState<number | null>(null);
  const [focusedStringIdByFile, setFocusedStringIdByFile] = useState<Record<number, number | null>>({});

  // Lifted here (rather than each consumer calling useAutoAdvance() on
  // its own) because unlike theme/UI-scale — whose effect lands on
  // document.documentElement, so any component's hook instance sees it —
  // this value is read directly, and separate hook instances don't share
  // React state just because they share a localStorage key.
  const autoAdvance = useAutoAdvance();

  // Same lifting rationale — read directly by TranslationWorkspace (one
  // instance per open tab), so a per-instance hook wouldn't stay in
  // sync across them. Now a global Settings preference, not a per-file
  // toggle.
  const viewMode = useViewMode();
  const openTabsLayout = useOpenTabsLayout();

  // Same lifting rationale as autoAdvance above — one RightSidebar
  // instance exists per open tab (all mounted at once), so its own
  // collapsed/active-tab state needs to live one level up to actually
  // stay in sync across them. See rightSidebarState.ts.
  const rightSidebar = useRightSidebarState();

  // Left sidebar sits to the left of its drag handle (dragging right
  // grows it, sign 1); the right TM/comments sidebar sits to the right
  // of its handle (dragging left grows it, sign -1) — see
  // useResizableWidth's doc comment.
  const leftPanel = useResizableWidth("crowdin-mate-left-width", 340, 220, 640);
  const rightPanel = useResizableWidth("crowdin-mate-right-width", 280, 200, 560);

  const authStatus = useQuery({ queryKey: ["auth-status"], queryFn: api.authStatus });

  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: api.listProjects,
    enabled: authStatus.data?.configured === true,
  });
  const projects = projectsQuery.data?.projects ?? [];
  const selectedProject = projects.find((p) => p.id === projectId) ?? null;

  // Reset everything that's scoped to "whichever project is open" —
  // tabs, focus, stale flags — and persist the choice so next launch
  // reopens the same project. hydratedTabsForProject below re-hydrates
  // this new project's own saved tabs once tree.data for it arrives.
  const handleSelectProject = (project: Project) => {
    setProjectId(project.id);
    setLanguageId(pickDefaultLanguage(project));
    localStorage.setItem(SELECTED_PROJECT_KEY, String(project.id));
    setOpenFiles([]);
    setActiveFileId(null);
    setFocusedStringIdByFile({});
    setStaleFileIds(new Set());
  };

  const handleSelectLanguage = (langId: string) => {
    if (projectId == null) return;
    setLanguageId(langId);
    localStorage.setItem(selectedLanguageKey(projectId), langId);
  };

  // Pick a default project once the list loads and nothing's selected
  // yet — whatever was last used (if it still exists), else just the
  // first project the token can see.
  useEffect(() => {
    if (projectId != null || projects.length === 0) return;
    const persistedId = Number(localStorage.getItem(SELECTED_PROJECT_KEY));
    const initial = projects.find((p) => p.id === persistedId) ?? projects[0];
    handleSelectProject(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects.length]);

  const tree = useQuery({
    queryKey: ["tree", projectId],
    queryFn: () => api.getTree(projectId as number),
    enabled: projectId != null,
  });

  // Restore whichever tabs were open last session for THIS project, once
  // its tree data (needed to turn saved file ids back into real TreeFile
  // objects) has loaded. Tracks which project id it last hydrated for
  // (not a plain boolean) so switching projects re-runs this for the
  // newly-selected one, while "Sync tree" refetching tree.data for the
  // same project doesn't re-trigger it and stomp open tabs.
  const hydratedTabsForProject = useRef<number | null>(null);
  useEffect(() => {
    if (projectId == null || !tree.data || hydratedTabsForProject.current === projectId) return;
    hydratedTabsForProject.current = projectId;

    const persisted = loadPersistedTabs(projectId);
    if (!persisted) return;
    const filesById = new Map(tree.data.files.map((f) => [f.id, f]));
    const restoredFiles = persisted.openFileIds
      .map((id) => filesById.get(id))
      .filter((f): f is TreeFile => f != null);
    if (restoredFiles.length === 0) return;

    setOpenFiles(restoredFiles);
    setActiveFileId(
      restoredFiles.some((f) => f.id === persisted.activeFileId) ? persisted.activeFileId : restoredFiles[0].id,
    );
    setFocusedStringIdByFile(persisted.focusedStringIdByFile ?? {});
  }, [projectId, tree.data]);

  // Persist on every change, but only after hydration above has had its
  // chance to run for this project — otherwise the initial empty state
  // would overwrite last session's saved tabs before they're restored.
  useEffect(() => {
    if (projectId == null || hydratedTabsForProject.current !== projectId) return;
    const payload: PersistedTabs = {
      openFileIds: openFiles.map((f) => f.id),
      activeFileId,
      focusedStringIdByFile,
    };
    localStorage.setItem(tabsStorageKey(projectId), JSON.stringify(payload));
  }, [projectId, openFiles, activeFileId, focusedStringIdByFile]);

  const sync = useSyncTree(projectId ?? 0);

  // Files whose content may be stale versus Crowdin (flagged by sync's
  // changed_file_ids — see tree_sync.py) among the tabs actually open
  // right now. Accumulates across multiple syncs rather than replacing,
  // and only clears a file once the user explicitly reloads or
  // dismisses it — a later sync with no new changes shouldn't silently
  // un-flag a file the user hasn't dealt with yet.
  const [staleFileIds, setStaleFileIds] = useState<Set<number>>(new Set());
  useEffect(() => {
    if (sync.changedFileIds.length === 0) return;
    setStaleFileIds((prev) => {
      const next = new Set(prev);
      for (const id of sync.changedFileIds) {
        if (openFiles.some((f) => f.id === id)) next.add(id);
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sync.changedFileIds]);

  const clearStale = (fileId: number) => {
    setStaleFileIds((prev) => {
      const next = new Set(prev);
      next.delete(fileId);
      return next;
    });
  };

  const resyncMutation = useMutation({
    mutationFn: (fileId: number) => api.resyncFile(projectId as number, fileId, languageId as string),
    onSuccess: (_result, fileId) => {
      queryClient.invalidateQueries({ queryKey: ["file-strings", projectId, fileId, languageId] });
      clearStale(fileId);
    },
  });

  // The active tab's strings, fetched here too (in addition to inside
  // TranslationWorkspace) purely so the Sidebar's "Strings" tab can jump
  // within it — React Query dedupes by queryKey, so this is not an extra
  // network request beyond what TranslationWorkspace already needs.
  const activeStringsQuery = useQuery({
    queryKey: ["file-strings", projectId, activeFileId, languageId],
    queryFn: () => api.getFileStrings(projectId as number, activeFileId as number, languageId as string),
    enabled: activeFileId != null && projectId != null,
  });
  const activeStrings = activeStringsQuery.data?.strings ?? [];

  const handleSelectFile = (file: TreeFile) => {
    setOpenFiles((prev) => (prev.some((f) => f.id === file.id) ? prev : [...prev, file]));
    setActiveFileId(file.id);
  };

  const handleCloseTab = (fileId: number) => {
    setOpenFiles((prev) => {
      const next = prev.filter((f) => f.id !== fileId);
      if (activeFileId === fileId) {
        const closedIndex = prev.findIndex((f) => f.id === fileId);
        const fallback = next[closedIndex] ?? next[closedIndex - 1] ?? next[0] ?? null;
        setActiveFileId(fallback?.id ?? null);
      }
      return next;
    });
    setFocusedStringIdByFile((prev) => {
      const next = { ...prev };
      delete next[fileId];
      return next;
    });
  };

  const handleReorderTabs = (draggedFileId: number, targetFileId: number) => {
    setOpenFiles((prev) => {
      const fromIndex = prev.findIndex((f) => f.id === draggedFileId);
      const toIndex = prev.findIndex((f) => f.id === targetFileId);
      if (fromIndex === -1 || toIndex === -1) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  };

  const setFocusedStringIdFor = (fileId: number, stringId: number | null) => {
    setFocusedStringIdByFile((prev) => ({ ...prev, [fileId]: stringId }));
  };

  // "Next file"/"previous file" means the adjacent open tab, not some
  // project-wide file order — matches the quest-chain workflow this was
  // built for (open the whole chain as tabs up front, work through them
  // one by one). ComfortableView arms on the first press at the last/
  // first string and only actually switches on a second press, so
  // hasNextFile/hasPrevFile need to be known up front to decide whether
  // that arming should happen at all.
  const activeTabIndex = openFiles.findIndex((f) => f.id === activeFileId);
  const hasNextFile = activeTabIndex !== -1 && activeTabIndex < openFiles.length - 1;
  const hasPrevFile = activeTabIndex > 0;
  const navigateFile = (direction: "next" | "prev") => {
    const targetIndex = activeTabIndex + (direction === "next" ? 1 : -1);
    const target = openFiles[targetIndex];
    if (target) setActiveFileId(target.id);
  };

  // Ctrl+Shift+Up/Left for the previous open tab, Ctrl+Shift+Down/Right
  // for the next one — kept as a ref so this effect (declared once,
  // unconditionally, above every early return in this component) always
  // calls whatever the latest navigateFile closure is without needing to
  // resubscribe the listener on every openFiles/activeFileId change.
  // Skipped entirely while any input/textarea/contenteditable has focus:
  // Ctrl+Shift+Left/Right is the standard "select previous/next word"
  // shortcut while editing text, and this shouldn't steal that.
  const navigateFileRef = useRef(navigateFile);
  navigateFileRef.current = navigateFile;
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.shiftKey) return;
      if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
      const active = document.activeElement;
      const tag = active?.tagName;
      const isEditable =
        tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (active as HTMLElement | null)?.isContentEditable;
      if (isEditable) return;
      e.preventDefault();
      const direction = e.key === "ArrowUp" || e.key === "ArrowLeft" ? "prev" : "next";
      navigateFileRef.current(direction);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // Escape blurs whatever editable field currently has focus — the way
  // out of the translation box (or a search box, or the comment box)
  // back to where Ctrl+Arrow navigation works again, rather than a
  // dedicated "stop editing" action of its own.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const active = document.activeElement as HTMLElement | null;
      const tag = active?.tagName;
      const isEditable = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || active?.isContentEditable;
      if (isEditable) active?.blur();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const handleJumpToSearchResult = (fileId: number, stringId: number) => {
    const file = tree.data?.files.find((f) => f.id === fileId);
    if (!file) return;
    handleSelectFile(file);
    setFocusedStringIdFor(fileId, stringId);
  };

  if (authStatus.isLoading) return <div className="app-shell">Loading…</div>;

  if (!authStatus.data?.configured) {
    return (
      <div className="app-shell">
        <TokenSetup />
      </div>
    );
  }

  if (projectId == null || languageId == null || selectedProject == null) {
    return <div className="app-shell">Loading projects…</div>;
  }

  const isEmpty = tree.data && tree.data.directories.length === 0 && tree.data.files.length === 0;
  const crowdinFileUrl =
    activeFileId != null
      ? `https://crowdin.com/editor/${selectedProject.identifier}/${activeFileId}/${selectedProject.source_language_id}-${languageId}?view=comfortable`
      : null;
  const languageName = selectedProject.target_languages.find((l) => l.id === languageId)?.name ?? languageId;

  return (
    <div className="app-shell">
      <header className="app-header">
        <ProjectPicker
          projects={projects}
          selectedProject={selectedProject}
          languageId={languageId}
          onSelectProject={handleSelectProject}
          onSelectLanguage={handleSelectLanguage}
        />
        <div className="app-header-actions">
          <a
            className="header-link-button"
            href={crowdinFileUrl ?? `https://crowdin.com/project/${selectedProject.identifier}`}
            target="_blank"
            rel="noopener noreferrer"
            title={crowdinFileUrl ? "Open this file in Crowdin" : "Open project in Crowdin"}
          >
            Open in Crowdin ↗
          </a>
          <SettingsMenu
            autoAdvance={autoAdvance.enabled}
            onAutoAdvanceChange={autoAdvance.setEnabled}
            viewMode={viewMode.mode}
            onViewModeChange={viewMode.setMode}
            openTabsLayout={openTabsLayout.layout}
            onOpenTabsLayoutChange={openTabsLayout.setLayout}
          />
          <OfflineIndicator />
        </div>
      </header>

      <div className="app-body">
        {isEmpty ? (
          <aside className="app-sidebar">
            <p className="hint">No cached tree yet.</p>
            <button onClick={sync.trigger} disabled={sync.isPending}>
              {sync.isPending ? "Syncing…" : "Sync tree"}
            </button>
          </aside>
        ) : (
          <Sidebar
            projectId={projectId}
            languageId={languageId}
            languageName={languageName}
            sync={sync}
            lastFullSyncAt={tree.data?.last_full_sync_at ?? null}
            directories={tree.data?.directories ?? []}
            files={tree.data?.files ?? []}
            onSelectFile={handleSelectFile}
            selectedFile={openFiles.find((f) => f.id === activeFileId) ?? null}
            strings={activeStrings}
            focusedStringId={activeFileId != null ? focusedStringIdByFile[activeFileId] ?? null : null}
            onFocusString={(stringId) => activeFileId != null && setFocusedStringIdFor(activeFileId, stringId)}
            onJumpToSearchResult={handleJumpToSearchResult}
            width={leftPanel.width}
            onResizeStart={(e) => leftPanel.startResize(e, 1)}
            openFilesSection={
              openTabsLayout.layout === "sidebar" ? (
                <TabBar
                  openFiles={openFiles}
                  activeFileId={activeFileId}
                  onSelectTab={setActiveFileId}
                  onCloseTab={handleCloseTab}
                  onReorderTabs={handleReorderTabs}
                  orientation="vertical"
                />
              ) : undefined
            }
          />
        )}
        <main className="app-main">
          {openTabsLayout.layout === "top" && (
            <TabBar
              openFiles={openFiles}
              activeFileId={activeFileId}
              onSelectTab={setActiveFileId}
              onCloseTab={handleCloseTab}
              onReorderTabs={handleReorderTabs}
            />
          )}
          {openFiles.length === 0 && <p className="hint">Select a file from the tree.</p>}
          {activeFileId != null && staleFileIds.has(activeFileId) && (
            <div className="stale-file-banner">
              This file changed on Crowdin since it was opened.
              <button onClick={() => resyncMutation.mutate(activeFileId)} disabled={resyncMutation.isPending}>
                {resyncMutation.isPending ? "Reloading…" : "Reload"}
              </button>
              <button className="link-button" onClick={() => clearStale(activeFileId)}>
                Dismiss
              </button>
            </div>
          )}
          {openFiles.map((file) => (
            <div key={file.id} className="workspace-tab-panel" hidden={file.id !== activeFileId}>
              <TranslationWorkspace
                projectId={projectId}
                fileId={file.id}
                filePath={file.path}
                languageId={languageId}
                sourceLanguageId={selectedProject.source_language_id}
                focusedStringId={focusedStringIdByFile[file.id] ?? null}
                onFocusChange={(stringId) => setFocusedStringIdFor(file.id, stringId)}
                autoAdvance={autoAdvance.enabled}
                viewMode={viewMode.mode}
                hasNextFile={hasNextFile}
                hasPrevFile={hasPrevFile}
                onNavigateFile={navigateFile}
                rightPanelWidth={rightPanel.width}
                onRightPanelResizeStart={(e) => rightPanel.startResize(e, -1)}
                rightSidebarCollapsed={rightSidebar.collapsed}
                onRightSidebarCollapsedChange={rightSidebar.setCollapsed}
                rightSidebarActiveTab={rightSidebar.activeTab}
                onRightSidebarActiveTabChange={rightSidebar.setActiveTab}
                onJumpToTmMatch={handleJumpToSearchResult}
                isActive={file.id === activeFileId}
              />
            </div>
          ))}
        </main>
      </div>
    </div>
  );
}
