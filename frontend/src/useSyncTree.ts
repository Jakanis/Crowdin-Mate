import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "./api/client";

const MAX_HISTORY = 5;
const FALLBACK_ESTIMATE_MS = 20_000;
const AUTO_CHECK_INTERVAL_MS = 10 * 60_000;

// Per-project — different projects crawl at very different speeds
// (file count varies a lot), so one project's history shouldn't skew
// another's progress estimate.
function durationsKey(projectId: number) {
  return `classicua-sync-durations-${projectId}`;
}

function loadDurations(projectId: number): number[] {
  try {
    const raw = localStorage.getItem(durationsKey(projectId));
    return raw ? (JSON.parse(raw) as number[]) : [];
  } catch {
    return [];
  }
}

function recordDuration(projectId: number, ms: number) {
  const durations = [...loadDurations(projectId), ms].slice(-MAX_HISTORY);
  localStorage.setItem(durationsKey(projectId), JSON.stringify(durations));
}

function averageDuration(projectId: number): number {
  const durations = loadDurations(projectId);
  if (durations.length === 0) return FALLBACK_ESTIMATE_MS;
  return durations.reduce((a, b) => a + b, 0) / durations.length;
}

/**
 * Wraps the "Sync tree" button's mutation with a progress estimate, and
 * separately runs a periodic background check for upstream changes.
 *
 * - Progress estimate: Crowdin has no progress-reporting endpoint for
 *   this crawl, but it consistently takes roughly the same time on a
 *   given project, so an average of the last few real run durations
 *   (localStorage, not a big deal to lose on a cache clear) is a
 *   reasonable stand-in for a real percentage. Capped at 95% until the
 *   call actually resolves, so it never lies about being done. Only the
 *   manual button gets this treatment — see below for why.
 *
 * - Background check (every 10 minutes): this used to unconditionally
 *   re-run the full directories/files/labels crawl on a timer, which
 *   for a project with tens of thousands of files meant silently
 *   re-crawling everything every 10 minutes whether or not anything had
 *   actually changed. Replaced with a cheap single-API-call check
 *   (get_project's lastActivity — see check_and_sync_if_changed on the
 *   backend) that only escalates to an actual full crawl when something
 *   has genuinely changed since last time. Deliberately silent/no
 *   progress-bar for this path — it runs in the background, not while
 *   someone's actively watching and waiting the way clicking the button
 *   implies — but its end effects (tree query invalidated,
 *   changed_file_ids surfaced for the stale-file banner) are identical
 *   to a manual sync whenever it does end up running one.
 */
export function useSyncTree(projectId: number) {
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<number | null>(null);
  const [changedFileIds, setChangedFileIds] = useState<number[]>([]);
  const startRef = useRef<number | null>(null);
  const estimateRef = useRef(FALLBACK_ESTIMATE_MS);
  const progressTimerRef = useRef<number | null>(null);

  const applySyncResult = (result: { changed_file_ids: number[] }) => {
    queryClient.invalidateQueries({ queryKey: ["tree", projectId] });
    setChangedFileIds(result.changed_file_ids);
  };

  const mutation = useMutation({
    mutationFn: () => api.syncTree(projectId),
    onMutate: () => {
      startRef.current = performance.now();
      estimateRef.current = averageDuration(projectId);
      setProgress(0);
      progressTimerRef.current = window.setInterval(() => {
        if (startRef.current == null) return;
        const elapsed = performance.now() - startRef.current;
        setProgress(Math.min(0.95, elapsed / estimateRef.current));
      }, 200);
    },
    onSuccess: applySyncResult,
    onSettled: () => {
      if (progressTimerRef.current != null) window.clearInterval(progressTimerRef.current);
      if (startRef.current != null) recordDuration(projectId, performance.now() - startRef.current);
      setProgress(1);
      window.setTimeout(() => setProgress(null), 500);
    },
  });

  const checkMutation = useMutation({
    mutationFn: () => api.checkSyncTree(projectId),
    onSuccess: (result) => {
      if (result.synced) applySyncResult(result);
    },
  });

  // Refs so the interval (set up once on mount) always calls the latest
  // mutate function and sees the latest pending state, without needing
  // the effect itself to re-run every render.
  const checkMutateRef = useRef(checkMutation.mutate);
  checkMutateRef.current = checkMutation.mutate;
  const isPendingRef = useRef(false);
  isPendingRef.current = mutation.isPending || checkMutation.isPending;
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  useEffect(() => {
    const id = window.setInterval(() => {
      // projectId is 0 before a project's actually been picked (see
      // App.tsx's useSyncTree(projectId ?? 0)) — skip rather than check
      // a bogus project id in that brief window.
      if (!isPendingRef.current && projectIdRef.current) checkMutateRef.current();
    }, AUTO_CHECK_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, []);

  return {
    trigger: () => mutation.mutate(),
    isPending: mutation.isPending,
    progress,
    changedFileIds,
  };
}
