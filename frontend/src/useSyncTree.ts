import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "./api/client";

const DURATIONS_KEY = "classicua-sync-durations";
const MAX_HISTORY = 5;
const FALLBACK_ESTIMATE_MS = 20_000;
const AUTO_SYNC_INTERVAL_MS = 10 * 60_000;

function loadDurations(): number[] {
  try {
    const raw = localStorage.getItem(DURATIONS_KEY);
    return raw ? (JSON.parse(raw) as number[]) : [];
  } catch {
    return [];
  }
}

function recordDuration(ms: number) {
  const durations = [...loadDurations(), ms].slice(-MAX_HISTORY);
  localStorage.setItem(DURATIONS_KEY, JSON.stringify(durations));
}

function averageDuration(): number {
  const durations = loadDurations();
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
      estimateRef.current = averageDuration();
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
      if (startRef.current != null) recordDuration(performance.now() - startRef.current);
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

  useEffect(() => {
    const id = window.setInterval(() => {
      if (!isPendingRef.current) mutateRef.current();
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
