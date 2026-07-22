import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef, useState } from "react";
import type { TreeDirectory, TreeFile } from "../api/client";

interface FileTreeProps {
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
export function FileTree({ directories, files, onSelectFile }: FileTreeProps) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const parentRef = useRef<HTMLDivElement>(null);

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
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div ref={parentRef} className="file-tree-scroll">
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const row = rows[virtualRow.index];
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
              {row.kind === "file" && row.stringsCount != null && (
                <span className="tree-count">{row.stringsCount}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
