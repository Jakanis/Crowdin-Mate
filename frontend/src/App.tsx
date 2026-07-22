import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, type TreeFile } from "./api/client";
import { OfflineIndicator } from "./components/OfflineIndicator";
import { Sidebar } from "./components/Sidebar";
import { SettingsMenu } from "./components/SettingsMenu";
import { TabBar } from "./components/TabBar";
import { TokenSetup } from "./components/TokenSetup";
import { TranslationWorkspace } from "./components/TranslationWorkspace";
import { useAutoAdvance } from "./theme";
import { useResizableWidth } from "./useResizableWidth";
import { useSyncTree } from "./useSyncTree";

const CLASSICUA_PROJECT_ID = 393919;
const TARGET_LANGUAGE_ID = "uk";
// Project slug + source language for building a live crowdin.com editor
// link — not returned by our own /tree endpoint (which only serves the
// local directory/file cache), and hardcoding matches how the project
// id/target language above are already fixed to this one project.
const CLASSICUA_PROJECT_SLUG = "classicua";
const SOURCE_LANGUAGE_ID = "en";

const TABS_STORAGE_KEY = "classicua-open-tabs";

interface PersistedTabs {
  openFileIds: number[];
  activeFileId: number | null;
  focusedStringIdByFile: Record<number, number | null>;
}

function loadPersistedTabs(): PersistedTabs | null {
  try {
    const raw = localStorage.getItem(TABS_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as PersistedTabs) : null;
  } catch {
    return null;
  }
}

