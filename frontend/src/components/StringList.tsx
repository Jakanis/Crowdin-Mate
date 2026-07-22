import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef, useState } from "react";
import { api, type FileStringsResponse, type SourceString } from "../api/client";

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
    estimateSize: () => 160,
    overscan: 6,
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
  const initialText = s.draft?.dirty ? s.draft.draft_text : (s.translation?.text ?? "");
  const [text, setText] = useState(initialText);
  const [status, setStatus] = useState<"idle" | "saving" | "synced" | "queued" | "rejected" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.submitTranslation(projectId, s.id, languageId, text),
    onMutate: () => {
      setStatus("saving");
      setErrorMessage(null);
    },
    onSuccess: (result) => {
      setStatus(result.status);
      if (result.status === "rejected") setErrorMessage(result.reason ?? "Rejected by Crowdin");
      queryClient.setQueryData<FileStringsResponse>(
        ["file-strings", projectId, fileId, languageId],
        (prev) => {
          if (!prev) return prev;
          return {
            strings: prev.strings.map((row) =>
              row.id === s.id
                ? {
                    ...row,
                    translation: result.translation
                      ? { string_id: row.id, id: result.translation.id, text: result.translation.text, user_name: result.translation.user_name, created_at: null }
                      : row.translation,
                  }
                : row,
            ),
          };
        },
      );
    },
    onError: (err: Error) => {
      setStatus("error");
      setErrorMessage(err.message);
    },
  });

  const dirty = text !== (s.translation?.text ?? "");

  return (
    <div className="string-row">
      {s.has_plurals ? (
        <p className="hint">
          <strong>{s.identifier ?? s.id}</strong> has plural forms — not yet editable here (Phase 2).
        </p>
      ) : (
        <>
          <div className="string-source">{s.text}</div>
          <textarea
            className="string-target"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={Math.min(8, Math.max(2, Math.ceil(text.length / 60)))}
          />
          <div className="string-row-footer">
            <button onClick={() => mutation.mutate()} disabled={!dirty || mutation.isPending}>
              {mutation.isPending ? "Saving…" : "Save"}
            </button>
            <StatusBadge status={status} />
            {errorMessage && <span className="error">{errorMessage}</span>}
            {s.translation?.user_name && status === "idle" && (
              <span className="string-meta">last by {s.translation.user_name}</span>
            )}
          </div>
        </>
      )}
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
