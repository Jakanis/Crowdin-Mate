import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../api/client";

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

function timeAgo(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
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
  const online = useOnlineStatus();
  const [open, setOpen] = useState(false);

  const queueQuery = useQuery({
    queryKey: ["offline-queue"],
    queryFn: api.getOfflineQueue,
    refetchInterval: 10_000,
  });
  const items = queueQuery.data?.items ?? [];
  const pendingCount = items.filter((i) => i.status === "pending").length;
  const failedCount = items.filter((i) => i.status === "failed").length;

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
        title={online ? "Online" : "No network connection"}
      >
        <span className={`offline-dot${online ? "" : " offline-dot--offline"}`} />
        {online ? "Online" : "Offline"}
        {hasQueueItems && <span className="offline-queue-count">{items.length}</span>}
      </button>
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
                        <span>{timeAgo(item.created_at)}</span>
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
