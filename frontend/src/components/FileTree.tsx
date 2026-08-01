import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type ProgressInfo, type TreeDirectory, type TreeFile } from "../api/client";
import { onProgressChanged } from "../progressEvents";
import { timeAgo } from "../timeAgo";
import { ProgressHover, ProgressPie } from "./ProgressPie";

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
  /** Ask the tree to reveal a file: expand every folder above it and
   * scroll it into view. Carries an incrementing counter rather than a
   * bare id so asking twice for the SAME file still fires — otherwise
   * the second click on the button would do nothing. */
  revealRequest?: { fileId: number; n: number } | null;
  /** Files with an open tab, and which of them is showing. Drawn as two
   * different weights: every open file gets a faint marker so the tree
   * shows where you've been working, and the active one gets a stronger
   * treatment so "where am I" is answerable at a glance. */
  openFileIds?: number[];
  activeFileId?: number | null;
  sync: SyncState;
  lastFullSyncAt: string | null;
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

// Mirrors DIRECTORY_PROGRESS_MAX_AGE_SECONDS in progress_sync.py — the
// server won't return anything newer inside this window, so re-asking
// sooner just spends a round trip to be told the same numbers.
const PROGRESS_REFETCH_MS = 15 * 60 * 1000;

/**
 * Renders the whole project tree without ever mounting more than a
 * viewport's worth of DOM rows — this is the direct fix for the bug we
 * profiled in Crowdin's own editor (275,990 live DOM nodes for one open
 * file, because their sidebar renders every node unconditionally).
 * Collapsed folders contribute exactly one row here, regardless of how
 * many thousands of descendants they hold.
 */
