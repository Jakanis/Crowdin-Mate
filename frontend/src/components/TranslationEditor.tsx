import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, type SourceString, type TranslationInfo } from "../api/client";

interface TranslationEditorProps {
  projectId: number;
  fileId: number;
  languageId: string;
  s: SourceString;
  canApprove: boolean;
}

function bestTranslationText(s: SourceString): string {
  const approved = s.translations.find((t) => t.is_approved);
  return approved?.text ?? s.translations[0]?.text ?? "";
}

/**
 * The translation-editing UI for one string: candidate list (click any
 * candidate to load its text into the edit box — this is how Crowdin's
 * own editor works, no separate "Edit" button) + approve/unapprove
 * (gated on canApprove, since not every account can approve) + save.
 * Shared between Comfortable (one string full-page) and Side-by-Side
 * (one row, expanded) layouts — the editing behavior is identical, only
 * the surrounding layout differs.
 */
export function TranslationEditor({ projectId, fileId, languageId, s, canApprove }: TranslationEditorProps) {
  const queryClient = useQueryClient();
  const refetchStrings = () =>
    queryClient.invalidateQueries({ queryKey: ["file-strings", projectId, fileId, languageId] });

  const [text, setText] = useState(s.draft?.dirty ? s.draft.draft_text : bestTranslationText(s));
  const [status, setStatus] = useState<"idle" | "saving" | "synced" | "queued" | "rejected" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Fit the box to its content instead of a fixed row count (which was a
  // crude char-count guess, capped at 8 rows with an internal scrollbar
  // for anything longer). Re-measures on every text change, including
  // programmatic ones like clicking a candidate to load its text.
  //
  // scrollHeight never includes border width, but with the project-wide
  // box-sizing: border-box the `height` we set here does — omitting that
  // undershoots by exactly the border width and leaves a 1-2px sliver
  // clipped (confirmed by measuring scrollHeight vs clientHeight after
  // the naive version). Add the border back in.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const { borderTopWidth, borderBottomWidth } = window.getComputedStyle(el);
    el.style.height = `${el.scrollHeight + parseFloat(borderTopWidth) + parseFloat(borderBottomWidth)}px`;
  }, [text]);

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

  // Focus the edit box the moment a candidate is picked, cursor at the
  // end, so you can click a candidate and start typing immediately
  // instead of needing a second click into the field. Deferred to the
  // next frame since the textarea's DOM value only reflects the new text
  // after this render commits — selecting a range against the stale
  // value would misplace the cursor.
  const selectCandidate = (candidateText: string) => {
    setText(candidateText);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.selectionStart = el.selectionEnd = candidateText.length;
    });
  };

  if (s.has_plurals) {
    return (
      <p className="hint">
        <strong>{s.identifier ?? s.id}</strong> has plural forms — not yet editable here.
      </p>
    );
  }

  return (
    <div className="translation-editor">
      <textarea
        ref={textareaRef}
        className="string-target"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Type a translation and Save to submit it to Crowdin"
      />
      <div className="string-row-footer">
        <button onClick={() => submit.mutate()} disabled={!dirty || submit.isPending}>
          {submit.isPending ? "Saving…" : "Save as new translation"}
        </button>
        <StatusBadge status={status} />
        {errorMessage && <span className="error">{errorMessage}</span>}
      </div>

      {s.translations.length > 0 && (
        <ul className="translation-list">
          {s.translations.map((t) => (
            <TranslationItem
              key={t.id}
              projectId={projectId}
              t={t}
              canApprove={canApprove}
              onChanged={refetchStrings}
              onSelect={() => selectCandidate(t.text)}
              selected={text === t.text}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function TranslationItem({
  projectId,
  t,
  canApprove,
  onChanged,
  onSelect,
  selected,
}: {
  projectId: number;
  t: TranslationInfo;
  canApprove: boolean;
  onChanged: () => void;
  onSelect: () => void;
  selected: boolean;
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
    <li
      className={`translation-item${t.is_approved ? " translation-item--approved" : ""}${selected ? " translation-item--selected" : ""}`}
      onClick={onSelect}
    >
      <div className="translation-text">{t.text}</div>
      <div className="translation-meta">
        {t.is_approved && <span className="approved-badge">✓ Approved</span>}
        {t.user_name && <span className="translation-author">{t.user_name}</span>}
        {t.rating !== 0 && <span className="translation-rating">★ {t.rating}</span>}
        {canApprove && (
          <button
            className="link-button"
            onClick={(e) => {
              e.stopPropagation();
              approve.mutate();
            }}
            disabled={approve.isPending}
          >
            {approve.isPending ? "…" : t.is_approved ? "Unapprove" : "Approve"}
          </button>
        )}
        {error && <span className="error">{error}</span>}
      </div>
    </li>
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
