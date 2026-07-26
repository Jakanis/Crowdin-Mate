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
export function OfflineIndicator() {
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
      {open && (
        <>
          <div className="settings-backdrop" onClick={() => setOpen(false)} />
          <div className="settings-popover offline-queue-popover">
            <div className="settings-section offline-simulate-section">
              <label className="settings-checkbox">
                <input
                  type="checkbox"
                  checked={simulatedOffline}
                  onChange={(e) => simulateOfflineMutation.mutate(e.target.checked)}
                  disabled={simulateOfflineMutation.isPending}
                />
                Simulate offline (testing)
              </label>
              <p className="hint">Forces every save to queue locally instead of reaching Crowdin.</p>
            </div>
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
          </div>
        </>
      )}
    </div>
  );
}
