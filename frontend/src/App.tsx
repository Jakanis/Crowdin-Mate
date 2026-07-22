import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type TreeFile } from "./api/client";
import { FileTree } from "./components/FileTree";
import { TokenSetup } from "./components/TokenSetup";

const CLASSICUA_PROJECT_ID = 393919;

export function App() {
  const queryClient = useQueryClient();
  const [selectedFile, setSelectedFile] = useState<TreeFile | null>(null);

  const authStatus = useQuery({ queryKey: ["auth-status"], queryFn: api.authStatus });

  const tree = useQuery({
    queryKey: ["tree", CLASSICUA_PROJECT_ID],
    queryFn: () => api.getTree(CLASSICUA_PROJECT_ID),
    enabled: authStatus.data?.configured === true,
  });

  const syncMutation = useMutation({
    mutationFn: () => api.syncTree(CLASSICUA_PROJECT_ID),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tree", CLASSICUA_PROJECT_ID] }),
  });

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
        <button onClick={() => syncMutation.mutate()} disabled={syncMutation.isPending}>
          {syncMutation.isPending ? "Syncing…" : "Sync tree"}
        </button>
      </header>

      <div className="app-body">
        <aside className="app-sidebar">
          {isEmpty ? (
            <p className="hint">No cached tree yet — click "Sync tree" to crawl the project once.</p>
          ) : (
            <FileTree
              directories={tree.data?.directories ?? []}
              files={tree.data?.files ?? []}
              onSelectFile={setSelectedFile}
            />
          )}
        </aside>
        <main className="app-main">
          {selectedFile ? (
            <p>
              Selected: <strong>{selectedFile.path}</strong> ({selectedFile.strings_count ?? "?"} strings) —
              string editing lands in Phase 1.
            </p>
          ) : (
            <p className="hint">Select a file from the tree.</p>
          )}
        </main>
      </div>
    </div>
  );
}