export function FileTree({ projectId, languageId, directories, files, onSelectFile, sync, lastFullSyncAt, revealRequest, openFileIds, activeFileId }: FileTreeProps) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [query, setQuery] = useState("");
  const parentRef = useRef<HTMLDivElement>(null);

  // Translation/approval progress, merged in as it's fetched — root on
  // mount, then a directory's children right when it's expanded. Never
  // fetched in bulk (there's no bulk endpoint — see progress_sync.py),
  // so this map only ever grows to cover what's actually been revealed.
  const [dirProgress, setDirProgress] = useState<Map<number, ProgressInfo>>(new Map());
  const [fileProgress, setFileProgress] = useState<Map<number, ProgressInfo>>(new Map());
  // When each parent's children were last asked for, not merely whether
  // they ever were. The old "fetched once, never again" guard outlived its
  // purpose: the server caches these itself now and expires a directory
  // aggregate on its own schedule, so re-asking is a local database read
  // unless something is genuinely due a refresh. Holding the guard for the
  // whole session meant a folder expanded at 9am kept showing 9am's
  // numbers until the app restarted, no matter what anyone translated
  // in it since. Matches the server's own window (see
  // DIRECTORY_PROGRESS_MAX_AGE_SECONDS) so a re-ask that would be answered
  // from cache anyway is skipped before it costs a request.
  const fetchedParents = useRef<Map<number | "root", number>>(new Map());
  // Separate from the timestamps above so a slow request can't be issued
  // twice by a quick collapse/expand — this clears when it settles, the
  // timestamp only records a success.
  const inFlightParents = useRef<Set<number | "root">>(new Set());

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
    if (inFlightParents.current.has(parentId)) return;
    const lastFetched = fetchedParents.current.get(parentId);
    if (lastFetched != null && Date.now() - lastFetched < PROGRESS_REFETCH_MS) return;
    inFlightParents.current.add(parentId);
    api
      .getTreeProgress(projectId, languageId, parentId === "root" ? undefined : parentId)
      .then((result) => {
        // Only a success starts the clock — a failed fetch leaves no
        // timestamp, so the next expand retries immediately rather than
        // waiting out a window it never actually filled.
        fetchedParents.current.set(parentId, Date.now());
        mergeProgress(result);
      })
      .catch(() => {})
      .finally(() => inFlightParents.current.delete(parentId));
  };

  useEffect(() => {
    // Switching project or language without a full page reload (the
    // header picker) left this component mounted, so fetchedParents/
    // dirProgress/fileProgress still held the PREVIOUS project's or
    // language's data — "root" already being in fetchedParents meant
    // the guard below silently skipped re-fetching it for whatever's
    // now selected, leaving root-level items with no progress at all
    // (or, switching language only, stale percentages from the old
    // language mislabeled as the new one). Clear all three before
    // fetching fresh.
    fetchedParents.current = new Map();
    setDirProgress(new Map());
    setFileProgress(new Map());
    fetchProgressFor("root");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, languageId]);

  // A translation elsewhere (approve/unapprove/delete/submit) changed a
  // file's counts — fetchProgressFor's own "already fetched, never
  // again" guard means the stale cached percentage would otherwise
  // never refresh on its own for the rest of the session (see bug
  // report: an approved file still showing its old 50%). Drop the
  // "already fetched" guard for the file's own directory AND every
  // ancestor up to the root (each level's aggregate depends on its
  // children) and re-fetch all of them — scoped to exactly that
  // ancestry chain, not the whole tree, since a sibling folder's counts
  // didn't change.
  //
  // Deliberately NOT clearing dirProgress/fileProgress here first: an
  // earlier version did, which meant every bar on the ancestry path blanked
  // out the instant a translation was saved/approved/deleted and only
  // reappeared once the re-fetch resolved — visually indistinguishable
  // from "the whole tree just reloaded" even though only a handful of
  // rows were ever actually involved. mergeProgress below overwrites the
  // old value in place once the fresh one arrives, so the bar just holds
  // its last known percentage for that one request round-trip instead.
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


  // Expand the chain of folders above a file, then scroll to it. Runs after
  // the expansion has been applied — the row doesn't exist in the virtual
  // list until its ancestors are open, so scrolling in the same tick would
  // find nothing to scroll to.
  const pendingRevealRef = useRef<number | null>(null);
  useEffect(() => {
    if (!revealRequest) return;
    const file = files.find((f) => f.id === revealRequest.fileId);
    if (!file) return;
    const dirById = new Map(directories.map((d) => [d.id, d]));
    const chain: number[] = [];
    let dirId: number | null | undefined = file.directory_id;
    while (dirId != null) {
      chain.push(dirId);
      dirId = dirById.get(dirId)?.parent_id ?? null;
    }
    setExpanded((prev) => new Set([...prev, ...chain]));
    pendingRevealRef.current = revealRequest.fileId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealRequest?.n]);

  useEffect(() => {
    const target = pendingRevealRef.current;
    if (target == null) return;
    const index = treeRows.findIndex((r) => r.kind === "file" && r.id === target);
    if (index < 0) return;
    pendingRevealRef.current = null;
    virtualizer.scrollToIndex(index, { align: "center" });
    setRevealedFileId(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [treeRows]);

  // Brief highlight so the eye lands on the right row after the scroll.
  const [revealedFileId, setRevealedFileId] = useState<number | null>(null);
  useEffect(() => {
    if (revealedFileId == null) return;
    const t = window.setTimeout(() => setRevealedFileId(null), 1800);
    return () => window.clearTimeout(t);
  }, [revealedFileId]);

  // Set rather than array.includes on every row — the tree renders
  // thousands of rows and this runs per row per render.
  const openFileIdSet = useMemo(() => new Set(openFileIds ?? []), [openFileIds]);

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
        <div className="search-input-wrap">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search files by path…"
          />
          {query && (
            <button className="search-input-clear" onClick={() => setQuery("")} title="Clear search">
              ×
            </button>
          )}
        </div>
        <button
          className={`icon-btn file-tree-sync-btn${sync.changed ? " file-tree-sync-btn--changed" : ""}`}
          onClick={sync.trigger}
          disabled={sync.isPending}
          title={
            sync.isPending
              ? "Syncing…"
              : sync.changed
                ? "Activity detected on Crowdin — click to check for changes"
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
                className={`tree-row tree-row--${row.kind}${row.kind === 'file' && openFileIdSet.has(row.id) ? ' tree-row--open' : ''}${row.kind === 'file' && row.id === activeFileId ? ' tree-row--active' : ''}${row.kind === 'file' && row.id === revealedFileId ? ' tree-row--revealed' : ''}`}
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
// approved. Approved is always a subset of translated, so the bar encodes
// it as a single layered indicator — green from 0 to approved%, blue from
// approved% to translated%, a neutral track for the rest — rather than two
// separate indicators. That layering also means "fully translated and
// approved" naturally renders as solid green with no special-casing
// needed... except we still collapse it to a small mark below, since the
// goal is decluttering an otherwise-solid-color pill that no longer
// carries any information once there's nothing left incomplete.
//
// Colors come from CSS variables (--progress-translated/--progress-
// approved, defined in styles.css) rather than fixed hex here, so they
// can differ between light and dark theme — a green tuned dark enough
// to stay distinct from blue on a white background reads as almost
// invisible on a near-black one, so each theme needs its own pair.
//
// ProgressPie (used for files, both here and in TabBar's tabs) lives in
// ./ProgressPie — ProgressBar stays here since directories are only ever
// rendered by this tree.
const TRANSLATED_COLOR = "var(--progress-translated)";
const APPROVED_COLOR = "var(--progress-approved)";

function ProgressBar({ progress }: { progress: ProgressInfo }) {
  const { translation_progress: t, approval_progress: a } = progress;

  if (t === 100 && a === 100) {
    return (
      <ProgressHover progress={progress} className="progress-mark">
        ✓
      </ProgressHover>
    );
  }

  return (
    <ProgressHover
      progress={progress}
      className={`progress-bar${t === 100 ? " progress-bar--complete" : ""}`}
    >
      <span style={{ width: `${a}%`, background: APPROVED_COLOR }} />
      <span style={{ width: `${t - a}%`, background: TRANSLATED_COLOR }} />
    </ProgressHover>
  );
}
