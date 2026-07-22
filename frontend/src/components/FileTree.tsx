import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type ProgressInfo, type TreeDirectory, type TreeFile } from "../api/client";

interface FileTreeProps {
  projectId: number;
  languageId: string;
  directories: TreeDirectory[];
  files: TreeFile[];
  onSelectFile?: (file: TreeFile) => void;
}

type Row =
  | { kind: "dir"; id: number; depth: number; name: string; expanded: boolean }
  | { kind: "file"; id: number; depth: number; name: string; stringsCount: number | null };

const ROW_HEIGHT = 28;

/**
 * Renders the whole project tree without ever mounting more than a
 * viewport's worth of DOM rows — this is the direct fix for the bug we
 * profiled in Crowdin's own editor (275,990 live DOM nodes for one open
 * file, because their sidebar renders every node unconditionally).
 * Collapsed folders contribute exactly one row here, regardless of how
 * many thousands of descendants they hold.
 */
export function FileTree({ projectId, languageId, directories, files, onSelectFile }: FileTreeProps) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const parentRef = useRef<HTMLDivElement>(null);

  // Translation/approval progress, merged in as it's fetched — root on
  // mount, then a directory's children right when it's expanded. Never
  // fetched in bulk (there's no bulk endpoint — see progress_sync.py),
  // so this map only ever grows to cover what's actually been revealed.
  const [dirProgress, setDirProgress] = useState<Map<number, ProgressInfo>>(new Map());
  const [fileProgress, setFileProgress] = useState<Map<number, ProgressInfo>>(new Map());
  const fetchedParents = useRef<Set<number | "root">>(new Set());

  const mergeProgress = (result: { directories: Record<number, ProgressInfo>; files: Record<number, ProgressInfo> }) => {
    setDirProgress((prev) => {
      const next = new Map(prev);
      for (const [id, p] of Object.entries(result.directories)) next.set(Number(id), p);
      return next;
    });
    setFileProgress((prev) => {
      const next = new Map(prev);
      for (const [id, p] of Object.entries(result.files)) next.set(Number(id), p);
      return next;
    });
  };

  const fetchProgressFor = (parentId: number | "root") => {
    if (fetchedParents.current.has(parentId)) return;
    fetchedParents.current.add(parentId);
    api
      .getTreeProgress(projectId, languageId, parentId === "root" ? undefined : parentId)
      .then(mergeProgress)
      .catch(() => {
        fetchedParents.current.delete(parentId); // allow retry on next expand
      });
  };

  useEffect(() => {
    fetchProgressFor("root");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, languageId]);

  const { childDirsByParent, childFilesByDir } = useMemo(() => {
    const childDirsByParent = new Map<number | null, TreeDirectory[]>();
    for (const dir of directories) {
      const key = dir.parent_id;
      if (!childDirsByParent.has(key)) childDirsByParent.set(key, []);
      childDirsByParent.get(key)!.push(dir);
    }
    for (const list of childDirsByParent.values()) {
      list.sort((a, b) => a.name.localeCompare(b.name));
    }

    const childFilesByDir = new Map<number | null, TreeFile[]>();
    for (const file of files) {
      const key = file.directory_id;
      if (!childFilesByDir.has(key)) childFilesByDir.set(key, []);
      childFilesByDir.get(key)!.push(file);
    }
    for (const list of childFilesByDir.values()) {
      list.sort((a, b) => a.name.localeCompare(b.name));
    }

    return { childDirsByParent, childFilesByDir };
  }, [directories, files]);

  const rows = useMemo(() => {
    const out: Row[] = [];

    const walk = (parentId: number | null, depth: number) => {
      for (const dir of childDirsByParent.get(parentId) ?? []) {
        const isExpanded = expanded.has(dir.id);
        out.push({ kind: "dir", id: dir.id, depth, name: dir.name, expanded: isExpanded });
        if (isExpanded) {
          walk(dir.id, depth + 1);
          for (const file of childFilesByDir.get(dir.id) ?? []) {
            out.push({
              kind: "file",
              id: file.id,
              depth: depth + 1,
              name: file.name,
              stringsCount: file.strings_count,
            });
          }
        }
      }
    };

    walk(null, 0);
    // Root-level files (directory_id === null)
    for (const file of childFilesByDir.get(null) ?? []) {
      out.push({ kind: "file", id: file.id, depth: 0, name: file.name, stringsCount: file.strings_count });
    }

    return out;
  }, [childDirsByParent, childFilesByDir, expanded]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const toggleDir = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
        fetchProgressFor(id);
      }
      return next;
    });
  };

  return (
    <div ref={parentRef} className="file-tree-scroll">
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const row = rows[virtualRow.index];
          const progress = row.kind === "dir" ? dirProgress.get(row.id) : fileProgress.get(row.id);
          return (
            <div
              key={`${row.kind}-${row.id}`}
              className={`tree-row tree-row--${row.kind}`}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`,
                paddingLeft: `${row.depth * 16 + 8}px`,
              }}
              onClick={() =>
                row.kind === "dir" ? toggleDir(row.id) : onSelectFile?.(files.find((f) => f.id === row.id)!)
              }
            >
              {row.kind === "dir" ? (
                <span className="tree-caret">{row.expanded ? "▾" : "▸"}</span>
              ) : (
                <span className="tree-caret tree-caret--file" />
              )}
              <span className="tree-name">{row.name}</span>
              {progress && <ProgressBadges progress={progress} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ProgressBadges({ progress }: { progress: ProgressInfo }) {
  return (
    <span className="tree-progress">
      <span
        className={`progress-badge${progress.translation_progress === 100 ? " progress-badge--full" : ""}`}
        title="Translated"
      >
        {progress.translation_progress}%
      </span>
      <span
        className={`progress-badge progress-badge--approved${progress.approval_progress === 100 ? " progress-badge--full" : ""}`}
        title="Approved"
      >
        {progress.approval_progress}%
      </span>
    </span>
  );
}
