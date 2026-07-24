import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type DeletedTranslationInfo } from "../api/client";
import { notifyProgressChanged } from "../progressEvents";

interface DeletedTranslationsPanelProps {
  projectId: number;
  languageId: string;
  onJumpToResult: (fileId: number, stringId: number) => void;
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
 * "Deleted" tab in the left sidebar: every translation deleted in this
 * project/language that hasn't been restored yet, across every file —
 * unlike TranslationEditor's own inline "Deleted · Undo" overlay (purely
 * in-memory component state, gone the moment you navigate away from that
 * string), this is backed by the server's deleted_translations table, so
 * a deletion stays undoable regardless of how long ago it happened or
 * how many strings you've visited since — matching Crowdin's own
 * indefinitely-restorable delete.
 */
export function DeletedTranslationsPanel({ projectId, languageId, onJumpToResult }: DeletedTranslationsPanelProps) {
  const queryClient = useQueryClient();

  const deletedQuery = useQuery({
    queryKey: ["deleted-translations", projectId, languageId],
    queryFn: () => api.listDeletedTranslations(projectId, languageId),
  });

  const restore = useMutation({
    mutationFn: (t: DeletedTranslationInfo) => api.restoreTranslation(projectId, t.string_id, t.id, languageId),
    onSuccess: (_data, t) => {
      queryClient.invalidateQueries({ queryKey: ["deleted-translations", projectId, languageId] });
      queryClient.invalidateQueries({ queryKey: ["file-strings", projectId, t.file_id, languageId] });
      notifyProgressChanged(t.file_id);
    },
  });

  const deleted = deletedQuery.data?.deleted ?? [];

  return (
    <div className="deleted-panel">
      {deletedQuery.isLoading && <p className="hint">Loading…</p>}
      {!deletedQuery.isLoading && deleted.length === 0 && (
        <p className="hint">Nothing deleted — anything you delete stays here, undoable anytime.</p>
      )}
      <div className="deleted-list">
        {deleted.map((t) => {
          const pending = restore.isPending && restore.variables?.id === t.id;
          return (
            <div key={t.id} className="deleted-item">
              <button className="deleted-item-path" onClick={() => onJumpToResult(t.file_id, t.string_id)}>
                {t.file_path}
                {t.identifier && <span className="string-identifier">🔑 {t.identifier}</span>}
              </button>
              <div className="deleted-item-source">{t.source_text}</div>
              <div className="deleted-item-text">{t.text}</div>
              <div className="deleted-item-meta">
                {t.user_name && <span className="translation-author">{t.user_name}</span>}
                <span className="hint">deleted {timeAgo(t.deleted_at)}</span>
                <button className="link-button" onClick={() => restore.mutate(t)} disabled={pending}>
                  {pending ? "Restoring…" : "Undo"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
