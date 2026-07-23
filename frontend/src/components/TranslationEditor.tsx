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
              fileId={fileId}
              t={t}
              canApprove={canApprove}
              currentUserId={currentUserId}
              onChanged={refetchStrings}
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
  onSelect,
  selected,
}: {
  projectId: number;
  fileId: number;
  t: TranslationInfo;
  canApprove: boolean;
  currentUserId: number | null;
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
        {canDelete && (
          <button
            className="link-button link-button--danger"
            onClick={(e) => {
              e.stopPropagation();
              if (confirm("Delete this translation? This can't be undone.")) del.mutate();
            }}
            disabled={del.isPending}
          >
            {del.isPending ? "…" : "Delete"}
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
