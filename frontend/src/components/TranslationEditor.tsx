import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { api, type SourceString, type TranslationInfo } from "../api/client";
import { notifyProgressChanged } from "../progressEvents";
import { useTmSuggestionsCollapsed } from "../theme";
import { TmSourceDiff } from "./TmSourceDiff";

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

  // Box auto-grows to fit its content via the field-sizing CSS property
  // on .string-target (styles.css) rather than a scrollHeight + JS
  // ResizeObserver combo — that approach lagged a step behind during a
  // fast continuous side-panel drag (scrollHeight itself updates
  // instantly on every width change, but the JS that copied it into
  // style.height couldn't keep up), which is exactly what caused the
  // box to visibly clip the last row mid-drag and only catch up once
  // the drag paused.

  // A "rejected" result (most commonly Crowdin's "duplicate translation"
  // check) or a raw network-level failure both mean this app's view of
  // the string might not match what's actually on Crowdin anymore — a
  // duplicate rejection is a strong signal the exact text already
  // exists as a real translation there (e.g. an earlier submit whose
  // response never made it back here: the backend process restarting
  // mid-request, a dropped connection, anything that lets the Crowdin
  // call land but breaks before this app hears back), and a network
  // failure means we genuinely don't know whether the submit reached
  // Crowdin before the connection died. Either way, silently leaving
  // the pre-submit candidate list on screen would hide that the
  // translation may already be there. Resyncing (not just refetching
  // the local cache, which wouldn't have it either) reconciles with
  // whatever Crowdin's real state turns out to be.
  const reconcileWithCrowdin = () => {
    api
      .resyncFile(projectId, fileId, languageId)
      .then(() => {
        refetchStrings();
        notifyProgressChanged(fileId);
      })
      .catch(() => {
        // Resync itself failed too (genuinely offline, etc.) — nothing
        // more to do here; the typed text is still safe in the draft.
      });
  };

  const submit = useMutation({
    mutationFn: () => api.submitTranslation(projectId, s.id, languageId, text),
    onMutate: () => {
      setStatus("saving");
      setErrorMessage(null);
    },
    onSuccess: (result) => {
      setStatus(result.status);
      if (result.status === "rejected") {
        setErrorMessage(result.reason ?? "Rejected by Crowdin");
        reconcileWithCrowdin();
      }
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
      reconcileWithCrowdin();
    },
  });

  const dirty = text.trim() !== "" && text !== bestTranslationText(s);

  // Ctrl+Shift+Enter (see the textarea's onKeyDown below) approves/
  // unapproves whichever existing candidate's text currently matches the
  // box — same target as clicking a candidate's own approve button, just
  // without leaving the keyboard. A separate mutation from
  // TranslationItem's own (rather than lifting that one up) since this
  // only ever needs to fire for whichever one is currently selected, not
  // track pending/error state per row.
  const approveSelectedMutation = useMutation({
    mutationFn: (t: TranslationInfo) =>
      t.is_approved ? api.unapproveTranslation(projectId, t.id) : api.approveTranslation(projectId, t.id),
    onSuccess: () => {
      refetchStrings();
      notifyProgressChanged(fileId);
    },
  });

  // Same query TmPanel (right sidebar) runs — same queryKey, so this is
  // never an extra network request beyond what the sidebar already
  // needs, and this component sees the freshest known data whether or
  // not the sidebar's TM tab happens to be open. Shown inline below the
  // candidate list, matching Crowdin's own editor, since a suggestion is
  // as directly useful as an existing candidate and shouldn't require
  // opening a side panel to see.
  const tmQuery = useQuery({
    queryKey: ["tm-matches", projectId, s.id, languageId],
    queryFn: () => api.getTmMatches(projectId, s.id, languageId),
    enabled: true,
  });
  const tmMatches = tmQuery.data?.matches ?? [];
  const tmMaxRelevant = tmMatches.length > 0 ? Math.max(...tmMatches.map((m) => m.relevant)) : 0;
  const { collapsed: suggestionsCollapsed, setCollapsed: setSuggestionsCollapsed } = useTmSuggestionsCollapsed();

  // Crowdin's own editor deletes a candidate immediately (no "are you
  // sure?" dialog) and instead offers a brief Undo — matching that here.
  // The deleted candidate stays visible (dimmed, with a semi-opaque
  // "Deleted · Undo" overlay) rather than vanishing into a separate
  // banner. Undo calls restoreTranslation, not a resubmit of the text
  // as a new translation — Crowdin keeps a deleted translation
  // genuinely restorable (confirmed live: same translationId, original
  // author, original timestamp, even its approval record all come back
  // exactly as they were), and resubmitting would have misattributed
  // authorship to whoever clicked Undo instead.
  //
  // No timer: the overlay stays until the user either clicks Undo or
  // navigates away from this string (see the unmount effect below),
  // rather than auto-clearing on a clock — a deletion the user hasn't
  // acted on yet (still looking at it, cursor still over it) shouldn't
  // vanish out from under them. Keyed by translationId (not a single
  // slot) so deleting a second candidate while the first's overlay is
  // still up doesn't silently drop the first one's tracking — that
  // used to make the first entry render as a normal, still-existing
  // candidate again (stale s.translations, never refetched) even
  // though it was already really gone, and clicking its Delete button
  // a second time 404'd against Crowdin.
  //
  // Each entry is captured (with its original index) rather than
  // eagerly refetching — react-query's own refetchOnWindowFocus
  // (default on, and this data is usually well past its 30s staleTime
  // by the time anyone clicks Delete) can refetch behind this
  // component's back at any moment, which would otherwise make the
  // candidate disappear immediately regardless of the undo window.
  // displayTranslations splices each one back into its original slot
  // whenever it's missing from the live list but still pending, so the
  // visual "stays put" behavior holds regardless of what triggered the
  // refetch.
  const [pendingDeletes, setPendingDeletes] = useState<Map<number, { translation: TranslationInfo; index: number }>>(
    new Map(),
  );
  const [restoringIds, setRestoringIds] = useState<Set<number>>(new Set());

  const handleDeleted = (t: TranslationInfo, index: number) => {
    setPendingDeletes((prev) => {
      const next = new Map(prev);
      next.set(t.id, { translation: t, index });
      return next;
    });
  };

  const displayTranslations = useMemo(() => {
    if (pendingDeletes.size === 0) return s.translations;
    const missing = Array.from(pendingDeletes.values())
      .filter((p) => !s.translations.some((t) => t.id === p.translation.id))
      .sort((a, b) => a.index - b.index);
    if (missing.length === 0) return s.translations;
    const next = s.translations.slice();
    for (const p of missing) next.splice(Math.min(p.index, next.length), 0, p.translation);
    return next;
  }, [s.translations, pendingDeletes]);

  const undoMutation = useMutation({
    mutationFn: (translationId: number) => api.restoreTranslation(projectId, s.id, translationId, languageId),
    onMutate: (translationId) => {
      setRestoringIds((prev) => new Set(prev).add(translationId));
    },
    onSuccess: (_data, translationId) => {
      setPendingDeletes((prev) => {
        const next = new Map(prev);
        next.delete(translationId);
        return next;
      });
      refetchStrings();
      notifyProgressChanged(fileId);
    },
    onSettled: (_data, _err, translationId) => {
      setRestoringIds((prev) => {
        const next = new Set(prev);
        next.delete(translationId);
        return next;
      });
    },
  });

  // Finalize whatever's still pending (never undone) the moment this
  // string is left — key={s.id} in ComfortableView/SideBySideView
  // remounts this component on every Prev/Next/jump, so unmount here
  // really does mean "moved to a different string". A ref (not
  // pendingDeletes itself) keeps this a mount-only effect while still
  // reading the latest set at the moment of unmounting.
  const pendingDeletesRef = useRef(pendingDeletes);
  pendingDeletesRef.current = pendingDeletes;
  useEffect(() => {
    return () => {
      if (pendingDeletesRef.current.size > 0) refetchStrings();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        onKeyDown={(e) => {
          if (!(e.ctrlKey || e.metaKey) || e.key !== "Enter") return;
          e.preventDefault();
          if (e.shiftKey) {
            const selected = displayTranslations.find((t) => t.text === text);
            if (canApprove && selected && !approveSelectedMutation.isPending) {
              approveSelectedMutation.mutate(selected);
            }
          } else if (dirty && !submit.isPending) {
            submit.mutate();
          }
        }}
        placeholder="Type a translation and Save to submit it to Crowdin"
      />
      <div className="string-row-footer">
        <button className="btn-primary" onClick={() => submit.mutate()} disabled={!dirty || submit.isPending}>
          {submit.isPending ? "Saving…" : "Save"}
        </button>
        <StatusBadge status={status} />
        {errorMessage && <span className="error">{errorMessage}</span>}
      </div>

      {displayTranslations.length > 0 && (
        <ul className="translation-list">
          {displayTranslations.map((t, index) => (
            <TranslationItem
              key={t.id}
              projectId={projectId}
              fileId={fileId}
              t={t}
              canApprove={canApprove}
              currentUserId={currentUserId}
              onChanged={refetchStrings}
              onDeleted={() => handleDeleted(t, index)}
              onSelect={() => selectCandidate(t.text)}
              selected={text === t.text}
              pendingDelete={pendingDeletes.has(t.id)}
              onUndoDelete={() => undoMutation.mutate(t.id)}
              undoPending={restoringIds.has(t.id)}
            />
          ))}
        </ul>
      )}

      {tmMatches.length > 0 && (
        <div className="tm-suggestions-inline">
          <button
            type="button"
            className="tm-suggestions-inline-header"
            onClick={() => setSuggestionsCollapsed(!suggestionsCollapsed)}
            aria-expanded={!suggestionsCollapsed}
          >
            <span className={`tm-suggestions-inline-caret${suggestionsCollapsed ? "" : " tm-suggestions-inline-caret--open"}`}>
              ▸
            </span>
            <h4 className="tm-suggestions-inline-title">Suggestions</h4>
            <span className="tm-suggestions-inline-hint">
              {tmMatches.length} match{tmMatches.length === 1 ? "" : "es"} · up to {tmMaxRelevant}%
            </span>
          </button>
          {!suggestionsCollapsed && (
          <ul className="suggestion-list">
            {tmMatches.map((m, i) => {
              const isPerfect = m.relevant >= 100;
              return (
                <li
                  key={i}
                  className="suggestion-item suggestion-item--clickable"
                  onClick={() => selectCandidate(m.target_text)}
                >
                  <div className="suggestion-header">
                    <span className={`suggestion-relevance${isPerfect ? " suggestion-relevance--perfect" : ""}`}>
                      {isPerfect ? "Perfect match" : `${m.relevant}%`}
                    </span>
                    {m.tm_name && <span className="suggestion-source-name">{m.tm_name}</span>}
                  </div>
                  <div className="suggestion-source">
                    {!isPerfect ? <TmSourceDiff currentText={s.text} matchText={m.source_text} /> : m.source_text}
                  </div>
                  <div className="suggestion-target">{m.target_text}</div>
                </li>
              );
            })}
          </ul>
          )}
        </div>
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
  pendingDelete,
  onUndoDelete,
  undoPending,
}: {
  projectId: number;
  fileId: number;
  t: TranslationInfo;
  canApprove: boolean;
  currentUserId: number | null;
  onChanged: () => void;
  onDeleted: () => void;
  onSelect: () => void;
  selected: boolean;
  pendingDelete: boolean;
  onUndoDelete: () => void;
  undoPending: boolean;
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
      // Deliberately not onChanged() here — that would refetch and drop
      // this candidate from the list immediately, but it needs to stay
      // visible (dimmed, with the Undo overlay) for the undo window.
      // TranslationEditor's handleDeleted (via displayTranslations)
      // keeps it visible regardless of when the real refetch happens.
      onDeleted();
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
      className={`translation-item${t.is_approved ? " translation-item--approved" : ""}${selected ? " translation-item--selected" : ""}${pendingDelete ? " translation-item--pending-delete" : ""}`}
      onClick={pendingDelete ? undefined : onSelect}
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
      {pendingDelete && (
        <div className="translation-delete-overlay">
          <span>Deleted</span>
          <button
            className="link-button"
            onClick={(e) => {
              e.stopPropagation();
              onUndoDelete();
            }}
            disabled={undoPending}
          >
            {undoPending ? "Restoring…" : "Undo"}
          </button>
        </div>
      )}
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