export function App() {
  const queryClient = useQueryClient();

  // Multiple files can be open at once (a quest-chain workflow: open
  // several related files up front, work through them one by one) —
  // openFiles is the tab strip, activeFileId which one is visible.
  // Each open file gets its own focusedStringId so switching tabs
  // doesn't disturb where you were in the others.
  const [openFiles, setOpenFiles] = useState<TreeFile[]>([]);
  const [activeFileId, setActiveFileId] = useState<number | null>(null);
  const [focusedStringIdByFile, setFocusedStringIdByFile] = useState<Record<number, number | null>>({});

  // Lifted here (rather than each consumer calling useAutoAdvance() on
  // its own) because unlike theme/UI-scale — whose effect lands on
  // document.documentElement, so any component's hook instance sees it —
  // this value is read directly, and separate hook instances don't share
  // React state just because they share a localStorage key.
  const autoAdvance = useAutoAdvance();

  // Left sidebar sits to the left of its drag handle (dragging right
  // grows it, sign 1); the right TM/comments sidebar sits to the right
  // of its handle (dragging left grows it, sign -1) — see
  // useResizableWidth's doc comment.
  const leftPanel = useResizableWidth("classicua-left-width", 340, 220, 640);
  const rightPanel = useResizableWidth("classicua-right-width", 280, 200, 560);

  const authStatus = useQuery({ queryKey: ["auth-status"], queryFn: api.authStatus });

  const tree = useQuery({
    queryKey: ["tree", CLASSICUA_PROJECT_ID],
    queryFn: () => api.getTree(CLASSICUA_PROJECT_ID),
    enabled: authStatus.data?.configured === true,
  });

  // Restore whichever tabs were open last session, once the tree data
  // needed to turn saved file ids back into real TreeFile objects has
  // loaded. Guarded by a ref (not state) so this runs exactly once —
  // "Sync tree" refetches tree.data with a new reference, and re-running
  // hydration on that would stomp whatever tabs the user has open by then.
  const hydratedTabs = useRef(false);
  useEffect(() => {
    if (hydratedTabs.current || !tree.data) return;
    hydratedTabs.current = true;

    const persisted = loadPersistedTabs();
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
  }, [tree.data]);

  // Persist on every change, but only after hydration above has had its
  // chance to run — otherwise the initial empty state would overwrite
  // last session's saved tabs before they ever get restored.
  useEffect(() => {
    if (!hydratedTabs.current) return;
    const payload: PersistedTabs = {
      openFileIds: openFiles.map((f) => f.id),
      activeFileId,
      focusedStringIdByFile,
    };
    localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify(payload));
  }, [openFiles, activeFileId, focusedStringIdByFile]);

  const sync = useSyncTree(CLASSICUA_PROJECT_ID);

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
    mutationFn: (fileId: number) => api.resyncFile(CLASSICUA_PROJECT_ID, fileId, TARGET_LANGUAGE_ID),
    onSuccess: (_result, fileId) => {
      queryClient.invalidateQueries({ queryKey: ["file-strings", CLASSICUA_PROJECT_ID, fileId, TARGET_LANGUAGE_ID] });
      clearStale(fileId);
    },
  });

  // The active tab's strings, fetched here too (in addition to inside
  // TranslationWorkspace) purely so the Sidebar's "Strings" tab can jump
  // within it — React Query dedupes by queryKey, so this is not an extra
  // network request beyond what TranslationWorkspace already needs.
  const activeStringsQuery = useQuery({
    queryKey: ["file-strings", CLASSICUA_PROJECT_ID, activeFileId, TARGET_LANGUAGE_ID],
    queryFn: () => api.getFileStrings(CLASSICUA_PROJECT_ID, activeFileId as number, TARGET_LANGUAGE_ID),
    enabled: activeFileId != null,
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

  if (authStatus.isLoading) return <div className="app-shell">Loading…</div>;

  if (!authStatus.data?.configured) {
    return (
      <div className="app-shell">
        <TokenSetup />
      </div>
    );
  }

  const isEmpty = tree.data && tree.data.directories.length === 0 && tree.data.files.length === 0;
  const crowdinFileUrl =
    activeFileId != null
      ? `https://crowdin.com/editor/${CLASSICUA_PROJECT_SLUG}/${activeFileId}/${SOURCE_LANGUAGE_ID}-${TARGET_LANGUAGE_ID}?view=comfortable`
      : null;

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>ClassicUA · Ukrainian</h1>
        <div className="app-header-actions">
          <a
            className="header-link-button"
            href={crowdinFileUrl ?? "https://crowdin.com/project/classicua"}
            target="_blank"
            rel="noopener noreferrer"
            title={crowdinFileUrl ? "Open this file in Crowdin" : "Open project in Crowdin"}
          >
            Open in Crowdin ↗
          </a>
          {sync.progress != null && (
            <span className="sync-progress" title="Estimated from previous sync durations">
              <span className="sync-progress-fill" style={{ width: `${sync.progress * 100}%` }} />
            </span>
          )}
          <button onClick={sync.trigger} disabled={sync.isPending}>
            {sync.isPending ? "Syncing…" : "Sync tree"}
          </button>
          <SettingsMenu autoAdvance={autoAdvance.enabled} onAutoAdvanceChange={autoAdvance.setEnabled} />
          <OfflineIndicator />
        </div>
      </header>

      <div className="app-body">
        {isEmpty ? (
          <aside className="app-sidebar">
            <p className="hint">No cached tree yet — click "Sync tree" to crawl the project once.</p>
          </aside>
        ) : (
          <Sidebar
            projectId={CLASSICUA_PROJECT_ID}
            languageId={TARGET_LANGUAGE_ID}
            directories={tree.data?.directories ?? []}
            files={tree.data?.files ?? []}
            onSelectFile={handleSelectFile}
            selectedFile={openFiles.find((f) => f.id === activeFileId) ?? null}
            strings={activeStrings}
            focusedStringId={activeFileId != null ? focusedStringIdByFile[activeFileId] ?? null : null}
            onFocusString={(stringId) => activeFileId != null && setFocusedStringIdFor(activeFileId, stringId)}
            width={leftPanel.width}
            onResizeStart={(e) => leftPanel.startResize(e, 1)}
          />
        )}
        <main className="app-main">
          <TabBar
            openFiles={openFiles}
            activeFileId={activeFileId}
            onSelectTab={setActiveFileId}
            onCloseTab={handleCloseTab}
          />
          {openFiles.length === 0 && <p className="hint">Select a file from the tree.</p>}
          {activeFileId != null && (
            <h2 className="file-title">{openFiles.find((f) => f.id === activeFileId)?.path}</h2>
          )}
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
                projectId={CLASSICUA_PROJECT_ID}
                fileId={file.id}
                languageId={TARGET_LANGUAGE_ID}
                focusedStringId={focusedStringIdByFile[file.id] ?? null}
                onFocusChange={(stringId) => setFocusedStringIdFor(file.id, stringId)}
                autoAdvance={autoAdvance.enabled}
                hasNextFile={hasNextFile}
                hasPrevFile={hasPrevFile}
                onNavigateFile={navigateFile}
                rightPanelWidth={rightPanel.width}
                onRightPanelResizeStart={(e) => rightPanel.startResize(e, -1)}
              />
            </div>
          ))}
        </main>
      </div>
    </div>
  );
}
