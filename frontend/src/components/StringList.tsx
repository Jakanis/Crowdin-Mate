import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef, useState } from "react";
import { api, type SourceString, type TranslationInfo } from "../api/client";

interface StringListProps {
  projectId: number;
  fileId: number;
  languageId: string;
}

export function StringList({ projectId, fileId, languageId }: StringListProps) {
  const query = useQuery({
    queryKey: ["file-strings", projectId, fileId, languageId],
    queryFn: () => api.getFileStrings(projectId, fileId, languageId),
  });

  const parentRef = useRef<HTMLDivElement>(null);
  const strings = query.data?.strings ?? [];

  const virtualizer = useVirtualizer({
    count: strings.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 280,
    overscan: 4,
  });

  if (query.isLoading) return <p className="hint">Loading strings…</p>;
  if (query.isError) return <p className="error">{(query.error as Error).message}</p>;
  if (strings.length === 0) return <p className="hint">No strings in this file.</p>;

  return (
    <div ref={parentRef} className="string-list-scroll">
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const s = strings[virtualRow.index];
          return (
            <div
              key={s.id}
              ref={virtualizer.measureElement}
              data-index={virtualRow.index}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <StringRow projectId={projectId} fileId={fileId} languageId={languageId} s={s} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function bestTranslationText(s: SourceString): string {
  const approved = s.translations.find((t) => t.is_approved);
  return approved?.text ?? s.translations[0]?.text ?? "";
}

function StringRow({
  projectId,
  fileId,
  languageId,
  s,
}: {
  projectId: number;
  fileId: number;
  languageId: string;
  s: SourceString;
}) {
  const queryClient = useQueryClient();
  const refetchStrings = () =>
    queryClient.invalidateQueries({ queryKey: ["file-strings", projectId, fileId, languageId] });

  const [text, setText] = useState(s.draft?.dirty ? s.draft.draft_text : bestTranslationText(s));
  const [status, setStatus] = useState<"idle" | "saving" | "synced" | "queued" | "rejected" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showComments, setShowComments] = useState(false);

  const submit = useMutation({
    mutationFn: () => api.submitTranslation(projectId, s.id, languageId, text),
    onMutate: () => {
      setStatus("saving");
      setErrorMessage(null);
    },
    onSuccess: (result) => {
      setStatus(result.status);
      if (result.status === "rejected") setErrorMessage(result.reason ?? "Rejected by Crowdin");
      if (result.status === "synced") refetchStrings();
    },
    onError: (err: Error) => {
      setStatus("error");
      setErrorMessage(err.message);
    },
  });

  const dirty = text.trim() !== "" && text !== bestTranslationText(s);

  if (s.has_plurals) {
    return (
      <div className="string-row">
        <div className="string-source">{s.text}</div>
        <p className="hint">
          <strong>{s.identifier ?? s.id}</strong> has plural forms — not yet editable here.
        </p>
      </div>
    );
  }

  return (
    <div className="string-row">
      <div className="string-source">{s.text}</div>
      {s.context && <div className="string-context">{s.context}</div>}

      {s.translations.length > 0 && (
        <ul className="translation-list">
          {s.translations.map((t) => (
            <TranslationItem
              key={t.id}
              projectId={projectId}
              t={t}
              onChanged={refetchStrings}
              onEdit={() => setText(t.text)}
            />
          ))}
        </ul>
      )}

      <div className="add-translation">
        <label className="add-translation-label">New / edited translation</label>
        <textarea
          className="string-target"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={Math.min(8, Math.max(2, Math.ceil(text.length / 60)))}
          placeholder="Type a translation and Save to submit it to Crowdin"
        />
        <div className="string-row-footer">
          <button onClick={() => submit.mutate()} disabled={!dirty || submit.isPending}>
            {submit.isPending ? "Saving…" : "Save as new translation"}
          </button>
          <StatusBadge status={status} />
          {errorMessage && <span className="error">{errorMessage}</span>}
        </div>
      </div>

      <button className="comments-toggle" onClick={() => setShowComments((v) => !v)}>
        {showComments ? "▾" : "▸"} Comments{s.comment_count > 0 ? ` (${s.comment_count})` : ""}
      </button>
      {showComments && (
        <CommentsPanel projectId={projectId} stringId={s.id} languageId={languageId} onPosted={refetchStrings} />
      )}
    </div>
  );
}

function TranslationItem({
  projectId,
  t,
  onChanged,
  onEdit,
}: {
  projectId: number;
  t: TranslationInfo;
  onChanged: () => void;
  onEdit: () => void;
}) {
  const [error, setError] = useState<string | null>(null);

  const approve = useMutation({
    mutationFn: () =>
      t.is_approved
        ? api.unapproveTranslation(projectId, t.id)
        : api.approveTranslation(projectId, t.id),
    onSuccess: () => {
      setError(null);
      onChanged();
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <li className={`translation-item${t.is_approved ? " translation-item--approved" : ""}`}>
      <div className="translation-text">{t.text}</div>
      <div className="translation-meta">
        {t.is_approved && <span className="approved-badge">✓ Approved</span>}
        {t.user_name && <span className="translation-author">{t.user_name}</span>}
        {t.rating !== 0 && <span className="translation-rating">★ {t.rating}</span>}
        <button className="link-button" onClick={onEdit}>
          Edit
        </button>
        <button className="link-button" onClick={() => approve.mutate()} disabled={approve.isPending}>
          {approve.isPending ? "…" : t.is_approved ? "Unapprove" : "Approve"}
        </button>
        {error && <span className="error">{error}</span>}
      </div>
    </li>
  );
}

function CommentsPanel({
  projectId,
  stringId,
  languageId,
  onPosted,
}: {
  projectId: number;
  stringId: number;
  languageId: string;
  onPosted: () => void;
}) {
  const queryClient = useQueryClient();
  const [text, setText] = useState("");

  const query = useQuery({
    queryKey: ["comments", projectId, stringId],
    queryFn: () => api.getComments(projectId, stringId),
  });

  const post = useMutation({
    mutationFn: () => api.addComment(projectId, stringId, languageId, text),
    onSuccess: () => {
      setText("");
      queryClient.invalidateQueries({ queryKey: ["comments", projectId, stringId] });
      onPosted();
    },
  });

  return (
    <div className="comments-panel">
      {query.isLoading && <p className="hint">Loading comments…</p>}
      {query.isError && <p className="error">{(query.error as Error).message}</p>}
      {query.data && query.data.comments.length === 0 && <p className="hint">No comments yet.</p>}
      {query.data?.comments.map((c) => (
        <div key={c.id} className="comment">
          <div className="comment-meta">
            <strong>{c.user_name ?? "Unknown"}</strong>
            {c.type === "issue" && <span className="issue-tag">issue</span>}
            {c.is_resolved ? <span className="resolved-tag">resolved</span> : null}
          </div>
          <div className="comment-text">{c.text}</div>
        </div>
      ))}
      <div className="add-comment">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          placeholder="Add a comment…"
        />
        <button onClick={() => post.mutate()} disabled={!text.trim() || post.isPending}>
          {post.isPending ? "Posting…" : "Post"}
        </button>
        {post.isError && <span className="error">{(post.error as Error).message}</span>}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: "idle" | "saving" | "synced" | "queued" | "rejected" | "error" }) {
  if (status === "idle") return null;
  const label = {
    saving: "Saving…",
    synced: "Synced ✓",
    queued: "Queued (offline)",
    rejected: "Rejected",
    error: "Failed",
  }[status];
  return <span className={`status-badge status-badge--${status}`}>{label}</span>;
}
