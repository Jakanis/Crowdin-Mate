import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { fullDateTime, timeAgo } from "../timeAgo";

function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);
  return online;
}

/**
 * Header indicator for the durable translation outbox (offline_queue.py) —
 * the whole point of that queue is that a translation typed with no
 * internet at all is never lost, but until now there was nowhere in the
 * UI that actually showed it happened. navigator.onLine covers the
 * literal "no network" case this was built for; the queue count is
 * queried regardless of that flag since a request can still fail for
 * other reasons (Crowdin down, a permanent validation rejection) even
 * with a live connection.
 */
/** Operations that act on a comment rather than a translation — a failure
 * in one of these is only actionable with the comments panel open, so the
 * jump opens it rather than just landing on the string. */
const COMMENT_OPERATIONS = new Set(["add_comment", "set_comment_status"]);

interface OfflineIndicatorProps {
  projectId: number;
  languageId: string;
  /** Jump to the string a queued operation belongs to, so a failure is
   * one click from the thing that failed instead of a string id to go
   * hunt for. `openComments` is set for comment operations. */
  onJumpToItem?: (fileId: number, stringId: number, openComments: boolean) => void;
}

function PowerIcon() {
  return (
    <svg width="1em" height="1em" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M8 2V8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path
        d="M4.6 4.4a4.6 4.6 0 106.8 0"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Quit, as two clicks rather than one.
 *
 * It sits in the header next to a badge people click all the time to check
 * the queue, and the cost of a slip is the whole app vanishing mid-sentence.
 * Nothing is actually lost — drafts and the queue are in SQLite the moment
 * they're made — but having to restart and find your place again is annoying
 * enough to be worth one deliberate confirmation. Disarms itself after a few
 * seconds so it can't sit armed indefinitely waiting to catch a later click.
 */
function QuitButton() {
  const [armed, setArmed] = useState(false);
  const [stopped, setStopped] = useState(false);

  useEffect(() => {
    if (!armed) return;
    // Long enough to be a confirmation rather than a reflex test — noticing
    // the button changed, deciding, and clicking again is easily a few
    // seconds, and having it disarm underneath you turns one deliberate
    // quit into two confusing clicks that appear to do nothing.
    const t = window.setTimeout(() => setArmed(false), 6000);
    return () => window.clearTimeout(t);
  }, [armed]);

  const quit = useMutation({
    mutationFn: api.shutdown,
    // The server stops a moment after answering, so anything still polling
    // would start throwing connection errors at a UI that can no longer do
    // anything about them. The overlay replaces the app outright.
    onSuccess: () => setStopped(true),
    // A native window destroys itself before this resolves, which surfaces
    // as a network error rather than a failure — treat it the same.
    onError: () => setStopped(true),
  });

  if (stopped) {
    return (
      <div className="app-stopped-overlay">
        <div className="app-stopped-card">
          <h2>Crowdin Mate has stopped</h2>
          <p>
            Everything you'd typed is saved. Close this tab — reopening the app starts it
            again.
          </p>
        </div>
      </div>
    );
  }

  return (
    <button
      className={`icon-btn quit-button${armed ? " quit-button--armed" : ""}`}
      onClick={() => (armed ? quit.mutate() : setArmed(true))}
      disabled={quit.isPending}
      title={armed ? "Click again to quit" : "Quit Crowdin Mate"}
      aria-label={armed ? "Confirm quit" : "Quit"}
    >
      {armed ? "?" : <PowerIcon />}
    </button>
  );
}

function CacheRow({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="cache-row" title={title}>
      <span className="cache-row-label">{label}</span>
      <span className="cache-row-value">{value}</span>
    </div>
  );
}

export function OfflineIndicator({ projectId, languageId, onJumpToItem }: OfflineIndicatorProps) {
  const queryClient = useQueryClient();
  const browserOnline = useOnlineStatus();
  const [open, setOpen] = useState(false);

  const queueQuery = useQuery({
    queryKey: ["offline-queue"],
    queryFn: api.getOfflineQueue,
    refetchInterval: 10_000,
  });
  const items = queueQuery.data?.items ?? [];
  const pendingCount = items.filter((i) => i.status === "pending").length;
  const failedCount = items.filter((i) => i.status === "failed").length;

  // Developer-only testing toggle (see debug_mode.py) — forces every
  // Crowdin call on the backend to fail as if the network were down, so
  // the whole offline queue path (enqueue/drain/retry/this indicator)
  // can actually be exercised without literally cutting the machine's
  // network, which would also break every other app using it and
  // doesn't reliably hit the same code path as a Crowdin-specific
  // outage anyway. The badge reflects this alongside the real
  // navigator.onLine signal so the UI stays coherent during a test —
  // "Offline" should mean writes are actually queuing, regardless of
  // which of the two caused it.
  const simulateOfflineQuery = useQuery({
    queryKey: ["simulate-offline"],
    queryFn: api.getSimulateOffline,
  });
  const simulatedOffline = simulateOfflineQuery.data?.enabled ?? false;
  const online = browserOnline && !simulatedOffline;

  const simulateOfflineMutation = useMutation({
    mutationFn: (enabled: boolean) => api.setSimulateOffline(enabled),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["simulate-offline"] }),
  });

  // Only fetched while the panel is open — it's a dozen COUNT(*)s over the
  // whole cache, which is cheap (~0.2s on a 19k-file project) but pointless
  // to run on a timer for a panel nobody's looking at.
  const cacheQuery = useQuery({
    queryKey: ["cache-status", projectId, languageId],
    queryFn: () => api.getCacheStatus(projectId, languageId),
    enabled: open,
  });
  const cache = cacheQuery.data;

  // Polled while running so the file path and counts move; otherwise only
  // fetched with the panel open, same as the cache summary.
  const precacheQuery = useQuery({
    queryKey: ["offline-cache-status", projectId, languageId],
    queryFn: () => api.getOfflineCacheStatus(projectId, languageId),
    enabled: open,
    refetchInterval: (query) => (query.state.data?.running ? 1000 : false),
  });
  const precache = precacheQuery.data;

  const invalidateCacheViews = () => {
    queryClient.invalidateQueries({ queryKey: ["offline-cache-status", projectId, languageId] });
    queryClient.invalidateQueries({ queryKey: ["cache-status", projectId, languageId] });
  };
  const startPrecache = useMutation({
    mutationFn: () => api.buildOfflineCache(projectId, languageId),
    onSuccess: invalidateCacheViews,
  });
  const stopPrecache = useMutation({
    mutationFn: () => api.stopOfflineCache(projectId, languageId),
    onSuccess: invalidateCacheViews,
  });

  const clearCompleted = useMutation({
    mutationFn: api.clearCompletedQueue,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["cache-status", projectId, languageId] }),
  });

  const drainMutation = useMutation({
    mutationFn: api.drainOfflineQueue,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["offline-queue"] }),
  });
  const retryMutation = useMutation({
    mutationFn: (itemId: number) => api.retryOfflineQueueItem(itemId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["offline-queue"] }),
  });
  const deleteMutation = useMutation({
    mutationFn: (itemId: number) => api.deleteOfflineQueueItem(itemId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["offline-queue"] }),
  });

  const hasQueueItems = items.length > 0;

  return (
    <div className="offline-indicator">
      <button
        className={`offline-indicator-badge${online ? "" : " offline-indicator-badge--offline"}`}
        onClick={() => setOpen((v) => !v)}
        title={simulatedOffline ? "Offline (simulated for testing)" : online ? "Online" : "No network connection"}
      >
        <span className={`offline-dot${online ? "" : " offline-dot--offline"}`} />
        {online ? "Online" : "Offline"}
        {hasQueueItems && <span className="offline-queue-count">{items.length}</span>}
      </button>
      <QuitButton />
      {open && (
        <>
          <div className="settings-backdrop" onClick={() => setOpen(false)} />
          <div className="settings-popover offline-queue-popover">
            <div className="settings-section">
              <div className="settings-label">
                Pending translations {pendingCount > 0 && `(${pendingCount})`}
                {failedCount > 0 && ` — ${failedCount} failed`}
              </div>
              {!hasQueueItems && <p className="hint offline-queue-empty">Nothing queued — everything's synced.</p>}
              {hasQueueItems && (
                <div className="offline-queue-list">
                  {items.map((item) => (
                    <div key={item.id} className="offline-queue-item">
                      <div className="offline-queue-item-file">{item.file_path ?? `String ${item.string_id}`}</div>
                      <div className="offline-queue-item-text">{item.draft_text ?? item.source_text}</div>
                      <div className="offline-queue-item-meta">
                        <span className={`offline-queue-status offline-queue-status--${item.status}`}>
                          {item.status === "failed" ? "Failed" : "Queued"}
                        </span>
                        <span title={fullDateTime(item.created_at)}>{timeAgo(item.created_at)}</span>
                        {onJumpToItem && item.file_id != null && (
                          <button
                            className="link-button"
                            onClick={() => {
                              onJumpToItem(
                                item.file_id!,
                                item.string_id,
                                COMMENT_OPERATIONS.has(item.operation_type),
                              );
                              setOpen(false);
                            }}
                          >
                            Open string
                          </button>
                        )}
                        {item.status === "failed" && (
                          <>
                            <button
                              className="link-button"
                              onClick={() => retryMutation.mutate(item.id)}
                              disabled={retryMutation.isPending}
                            >
                              Retry
                            </button>
                            <button
                              className="link-button offline-queue-discard"
                              onClick={() => {
                                if (confirm("Discard this translation? It will not be sent to Crowdin.")) {
                                  deleteMutation.mutate(item.id);
                                }
                              }}
                              disabled={deleteMutation.isPending}
                            >
                              Discard
                            </button>
                          </>
                        )}
                      </div>
                      {item.last_error && <div className="offline-queue-item-error">{item.last_error}</div>}
                    </div>
                  ))}
                </div>
              )}
              {pendingCount > 0 && (
                <button onClick={() => drainMutation.mutate()} disabled={drainMutation.isPending}>
                  {drainMutation.isPending ? "Retrying…" : "Retry now"}
                </button>
              )}
            </div>

            <div className="settings-section">
              <div className="settings-label">Available offline</div>
              {cacheQuery.isLoading && <p className="hint">Checking…</p>}
              {cache && (
                <div className="cache-rows">
                  {/* Deliberately first and phrased as a ratio: the tree
                      lists every file, but only these are workable with no
                      connection, and the gap is usually enormous. */}
                  <CacheRow
                    label="Files ready"
                    value={
                      `${cache.files_cached.toLocaleString()} / ${cache.files_total.toLocaleString()}` +
                      (cache.files_stale > 0 ? ` · ${cache.files_stale} stale` : "")
                    }
                    title={
                      "Files whose strings and translations are fully cached for this language. " +
                      "Content is cached per file as you open it, so the rest need a connection." +
                      (cache.files_stale > 0
                        ? ` ${cache.files_stale} have changed on Crowdin since they were cached.`
                        : "")
                    }
                  />
                  <CacheRow label="Strings" value={cache.strings.toLocaleString()} />
                  <CacheRow label="Translations" value={cache.translations.toLocaleString()} />
                  <CacheRow
                    label="Search index"
                    value={`${cache.search_indexed.toLocaleString()} files`}
                    title="Files with a cached target-language snippet, used by search when offline."
                  />
                  <CacheRow
                    label="Glossary"
                    value={
                      `${cache.glossary_terms.toLocaleString()} terms` +
                      (cache.glossary_synced_at ? ` · ${timeAgo(cache.glossary_synced_at)}` : "")
                    }
                    title={cache.glossary_synced_at ? fullDateTime(cache.glossary_synced_at) : undefined}
                  />
                  <CacheRow
                    label="TM lookups"
                    value={cache.tm_lookups.toLocaleString()}
                    title="Strings with cached translation-memory suggestions."
                  />
                  <CacheRow
                    label="File tree"
                    value={
                      cache.tree_synced_at
                        ? `${cache.directories.toLocaleString()} folders · ${timeAgo(cache.tree_synced_at)}`
                        : "never synced"
                    }
                    title={cache.tree_synced_at ? fullDateTime(cache.tree_synced_at) : undefined}
                  />
                  {cache.pending_drafts > 0 && (
                    <CacheRow
                      label="Unsent drafts"
                      value={cache.pending_drafts.toLocaleString()}
                      title="Edits typed but not submitted. Kept locally and restored when you come back."
                    />
                  )}
                  {cache.queue_done > 0 && (
                    <div className="cache-row">
                      <span className="cache-row-label">Completed queue items</span>
                      <button
                        className="link-button"
                        onClick={() => clearCompleted.mutate()}
                        disabled={clearCompleted.isPending}
                        title="Successfully sent items are kept as a record and never removed on their own."
                      >
                        clear {cache.queue_done}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {precache && (
                <div className="cache-precache">
                  {precache.running ? (
                    <>
                      <div className="cache-progress-bar">
                        <div
                          className="cache-progress-bar-fill"
                          style={{
                            width: `${precache.total ? (precache.cached / precache.total) * 100 : 0}%`,
                          }}
                        />
                      </div>
                      <div className="cache-precache-actions">
                        <span className="cache-row-label">
                          Caching… {precache.pending.toLocaleString()} left
                          {precache.errors > 0 && ` · ${precache.errors} failed`}
                        </span>
                        <button
                          className="link-button"
                          onClick={() => stopPrecache.mutate()}
                          disabled={stopPrecache.isPending}
                        >
                          Stop
                        </button>
                      </div>
                      {precache.current_file_path && (
                        <div className="cache-precache-current">{precache.current_file_path}</div>
                      )}
                    </>
                  ) : (
                    <button
                      onClick={() => startPrecache.mutate()}
                      disabled={startPrecache.isPending}
                      title={
                        precache.pending === 0
                          ? "Every file is cached. This also checks Crowdin for strings other " +
                            "people have translated since — a file's own timestamp doesn't move " +
                            "when someone translates in it, so those can't be spotted locally."
                          : `Caches the ${precache.pending.toLocaleString()} files not yet cached ` +
                            "or changed since, so the project works with no connection. One " +
                            "request per file with no bulk equivalent, so a first full run takes " +
                            "a while — start it before you need it. Safe to stop and resume."
                      }
                    >
                      {/* Never disabled at zero: pending only counts what's
                          knowable from the local cache, and translations by
                          other people aren't. Starting a run is how you find
                          out, so the button has to stay clickable. */}
                      {precache.pending === 0
                        ? "Check for updates"
                        : `Cache files for offline (${precache.pending.toLocaleString()})`}
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Testing affordance, so it sits last and stays one line —
                the explanation lives in the tooltip rather than a paragraph
                that outsizes everything above it. */}
            <div className="settings-section offline-simulate-section">
              <label
                className="settings-checkbox"
                title={
                  "Points Crowdin API calls at an unresolvable hostname, so requests fail exactly " +
                  "as they do with no connection — reads fall back to cache and writes queue."
                }
              >
                <input
                  type="checkbox"
                  checked={simulatedOffline}
                  onChange={(e) => simulateOfflineMutation.mutate(e.target.checked)}
                  disabled={simulateOfflineMutation.isPending}
                />
                Simulate offline
              </label>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
