import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, type TreeFile } from "./api/client";
import { Sidebar } from "./components/Sidebar";
import { TokenSetup } from "./components/TokenSetup";
import { TranslationWorkspace } from "./components/TranslationWorkspace";

const CLASSICUA_PROJECT_ID = 393919;
const TARGET_LANGUAGE_ID = "uk";

export function App() {
  const queryClient = useQueryClient();
  const [selectedFile, setSelectedFile] = useState<TreeFile | null>(null);
  const [focusedStringId, setFocusedStringId] = useState<number | null>(null);

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

  const stringsQuery = useQuery({
    queryKey: ["file-strings", CLASSICUA_PROJECT_ID, selectedFile?.id, TARGET_LANGUAGE_ID],
    queryFn: () => api.getFileStrings(CLASSICUA_PROJECT_ID, selectedFile!.id, TARGET_LANGUAGE_ID),
    enabled: selectedFile != null,
  });

  const strings = stringsQuery.data?.strings ?? [];

  // Default focus to the first string once its data has actually loaded —
  // a plain `[selectedFile]` dependency doesn't work here since strings
  // load asynchronously after the file is already selected, so that
  // effect would fire once with an empty array and never re-run.
  const initializedForFileId = useRef<number | null>(null);
  useEffect(() => {
    if (strings.length > 0 && initializedForFileId.current !== selectedFile?.id) {
      setFocusedStringId(strings[0].id);
      initializedForFileId.current = selectedFile?.id ?? null;
    }
  }, [selectedFile, strings]);

  const handleSelectFile = (file: TreeFile) => {
    setSelectedFile(file);
    setFocusedStringId(null);
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
        <button onClick={() => syncMutation.mutate()} disabled={syncMutation.isPending}>
          {syncMutation.isPending ? "Syncing…" : "Sync tree"}
        </button>
      </header>

      <div className="app-body">
        {isEmpty ? (
          <aside className="app-sidebar">
            <p className="hint">No cached tree yet — click "Sync tree" to crawl the project once.</p>
          </aside>
        ) : (
          <Sidebar
            directories={tree.data?.directories ?? []}
            files={tree.data?.files ?? []}
            onSelectFile={handleSelectFile}
            selectedFile={selectedFile}
            strings={strings}
            focusedStringId={focusedStringId}
            onFocusString={setFocusedStringId}
          />
        )}
        <main className="app-main">
          {selectedFile ? (
            <>
              <h2 className="file-title">{selectedFile.path}</h2>
              <TranslationWorkspace
                projectId={CLASSICUA_PROJECT_ID}
                fileId={selectedFile.id}
                languageId={TARGET_LANGUAGE_ID}
                strings={strings}
                isLoading={stringsQuery.isLoading}
                isError={stringsQuery.isError}
                error={stringsQuery.error as Error | null}
                focusedStringId={focusedStringId}
                onFocusChange={setFocusedStringId}
              />
            </>
          ) : (
            <p className="hint">Select a file from the tree.</p>
          )}
        </main>
      </div>
    </div>
  );
}
