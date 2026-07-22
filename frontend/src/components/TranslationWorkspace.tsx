import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { ComfortableView } from "./ComfortableView";
import { CommentsPanel } from "./CommentsPanel";
import { SideBySideView } from "./SideBySideView";

interface TranslationWorkspaceProps {
  projectId: number;
  fileId: number;
  languageId: string;
}

type ViewMode = "comfortable" | "side-by-side";

export function TranslationWorkspace({ projectId, fileId, languageId }: TranslationWorkspaceProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("comfortable");
  const [focusedStringId, setFocusedStringId] = useState<number | null>(null);

  const stringsQuery = useQuery({
    queryKey: ["file-strings", projectId, fileId, languageId],
    queryFn: () => api.getFileStrings(projectId, fileId, languageId),
  });

  const permissionsQuery = useQuery({
    queryKey: ["permissions", projectId],
    queryFn: () => api.getPermissions(projectId),
    staleTime: 5 * 60_000,
  });

  const strings = stringsQuery.data?.strings ?? [];

  // Default focus to the first string once its data has actually loaded,
  // so Comfortable always has something to show and the Comments panel
  // isn't stuck showing "select a string." A plain `[fileId]` dependency
  // doesn't work here — strings load asynchronously after fileId is
  // already set, so that effect fires once with an empty array and never
  // re-runs. Track the file we last initialized focus for instead, so
  // this fires exactly once per file, whenever its strings actually land.
  const initializedForFileId = useRef<number | null>(null);
  useEffect(() => {
    if (strings.length > 0 && initializedForFileId.current !== fileId) {
      setFocusedStringId(strings[0].id);
      initializedForFileId.current = fileId;
    }
  }, [fileId, strings]);

  if (stringsQuery.isLoading) return <p className="hint">Loading strings…</p>;
  if (stringsQuery.isError) return <p className="error">{(stringsQuery.error as Error).message}</p>;
  if (strings.length === 0) return <p className="hint">No strings in this file.</p>;

  const canApprove = permissionsQuery.data?.is_member ?? false;
  const focusedIndex = Math.max(0, strings.findIndex((s) => s.id === focusedStringId));

  return (
    <div className="translation-workspace">
      <div className="workspace-toolbar">
        <div className="view-mode-toggle">
          <button
            className={viewMode === "comfortable" ? "active" : ""}
            onClick={() => setViewMode("comfortable")}
          >
            Comfortable
          </button>
          <button
            className={viewMode === "side-by-side" ? "active" : ""}
            onClick={() => setViewMode("side-by-side")}
          >
            Side-by-Side
          </button>
        </div>
      </div>

      <div className="workspace-body">
        {viewMode === "comfortable" ? (
          <ComfortableView
            projectId={projectId}
            fileId={fileId}
            languageId={languageId}
            strings={strings}
            focusedIndex={focusedIndex}
            onFocusChange={(i) => setFocusedStringId(strings[i]?.id ?? null)}
            canApprove={canApprove}
          />
        ) : (
          <SideBySideView
            projectId={projectId}
            fileId={fileId}
            languageId={languageId}
            strings={strings}
            focusedStringId={focusedStringId}
            onFocusChange={setFocusedStringId}
            canApprove={canApprove}
          />
        )}

        <CommentsPanel projectId={projectId} stringId={focusedStringId} languageId={languageId} />
      </div>
    </div>
  );
}
