import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type SourceString } from "../api/client";
import { ComfortableView } from "./ComfortableView";
import { RightSidebar } from "./RightSidebar";
import { SideBySideView } from "./SideBySideView";

interface TranslationWorkspaceProps {
  projectId: number;
  fileId: number;
  languageId: string;
  strings: SourceString[];
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  focusedStringId: number | null;
  onFocusChange: (stringId: number | null) => void;
}

type ViewMode = "comfortable" | "side-by-side";

export function TranslationWorkspace({
  projectId,
  fileId,
  languageId,
  strings,
  isLoading,
  isError,
  error,
  focusedStringId,
  onFocusChange,
}: TranslationWorkspaceProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("comfortable");

  const permissionsQuery = useQuery({
    queryKey: ["permissions", projectId],
    queryFn: () => api.getPermissions(projectId),
    staleTime: 5 * 60_000,
  });

  if (isLoading) return <p className="hint">Loading strings…</p>;
  if (isError) return <p className="error">{error?.message}</p>;
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
            onFocusChange={(i) => onFocusChange(strings[i]?.id ?? null)}
            canApprove={canApprove}
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
          />
        )}

        <RightSidebar projectId={projectId} stringId={focusedStringId} languageId={languageId} />
      </div>
    </div>
  );
}
