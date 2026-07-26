import { useEffect, useRef, useState } from "react";
import { api, type ProgressInfo, type TreeFile } from "./api/client";
import { onProgressChanged } from "./progressEvents";

/**
 * Translation/approval progress (for the current language) of exactly the
 * files currently open as tabs — so TabBar can show a per-tab progress
 * icon. Deliberately independent of FileTree's own dirProgress/fileProgress
 * (lazy, per-expanded-directory): a tab is very often open for a file
 * whose directory was never expanded in the tree at all — opened via
 * search, or restored from a previous session's persisted tabs — so
 * relying on FileTree's cache would leave those tabs with no progress.
 *
 * Reuses the same bulk tree-progress endpoint FileTree calls, just keyed
 * off the open files' own directories instead of whichever directory the
 * user happened to expand — one request per distinct directory among the
 * open files, not one per file.
 */
export function useOpenFilesProgress(
  projectId: number | null,
  languageId: string | null,
  openFiles: TreeFile[],
): Map<number, ProgressInfo> {
  const [fileProgress, setFileProgress] = useState<Map<number, ProgressInfo>>(new Map());
  const fetchedDirs = useRef<Set<number | "root">>(new Set());

  const fetchDir = (dirId: number | "root") => {
    if (projectId == null || languageId == null) return;
    api
      .getTreeProgress(projectId, languageId, dirId === "root" ? undefined : dirId)
      .then((result) => {
        setFileProgress((prev) => {
          const next = new Map(prev);
          for (const [id, p] of Object.entries(result.files)) next.set(Number(id), p);
          return next;
        });
      })
      .catch(() => fetchedDirs.current.delete(dirId));
  };

  // Project or language switched — every cached percentage belongs to
  // the previous selection.
  useEffect(() => {
    fetchedDirs.current = new Set();
    setFileProgress(new Map());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, languageId]);

  // Fetch progress for any open file whose directory hasn't been fetched
  // yet — covers both newly-opened tabs and the initial restore-from-
  // localStorage batch on load.
  useEffect(() => {
    for (const f of openFiles) {
      const dirId = f.directory_id ?? "root";
      if (fetchedDirs.current.has(dirId)) continue;
      fetchedDirs.current.add(dirId);
      fetchDir(dirId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openFiles, projectId, languageId]);

  // A translation elsewhere (approve/unapprove/delete/submit) changed a
  // file's counts — re-fetch just that file's directory so its tab icon
  // doesn't keep showing a stale percentage for the rest of the session.
  useEffect(() => {
    return onProgressChanged((fileId) => {
      const file = openFiles.find((f) => f.id === fileId);
      if (!file) return;
      fetchDir(file.directory_id ?? "root");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openFiles, projectId, languageId]);

  return fileProgress;
}
