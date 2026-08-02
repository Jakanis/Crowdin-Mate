import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "./api/client";

const MAX_HISTORY = 5;
const FALLBACK_ESTIMATE_MS = 20_000;
const AUTO_CHECK_INTERVAL_MS = 10 * 60_000;

// How old the cached tree may get before it's re-crawled without being
// asked. The lastActivity check below is what normally prompts a sync, but
// it only paints the button — if you never press it, the tree simply never
// updates, and a file added or renamed a month ago is still missing. This
// bounds that at a day.
const AUTO_SYNC_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Don't retry the automatic sync more often than this. Without it, a crawl
// that fails — offline, an expired token — leaves the tree exactly as stale
// as it was, which re-satisfies the condition and retries on the very next
// tick, forever.
const AUTO_SYNC_RETRY_MS = 60 * 60 * 1000;

// Per-project — different projects crawl at very different speeds
// (file count varies a lot), so one project's history shouldn't skew
// another's progress estimate.
function durationsKey(projectId: number) {
  return `crowdin-mate-sync-durations-${projectId}`;
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
 *   call actually resolves, so it never lies about being done.
 *
 * - Background check (every 10 minutes, plus once on mount/project
 *   switch): this used to unconditionally re-run the full
 *   directories/files/labels crawl on a timer, which for a project with
 *   tens of thousands of files meant silently re-crawling everything
 *   whether or not anything had actually changed — and then it did that
 *   re-crawl invisibly, with no indication anything had happened.
 *   Replaced with a cheap single-API-call check (get_project's
 *   lastActivity — see has_project_changed on the backend) that never
 *   triggers a sync on its own; it only flips `changed` to true so the
 *   sync button can be painted and its hover hint updated. The user
 *   still decides when to actually pull, via the same manual trigger()
 *   as always.
 *
 * - Daily floor: the check above only paints a button, so a tree nobody
 *   presses sync on never updates at all — a file added or renamed weeks
 *   ago stays missing. Once the cached tree passes a day old it re-crawls
 *   on its own. That isn't the timer this hook deliberately removed: this
 *   fires at most once a day against a real staleness measurement, not
 *   every ten minutes regardless.
 */
export function useSyncTree(projectId: number, lastFullSyncAt: string | null) {
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<number | null>(null);
  const [changedFileIds, setChangedFileIds] = useState<number[]>([]);
  const [changed, setChanged] = useState(false);
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
      setChanged(false);
    },
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
      if (result.changed) setChanged(true);
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
    // projectId is 0 before a project's actually been picked (see
    // App.tsx's useSyncTree(projectId ?? 0)) — skip rather than check a
    // bogus project id in that brief window. A "changed" flag from a
    // previously-selected project shouldn't linger after switching.
    setChanged(false);
    if (projectId) checkMutateRef.current();

    const id = window.setInterval(() => {
      if (!isPendingRef.current && projectIdRef.current) checkMutateRef.current();
    }, AUTO_CHECK_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [projectId]);

  // A null lastFullSyncAt means this project has never been crawled, which
  // App.tsx already handles with its own "No cached tree yet" screen and an
  // explicit button — deliberately left alone, so a first run still starts
  // when the user says so rather than on its own.
  const syncMutateRef = useRef(mutation.mutate);
  syncMutateRef.current = mutation.mutate;
  const lastAutoSyncRef = useRef(0);
  // Only the crawl itself, NOT isPendingRef, which also covers the cheap
  // lastActivity check. That check fires on mount and is still in flight at
  // the exact moment the tree query resolves and this first runs — sharing
  // the ref meant the load-time attempt always bailed and the tree waited
  // for the ten-minute tick instead. Caught on a real two-day-old cache
  // that stayed at its old timestamp after a reload.
  const syncPendingRef = useRef(false);
  syncPendingRef.current = mutation.isPending;

  useEffect(() => {
    if (!projectId || lastFullSyncAt == null) return;

    const maybeAutoSync = () => {
      if (syncPendingRef.current || !projectIdRef.current) return;
      const age = Date.now() - new Date(lastFullSyncAt).getTime();
      if (!Number.isFinite(age) || age < AUTO_SYNC_MAX_AGE_MS) return;
      if (Date.now() - lastAutoSyncRef.current < AUTO_SYNC_RETRY_MS) return;
      lastAutoSyncRef.current = Date.now();
      syncMutateRef.current();
    };

    maybeAutoSync();
    // Re-checked on the same tick as the lastActivity probe rather than on
    // its own timer — one is enough, and a session left open for days
    // should still cross the threshold without a reload.
    const id = window.setInterval(maybeAutoSync, AUTO_CHECK_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [projectId, lastFullSyncAt]);

  return {
    trigger: () => mutation.mutate(),
    isPending: mutation.isPending,
    progress,
    changedFileIds,
    changed,
  };
}
