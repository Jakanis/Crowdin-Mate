import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, type TreeFile } from "./api/client";
import { Sidebar } from "./components/Sidebar";
import { SettingsMenu } from "./components/SettingsMenu";
import { TabBar } from "./components/TabBar";
import { TokenSetup } from "./components/TokenSetup";
import { TranslationWorkspace } from "./components/TranslationWorkspace";

const CLASSICUA_PROJECT_ID = 393919;
const TARGET_LANGUAGE_ID = "uk";

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

  const syncMutation = useMutation({
    mutationFn: () => api.syncTree(CLASSICUA_PROJECT_ID),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tree", CLASSICUA_PROJECT_ID] }),
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

  if (authStatus.isLoading) return <div className="app-shell">Loading…</div>;

  if (!authStatus.data?.configured) {
    return (
      <div className="app-shell">
        <TokenSetup />
      </div>
    );
  }

  const isEmpty = tree.data && tree.data.directories.length === 0 && tree.data.files.length === 0;

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>ClassicUA · Ukrainian</h1>
        <div className="app-header-actions">
          <button onClick={() => syncMutation.mutate()} disabled={syncMutation.isPending}>
            {syncMutation.isPending ? "Syncing…" : "Sync tree"}
          </button>
          <SettingsMenu />
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
          {openFiles.map((file) => (
            <div key={file.id} className="workspace-tab-panel" hidden={file.id !== activeFileId}>
              <TranslationWorkspace
                projectId={CLASSICUA_PROJECT_ID}
                fileId={file.id}
                languageId={TARGET_LANGUAGE_ID}
                focusedStringId={focusedStringIdByFile[file.id] ?? null}
                onFocusChange={(stringId) => setFocusedStringIdFor(file.id, stringId)}
              />
            </div>
          ))}
        </main>
      </div>
    </div>
  );
}
