import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "./api/client";

const MAX_HISTORY = 5;
const FALLBACK_ESTIMATE_MS = 20_000;
const AUTO_SYNC_INTERVAL_MS = 10 * 60_000;

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
 * Wraps the "sync tree" mutation with two things beyond a bare button:
 *
 * - A progress estimate. Crowdin has no progress-reporting endpoint for
 *   this crawl, but it consistently takes roughly the same time on a
 *   given project, so an average of the last few real run durations
 *   (localStorage, not a big deal to lose on a cache clear) is a
 *   reasonable stand-in for a real percentage. Capped at 95% until the
 *   call actually resolves, so it never lies about being done.
 * - A periodic background re-run (every 10 minutes) so upstream source
 *   changes get noticed without the user having to remember to click
 *   the button — same mutation either way, so both paths report
 *   changed_file_ids identically.
 */
export function useSyncTree(projectId: number) {
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<number | null>(null);
  const [changedFileIds, setChangedFileIds] = useState<number[]>([]);
  const startRef = useRef<number | null>(null);
  const estimateRef = useRef(FALLBACK_ESTIMATE_MS);
  const progressTimerRef = useRef<number | null>(null);

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
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["tree", projectId] });
      setChangedFileIds(result.changed_file_ids);
    },
    onSettled: () => {
      if (progressTimerRef.current != null) window.clearInterval(progressTimerRef.current);
      if (startRef.current != null) recordDuration(projectId, performance.now() - startRef.current);
      setProgress(1);
      window.setTimeout(() => setProgress(null), 500);
    },
  });

  // Refs so the interval (set up once on mount) always calls the latest
  // mutate function and sees the latest pending state, without needing
  // the effect itself to re-run every render.
  const mutateRef = useRef(mutation.mutate);
  mutateRef.current = mutation.mutate;
  const isPendingRef = useRef(mutation.isPending);
  isPendingRef.current = mutation.isPending;
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  useEffect(() => {
    const id = window.setInterval(() => {
      // projectId is 0 before a project's actually been picked (see
      // App.tsx's useSyncTree(projectId ?? 0)) — skip rather than sync
      // a bogus project id in that brief window.
      if (!isPendingRef.current && projectIdRef.current) mutateRef.current();
    }, AUTO_SYNC_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, []);

  return {
    trigger: () => mutation.mutate(),
    isPending: mutation.isPending,
    progress,
    changedFileIds,
  };
}
