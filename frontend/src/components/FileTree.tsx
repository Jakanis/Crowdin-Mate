import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type ProgressInfo, type TreeDirectory, type TreeFile } from "../api/client";
import { onProgressChanged } from "../progressEvents";

interface SyncState {
  trigger: () => void;
  isPending: boolean;
  changed: boolean;
  progress: number | null;
}

interface FileTreeProps {
  projectId: number;
  languageId: string;
  directories: TreeDirectory[];
  files: TreeFile[];
  onSelectFile?: (file: TreeFile) => void;
  sync: SyncState;
  lastFullSyncAt: string | null;
}

function timeAgo(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function SyncIcon({ spinning }: { spinning?: boolean }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={spinning ? "icon-spin" : undefined}
    >
      <path d="M13 4.5A5.5 5.5 0 1 1 11.5 2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M13 1.8V4.6H10.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function matchesQuery(file: TreeFile, query: string): boolean {
  return file.path.toLowerCase().includes(query);
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
export function FileTree({ projectId, languageId, directories, files, onSelectFile, sync, lastFullSyncAt }: FileTreeProps) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [query, setQuery] = useState("");
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

  // A translation elsewhere (approve/unapprove/delete/submit) changed a
  // file's counts — fetchProgressFor's own "already fetched, never
  // again" guard means the stale cached percentage would otherwise
  // never refresh on its own for the rest of the session (see bug
  // report: an approved file still showing its old 50%). Drop the
  // cached values and the "already fetched" guard for the file's own
  // directory AND every ancestor up to the root (each level's aggregate
  // depends on its children), then re-fetch all of them.
  useEffect(() => {
    return onProgressChanged((fileId) => {
      const file = files.find((f) => f.id === fileId);
      if (!file) return;

      const ancestry: (number | "root")[] = ["root"];
      let dirId: number | null = file.directory_id;
      while (dirId != null) {
        ancestry.push(dirId);
        const dir = directories.find((d) => d.id === dirId);
        dirId = dir ? dir.parent_id : null;
      }

      setFileProgress((prev) => {
        const next = new Map(prev);
        next.delete(fileId);
        return next;
      });
      setDirProgress((prev) => {
        const next = new Map(prev);
        for (const id of ancestry) if (id !== "root") next.delete(id);
        return next;
      });
      for (const parentId of ancestry) {
        fetchedParents.current.delete(parentId);
        fetchProgressFor(parentId);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, directories]);

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

  const trimmedQuery = query.trim().toLowerCase();
  const searching = trimmedQuery.length > 0;

  // Search is a plain case-insensitive substring match against each
  // file's full path — "Valley/The Great Retri" matches
  // "/quests_tbc/Outland/Shadowmoon Valley/The Great Retribution_10817.xml"
  // the same way pasting a chunk of a path copied from elsewhere would.
  // Keeps the real tree shape rather than flattening to a bare list:
  // walks the same parent/child maps as the normal tree, but only
  // descends into directories that are an ancestor of some match (force-
  // shown as expanded regardless of the user's real expand/collapse
  // state) and only lists files that match. Folders with no matching
  // descendant are skipped entirely rather than shown collapsed.
  const searchResult = useMemo(() => {
    if (!searching) return null;

    const matchedFiles = files.filter((f) => matchesQuery(f, trimmedQuery));
    const matchedFileIds = new Set(matchedFiles.map((f) => f.id));
    const dirsById = new Map(directories.map((d) => [d.id, d]));
    const ancestorDirIds = new Set<number>();
    for (const f of matchedFiles) {
      let dirId = f.directory_id;
      while (dirId != null && !ancestorDirIds.has(dirId)) {
        ancestorDirIds.add(dirId);
        dirId = dirsById.get(dirId)?.parent_id ?? null;
      }
    }

    const out: Row[] = [];
    const walk = (parentId: number | null, depth: number) => {
      for (const dir of childDirsByParent.get(parentId) ?? []) {
        if (!ancestorDirIds.has(dir.id)) continue;
        out.push({ kind: "dir", id: dir.id, depth, name: dir.name, expanded: true });
        walk(dir.id, depth + 1);
        for (const file of childFilesByDir.get(dir.id) ?? []) {
          if (matchedFileIds.has(file.id)) {
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
    for (const file of childFilesByDir.get(null) ?? []) {
      if (matchedFileIds.has(file.id)) {
        out.push({ kind: "file", id: file.id, depth: 0, name: file.name, stringsCount: file.strings_count });
      }
    }

    return { rows: out, ancestorDirIds, matchCount: matchedFiles.length };
  }, [files, directories, childDirsByParent, childFilesByDir, trimmedQuery, searching]);

  // Prefetch progress for every folder revealed by the search the same
  // way expanding it by hand would, so bars/pies aren't blank just
  // because the folder was force-shown rather than manually toggled.
  useEffect(() => {
    if (!searchResult) return;
    for (const dirId of searchResult.ancestorDirIds) fetchProgressFor(dirId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchResult]);

  const treeRows = useMemo(() => {
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

  const rows = searchResult ? searchResult.rows : treeRows;

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
    <div className="file-tree-panel">
      <div className="file-tree-search">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search files by path…"
        />
        {query && (
          <button className="file-tree-search-clear" onClick={() => setQuery("")} title="Clear search">
            ×
          </button>
        )}
        <button
          className={`icon-btn file-tree-sync-btn${sync.changed ? " file-tree-sync-btn--changed" : ""}`}
          onClick={sync.trigger}
          disabled={sync.isPending}
          title={
            sync.isPending
              ? "Syncing…"
              : sync.changed
                ? "Changes detected on Crowdin — click to sync"
                : lastFullSyncAt
                  ? `Last synced ${timeAgo(lastFullSyncAt)}`
                  : "Never fully synced yet"
          }
        >
          <SyncIcon spinning={sync.isPending} />
        </button>
      </div>
      {sync.progress != null && (
        <span className="sync-progress" title="Estimated from previous sync durations">
          <span className="sync-progress-fill" style={{ width: `${sync.progress * 100}%` }} />
        </span>
      )}
      {searchResult && (
        <div className="file-tree-search-status">
          {searchResult.matchCount === 0
            ? "No files match"
            : `${searchResult.matchCount} match${searchResult.matchCount === 1 ? "" : "es"}`}
        </div>
      )}
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
                  row.kind === "dir"
                    ? !searching && toggleDir(row.id)
                    : onSelectFile?.(files.find((f) => f.id === row.id)!)
                }
              >
                {row.kind === "dir" ? (
                  <span className="tree-caret">{row.expanded ? "▾" : "▸"}</span>
                ) : (
                  <span className="tree-caret tree-caret--file" />
                )}
                <span className="tree-name" title={row.name}>
                  {row.name}
                </span>
                {progress &&
                  (row.kind === "dir" ? (
                    <ProgressBar progress={progress} />
                  ) : (
                    <ProgressPie progress={progress} />
                  ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// Matches Crowdin's own color convention: blue for translated, green for
// approved. Approved is always a subset of translated, so both bar and
// pie encode it as a single layered indicator — green from 0 to approved%,
// blue from approved% to translated%, a neutral track for the rest —
// rather than two separate indicators. That layering also means "fully
// translated and approved" naturally renders as solid green with no
// special-casing needed... except we still collapse it to a small mark
// below, since the goal is decluttering an otherwise-solid-color pill/
// circle that no longer carries any information once there's nothing
// left incomplete.
//
// Colors come from CSS variables (--progress-translated/--progress-
// approved, defined in styles.css) rather than fixed hex here, so they
// can differ between light and dark theme — a green tuned dark enough
// to stay distinct from blue on a white background reads as almost
// invisible on a near-black one, so each theme needs its own pair.
const TRANSLATED_COLOR = "var(--progress-translated)";
const APPROVED_COLOR = "var(--progress-approved)";
const TRACK_COLOR = "rgba(128, 128, 128, 0.18)";

function progressTitle(p: ProgressInfo): string {
  return `${p.translation_progress}% translated, ${p.approval_progress}% approved`;
}

function ProgressBar({ progress }: { progress: ProgressInfo }) {
  const { translation_progress: t, approval_progress: a } = progress;

  if (t === 100 && a === 100) {
    return (
      <span className="progress-mark" title={progressTitle(progress)}>
        ✓
      </span>
    );
  }

  return (
    <span
      className={`progress-bar${t === 100 ? " progress-bar--complete" : ""}`}
      title={progressTitle(progress)}
    >
      <span style={{ width: `${a}%`, background: APPROVED_COLOR }} />
      <span style={{ width: `${t - a}%`, background: TRANSLATED_COLOR }} />
    </span>
  );
}

// Built from stacked solid-stroke circles rather than a conic-gradient —
// see the note above .progress-bar in styles.css for why. A circle
// stroked at half its own radius, with stroke-width equal to that
// radius, fills the wedge from center to edge exactly like a pie slice;
// stroke-dasharray/dashoffset then trims that ring down to a percentage.
function ProgressPie({ progress }: { progress: ProgressInfo }) {
  const { translation_progress: t, approval_progress: a } = progress;
  const size = 20;
  const r = size / 4;
  const circumference = 2 * Math.PI * r;
  const dash = (pct: number) => `${(circumference * pct) / 100} ${circumference}`;

  return (
    <svg className="progress-pie" viewBox={`0 0 ${size} ${size}`}>
      <title>{progressTitle(progress)}</title>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={TRACK_COLOR} strokeWidth={size / 2} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={TRANSLATED_COLOR}
        strokeWidth={size / 2}
        strokeDasharray={dash(t)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={APPROVED_COLOR}
        strokeWidth={size / 2}
        strokeDasharray={dash(a)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}
