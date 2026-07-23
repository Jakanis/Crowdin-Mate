import { useMutation, useQueryClient } from "@tanstack/react-query";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { api, type SourceString, type TranslationInfo } from "../api/client";
import { notifyProgressChanged } from "../progressEvents";

interface TranslationEditorProps {
  projectId: number;
  fileId: number;
  languageId: string;
  s: SourceString;
  canApprove: boolean;
  currentUserId: number | null;
  /** Called after a successful save (synced or durably queued while
   * offline) — Comfortable view uses this to auto-advance to the next
   * string, matching Crowdin's own "Automatically move to next string"
   * setting. Not passed in Side-by-Side, where "next" isn't meaningful. */
  onSaved?: () => void;
}

/** Exposed via ref so a sibling (HighlightedSourceText, several levels
 * up through ComfortableView/SideBySideView) can insert a clicked
 * glossary term's translation directly into this editor at the cursor,
 * matching Crowdin's own behavior — the two components share no other
 * relationship, so a ref is simpler here than threading a callback
 * through every layout. */
export interface TranslationEditorHandle {
  insertAtCursor: (text: string) => void;
}

function bestTranslationText(s: SourceString): string {
  const approved = s.translations.find((t) => t.is_approved);
  return approved?.text ?? s.translations[0]?.text ?? "";
}

const DRAFT_DEBOUNCE_MS = 600;
const UNDO_DELETE_MS = 6000;

function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M13.5 4.5L6 12L2.5 8.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M3 4.5H13M6.5 4.5V3C6.5 2.5 7 2 7.5 2H8.5C9 2 9.5 2.5 9.5 3V4.5M12 4.5V13C12 13.5 11.5 14 11 14H5C4.5 14 4 13.5 4 13V4.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M6.5 7V11.5M9.5 7V11.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
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
export const TranslationEditor = forwardRef<TranslationEditorHandle, TranslationEditorProps>(function TranslationEditor(
  { projectId, fileId, languageId, s, canApprove, currentUserId, onSaved },
  ref,
) {
  const queryClient = useQueryClient();
  const refetchStrings = () =>
    queryClient.invalidateQueries({ queryKey: ["file-strings", projectId, fileId, languageId] });

  const [text, setText] = useState(s.draft?.dirty ? s.draft.draft_text : bestTranslationText(s));
  const [status, setStatus] = useState<"idle" | "saving" | "synced" | "queued" | "rejected" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-save the in-progress (unsubmitted) text locally as you type,
  // matching Crowdin's own editor — leave a string half-translated,
  // close the tab or the whole app, and it's still there when you come
  // back. Purely local (saveDraft never calls Crowdin); get_file_strings
  // already prefers this over the current translation whenever dirty,
  // so nothing else needs to change to make it resumable.
  const textRef = useRef(text);
  textRef.current = text;
  const lastSavedDraftRef = useRef(text);
  const draftTimeoutRef = useRef<number | null>(null);

  const flushDraft = () => {
    if (textRef.current === lastSavedDraftRef.current) return;
    lastSavedDraftRef.current = textRef.current;
    api.saveDraft(projectId, s.id, languageId, textRef.current).catch(() => {
      // Best-effort — local persistence failing isn't worth surfacing as
      // a user-facing error; the in-memory text is still right there in
      // the box for the rest of this session regardless.
    });
  };

  useEffect(() => {
    if (text === lastSavedDraftRef.current) return;
    if (draftTimeoutRef.current != null) window.clearTimeout(draftTimeoutRef.current);
    draftTimeoutRef.current = window.setTimeout(flushDraft, DRAFT_DEBOUNCE_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  // Separate mount-only effect so its cleanup fires exactly once, on
  // unmount — switching strings/files remounts this component (it's
  // keyed on s.id in ComfortableView/SideBySideView), and the debounce
  // above would otherwise lose up to DRAFT_DEBOUNCE_MS of typing that
  // never got to fire before the switch.
  useEffect(() => {
    return () => {
      if (draftTimeoutRef.current != null) window.clearTimeout(draftTimeoutRef.current);
      flushDraft();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

    const fit = () => {
      el.style.height = "auto";
      const { borderTopWidth, borderBottomWidth } = window.getComputedStyle(el);
      el.style.height = `${el.scrollHeight + parseFloat(borderTopWidth) + parseFloat(borderBottomWidth)}px`;
    };

    fit();

    // Text-only re-measurement misses a real cause of the same problem:
    // dragging a side panel resizes this box without touching `text` at
    // all, so the same content now wraps onto a different number of
    // lines and the height goes stale (confirmed live — the box stayed
    // whatever height it last fit at, cutting off text after a resize).
    // Re-fit whenever the element's own width actually changes. Gated on
    // width specifically (not just any resize) because fit() itself
    // changes the element's height, and observing height too would have
    // this callback re-triggering itself.
    let lastWidth = el.offsetWidth;
    const observer = new ResizeObserver(() => {
      if (el.offsetWidth !== lastWidth) {
        lastWidth = el.offsetWidth;
        fit();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
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
      if (result.status === "synced") {
        refetchStrings();
        notifyProgressChanged(fileId);
      }
      if (result.status === "synced" || result.status === "rejected") {
        // The backend clears dirty=0 for both outcomes (synced: no
        // longer a pending edit; rejected: never going to sync as-is,
        // see submit_translation's own docstring on why). A draft-save
        // debounced from an earlier keystroke could still be pending
        // right now and fire after this — left alone, it would call
        // saveDraft and set dirty back to 1, resurrecting stale text as
        // if it were still an unsubmitted edit. "queued" is excluded:
        // that one's genuinely still unsynced, so the draft should stay
        // exactly as pending as it already was.
        if (draftTimeoutRef.current != null) {
          window.clearTimeout(draftTimeoutRef.current);
          draftTimeoutRef.current = null;
        }
        lastSavedDraftRef.current = text;
      }
      // Queued counts as "saved" here too — the whole point of the
      // offline queue is that the edit is durable even without a
      // network, so auto-advance shouldn't block on connectivity.
      if (result.status === "synced" || result.status === "queued") onSaved?.();
    },
    onError: (err: Error) => {
      setStatus("error");
      setErrorMessage(err.message);
    },
  });

  const dirty = text.trim() !== "" && text !== bestTranslationText(s);

  // Crowdin's own editor deletes a candidate immediately (no "are you
  // sure?" dialog) and instead offers a brief Undo — matching that here.
  // "Undo" can't literally restore the deleted translationId (the API
  // has no undelete), so it resubmits the same text as a new candidate,
  // which reads the same to the user even though it gets a fresh id.
  const [undoDelete, setUndoDelete] = useState<string | null>(null);
  const undoTimeoutRef = useRef<number | null>(null);

  const handleDeleted = (deletedText: string) => {
    if (undoTimeoutRef.current != null) window.clearTimeout(undoTimeoutRef.current);
    setUndoDelete(deletedText);
    undoTimeoutRef.current = window.setTimeout(() => setUndoDelete(null), UNDO_DELETE_MS);
  };

  const undoMutation = useMutation({
    mutationFn: () => api.submitTranslation(projectId, s.id, languageId, undoDelete as string),
    onSuccess: () => {
      if (undoTimeoutRef.current != null) window.clearTimeout(undoTimeoutRef.current);
      setUndoDelete(null);
      refetchStrings();
      notifyProgressChanged(fileId);
    },
  });

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

  // Insert at the current cursor (replacing any selection), same idea
  // as selectCandidate but splicing into the existing text rather than
  // replacing it outright. Reads selectionStart/End before setText —
  // once the state update commits, the textarea's own selection has
  // already collapsed to wherever the new value put it, so it has to be
  // captured now and re-applied next frame like selectCandidate does.
  useImperativeHandle(
    ref,
    () => ({
      insertAtCursor: (insertText: string) => {
        const el = textareaRef.current;
        const start = el?.selectionStart ?? text.length;
        const end = el?.selectionEnd ?? text.length;
        const next = text.slice(0, start) + insertText + text.slice(end);
        setText(next);
        const cursorPos = start + insertText.length;
        requestAnimationFrame(() => {
          if (!el) return;
          el.focus();
          el.selectionStart = el.selectionEnd = cursorPos;
        });
      },
    }),
    [text],
  );

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
        <button className="btn-primary" onClick={() => submit.mutate()} disabled={!dirty || submit.isPending}>
          {submit.isPending ? "Saving…" : "Save"}
        </button>
        <StatusBadge status={status} />
        {errorMessage && <span className="error">{errorMessage}</span>}
      </div>

      {undoDelete && (
        <div className="undo-banner">
          Translation deleted.
          <button className="link-button" onClick={() => undoMutation.mutate()} disabled={undoMutation.isPending}>
            {undoMutation.isPending ? "Restoring…" : "Undo"}
          </button>
        </div>
      )}

      {s.translations.length > 0 && (
        <ul className="translation-list">
          {s.translations.map((t) => (
            <TranslationItem
              key={t.id}
              projectId={projectId}
              fileId={fileId}
              t={t}
              canApprove={canApprove}
              currentUserId={currentUserId}
              onChanged={refetchStrings}
              onDeleted={handleDeleted}
              onSelect={() => selectCandidate(t.text)}
              selected={text === t.text}
            />
          ))}
        </ul>
      )}
    </div>
  );
});

function TranslationItem({
  projectId,
  fileId,
  t,
  canApprove,
  currentUserId,
  onChanged,
  onDeleted,
  onSelect,
  selected,
}: {
  projectId: number;
  fileId: number;
  t: TranslationInfo;
  canApprove: boolean;
  currentUserId: number | null;
  onChanged: () => void;
  onDeleted: (deletedText: string) => void;
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
      notifyProgressChanged(fileId);
    },
    onError: (err: Error) => setError(err.message),
  });

  const vote = useMutation({
    mutationFn: (mark: "up" | "down") => api.voteTranslation(projectId, t.id, mark),
    onSuccess: () => {
      setError(null);
      onChanged();
    },
    onError: (err: Error) => setError(err.message),
  });

  const del = useMutation({
    mutationFn: () => api.deleteTranslation(projectId, t.id),
    onSuccess: () => {
      setError(null);
      onChanged();
      onDeleted(t.text);
      notifyProgressChanged(fileId);
    },
    onError: (err: Error) => setError(err.message),
  });

  // Own translations are always deletable; anyone else's needs
  // moderator-ish rights — canApprove already stands in for that
  // elsewhere (see get_permissions' docstring on why role name alone
  // isn't a reliable signal).
  const canDelete = t.user_id === currentUserId || canApprove;

  return (
    <li
      className={`translation-item${t.is_approved ? " translation-item--approved" : ""}${selected ? " translation-item--selected" : ""}`}
      onClick={onSelect}
    >
      <div className="translation-text">{t.text}</div>
      <div className="translation-meta">
        {t.is_approved && <span className="approved-badge">✓ Approved</span>}
        {t.user_name && <span className="translation-author">{t.user_name}</span>}
        <span className="translation-votes">
          <button
            className="vote-button"
            onClick={(e) => {
              e.stopPropagation();
              vote.mutate("up");
            }}
            disabled={vote.isPending}
            title="Vote up"
          >
            ▲
          </button>
          <span className="translation-rating">{t.rating}</span>
          <button
            className="vote-button"
            onClick={(e) => {
              e.stopPropagation();
              vote.mutate("down");
            }}
            disabled={vote.isPending}
            title="Vote down"
          >
            ▼
          </button>
        </span>
        {canApprove && (
          <button
            className={`icon-btn icon-btn--approve${t.is_approved ? " icon-btn--active" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              approve.mutate();
            }}
            disabled={approve.isPending}
            title={t.is_approved ? "Unapprove" : "Approve"}
          >
            <CheckIcon />
          </button>
        )}
        {canDelete && (
          <button
            className="icon-btn icon-btn--delete"
            onClick={(e) => {
              e.stopPropagation();
              del.mutate();
            }}
            disabled={del.isPending}
            title="Delete"
          >
            <TrashIcon />
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
