import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import {
  api,
  type DeletedTranslationInfo,
  type FileStringsResponse,
  type SourceString,
  type TranslationInfo,
} from "../api/client";
import { notifyProgressChanged } from "../progressEvents";
import { useTmSuggestionsCollapsed } from "../theme";
import { fullDateTime, timeAgo } from "../timeAgo";
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
  /** "Go to string" on a TM suggestion that traces back to a real
   * translation elsewhere in the project — same callback RightSidebar
   * already threads into TmPanel's identical feature (see
   * _augment_tm_matches_with_source in main.py for where the who/when/
   * jump-target data actually comes from). */
  onJumpToMatch?: (fileId: number, stringId: number) => void;
  /** Whether this instance's own tab is the one currently visible.
   * Comfortable/Side-by-Side both remount this component when a
   * DIFFERENT string is focused within the same tab (key={s.id} /
   * conditional render), but every open TAB's own TranslationWorkspace
   * stays mounted the whole time — just hidden via CSS (see its own
   * docstring) — so a delete's pendingDeletes tracking would otherwise
   * survive indefinitely on a tab you've switched away from. Defaults to
   * true so standalone/test usage without this prop keeps working. */
  isActive?: boolean;
  /** Reports whether this box currently holds unsubmitted work, so a
   * background refresh can tell "nothing to lose, swap it in" from
   * "ask first". Fires only on transitions, not per keystroke. */
  onDirtyChange?: (stringId: number, dirty: boolean) => void;
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

/** Where a translation came from, when it wasn't simply typed.
 *
 * Crowdin records this and shows it in its own editor; the two values seen
 * live in this project are provider "tm" (accepted from a TM suggestion)
 * and isPreTranslated (produced by Crowdin's pre-translate). Anything else
 * in provider is a machine-translation engine name, shown as-is rather than
 * guessed at, since the set of engines is per-project.
 *
 * Absent for translations typed from scratch — the common case, which
 * deserves no badge at all. */
function ProvenanceBadge({ translation: t }: { translation: TranslationInfo }) {
  // Crowdin distinguishes the project's own memory from the shared one
  // across your account — both are "from TM" to a translator, so they get
  // the same badge and differ only in the tooltip. Found on TestProjectYK,
  // which had a global_tm translation; assuming a single "tm" value would
  // have mislabelled it as a machine-translation engine.
  if (t.provider === "tm" || t.provider === "global_tm") {
    return (
      <span
        className="provenance-badge"
        title={
          t.provider === "global_tm"
            ? "Submitted from a global translation-memory suggestion"
            : "Submitted from a translation-memory suggestion"
        }
      >
        TM
      </span>
    );
  }
  // Any other provider is an engine name — machine translation or AI.
  // Rendered as-is rather than mapped, since the set is per-project and
  // unknown values are better shown than swallowed. Worth a friendlier
  // label once AI/MT suggestions are actually offered here (see BACKLOG),
  // at which point selectCandidate should pass the engine's provider
  // instead of the hardcoded "tm".
  if (t.provider) {
    return (
      <span className="provenance-badge" title={`Machine translation via ${t.provider}`}>
        {t.provider}
      </span>
    );
  }
  if (t.is_pre_translated) {
    return (
      <span className="provenance-badge" title="Added by Crowdin's pre-translate">
        Pre-translated
      </span>
    );
  }
  return null;
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

function JumpIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M3.5 8H12.5M12.5 8L8.5 4M12.5 8L8.5 12"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
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
  {
    projectId, fileId, languageId, s, canApprove, currentUserId, onSaved, onJumpToMatch,
    isActive = true, onDirtyChange,
  },
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

  // Mirrors a just-persisted draft into the cached file-strings entry
  // this component's own useState initializer reads on mount.
  //
  // Necessary because switching to another open tab and back genuinely
  // remounts this component: the tab panel is hidden with `display:
  // none`, so SideBySideView's virtualizer measures a zero-height
  // scroll container, tears its rows down, and rebuilds them when the
  // panel is shown again. The remounted editor re-derives `text` from
  // whatever `s.draft` says. saveDraft only writes SQLite, so without
  // this the cached `s` still holds whatever the last fetch returned —
  // and the live edit gets replaced by a stale draft, or (when nothing
  // has refetched since the file was opened, the common case) by
  // bestTranslationText's already-submitted translation.
  //
  // setQueryData rather than invalidateQueries: this is local-only
  // state we already know the value of, so there's nothing to go ask
  // the backend for, and a refetch mid-edit would be a much bigger
  // hammer. Applied synchronously, before the request resolves, so a
  // remount racing the in-flight save still reads the right text.
  const syncDraftToCache = (draftText: string) => {
    queryClient.setQueryData<FileStringsResponse>(
      ["file-strings", projectId, fileId, languageId],
      (prev) =>
        prev && {
          ...prev,
          strings: prev.strings.map((row) =>
            row.id === s.id
              ? { ...row, draft: { string_id: s.id, draft_text: draftText, dirty: 1 } }
              : row,
          ),
        },
    );
  };

  const flushDraft = () => {
    if (textRef.current === lastSavedDraftRef.current) return;
    lastSavedDraftRef.current = textRef.current;
    syncDraftToCache(textRef.current);
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

  // Follow the server while there's nothing at stake.
  //
  // The box's text is state, seeded once at mount, so a refresh that brought
  // in someone else's newer translation updated the candidate list while
  // leaving the box showing the old one — and worse, that made the box look
  // dirty, since "dirty" means differing from the current server text.
  //
  // Adopt the new text only if the box still matched the PREVIOUS server
  // text, i.e. the user had typed nothing of their own. A real edit (or a
  // restored draft, which never equals the server text) is never touched;
  // that case is what the workspace's update banner is for.
  const serverText = bestTranslationText(s);
  const lastServerTextRef = useRef(serverText);
  useEffect(() => {
    if (serverText === lastServerTextRef.current) return;
    const wasClean = textRef.current.trim() === lastServerTextRef.current.trim();
    lastServerTextRef.current = serverText;
    if (!wasClean) return;
    setText(serverText);
    // Whatever is in the box now came from Crowdin, not from a suggestion.
    setAppliedProvider(null);
    // Keep the draft bookkeeping in step, or the debounced save would fire
    // and persist a dirty draft that merely echoes what Crowdin already has.
    lastSavedDraftRef.current = serverText;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverText]);

  // "Unsubmitted work" means the box differs from the translation that's
  // actually on Crowdin — which is exactly what a refresh would replace it
  // with. Compared against bestTranslationText rather than the saved draft:
  // a draft IS unsubmitted work, so treating it as clean would let a
  // refresh quietly discard it.
  const isDirty = text.trim() !== bestTranslationText(s).trim();
  useEffect(() => {
    onDirtyChange?.(s.id, isDirty);
    // Report clean on unmount, or a string edited and then scrolled out of
    // the virtualized list would hold the banner open forever.
    return () => onDirtyChange?.(s.id, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDirty, s.id]);

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
    mutationFn: () => api.submitTranslation(projectId, s.id, languageId, text, submittedProvider),
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
  // Each entry is captured rather than eagerly refetching — react-query's
  // own refetchOnWindowFocus (default on, and this data is usually well
  // past its 30s staleTime by the time anyone clicks Delete) can refetch
  // behind this component's back at any moment, which would otherwise
  // make the candidate disappear immediately regardless of the undo
  // window. displayTranslations appends each one back on whenever it's
  // missing from the live list but still pending, so the visual "stays
  // put" behavior holds regardless of what triggered the refetch.
  const [pendingDeletes, setPendingDeletes] = useState<Map<number, TranslationInfo>>(new Map());
  const [restoringIds, setRestoringIds] = useState<Set<number>>(new Set());

  // Excludes candidates currently pending-delete from "does this match
  // what's already saved" — matching Crowdin's own editor, deleting a
  // candidate and immediately typing/pasting the exact same text back in
  // is a legitimate way to resubmit it as a brand-new translation (own
  // author, own timestamp) even while its Undo overlay is still up.
  // Without this exclusion, text still equal to the just-deleted
  // candidate's text kept comparing equal to bestTranslationText(s)
  // (s.translations isn't refetched during the undo window — see
  // TranslationItem's delete mutation below) and Save stayed disabled,
  // silently blocking exactly the resubmit Crowdin itself allows.
  const activeTranslations = useMemo(
    () => s.translations.filter((t) => !pendingDeletes.has(t.id)),
    [s.translations, pendingDeletes],
  );
  const bestActiveText = activeTranslations.find((t) => t.is_approved)?.text ?? activeTranslations[0]?.text ?? "";
  const dirty = text.trim() !== "" && text !== bestActiveText;
  // Explains Save's disabled state rather than leaving a plain greyed-out
  // button with no indication of which of the two distinct reasons (never
  // typed anything vs. already matches what's saved) applies.
  const saveDisabledReason = dirty
    ? undefined
    : text.trim() === ""
      ? "Nothing to save — type a translation first"
      : "No changes to save — this already matches the current translation";

  const handleDeleted = (t: TranslationInfo) => {
    setPendingDeletes((prev) => {
      const next = new Map(prev);
      next.set(t.id, t);
      return next;
    });
  };

  // Pending-deleted candidates are merged back in using the exact same
  // ordering the backend itself uses (get_file_strings' own ORDER BY
  // t.is_approved DESC, t.created_at DESC) rather than either extreme:
  // splicing back at the original array index (a translation submitted
  // AFTER the delete could land BELOW a ghost that just happened to sit
  // at a lower index) or always appending at the very end (correct
  // relative to anything newer, but shoves the ghost past older, still-
  // live candidates it was never actually below). Sorting the combined
  // set by each item's own is_approved/created_at — captured at delete
  // time for the ghost, unchanged for everything live — naturally slots
  // it back in wherever it always belonged, with a genuinely newer
  // candidate still sorting above it on created_at alone.
  const displayTranslations = useMemo(() => {
    if (pendingDeletes.size === 0) return s.translations;
    const missing = Array.from(pendingDeletes.values()).filter(
      (t) => !s.translations.some((live) => live.id === t.id),
    );
    if (missing.length === 0) return s.translations;
    return [...s.translations, ...missing].sort((a, b) => {
      if (a.is_approved !== b.is_approved) return b.is_approved - a.is_approved;
      return (b.created_at ?? "").localeCompare(a.created_at ?? "");
    });
  }, [s.translations, pendingDeletes]);

  // Persisted history (deleted_translations, embedded per-string by
  // get_file_strings) minus whatever's already shown inline via
  // pendingDeletes' own "Deleted · Undo" overlay above — without this
  // exclusion, a delete from earlier in THIS session (still tracked in
  // pendingDeletes, still appended onto displayTranslations) would show
  // up twice the moment anything else triggers a refetch, since by then
  // it's already landed in deleted_translations server-side too.
  const historicalDeletes = useMemo(
    () => s.deleted_translations.filter((d) => !pendingDeletes.has(d.id)),
    [s.deleted_translations, pendingDeletes],
  );

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

  // Same finalize-on-leaving idea, but for switching TABS rather than
  // strings: unmounting (above) only happens when a different string is
  // focused within the same tab (key={s.id} remounts this). Every open
  // tab's own TranslationWorkspace stays mounted the whole time, just
  // hidden via CSS, so a delete's inline overlay would otherwise survive
  // indefinitely on a tab you've since switched away from — still
  // showing "Deleted · Undo" (and still counted in dirty's exclusion
  // above) for a string you're no longer even looking at. isActive
  // going false is that signal: drop the tracking so the overlay
  // disappears, and refetch so the persisted "Deleted" section — which
  // already has this row server-side, see delete_translation_endpoint —
  // picks it up instead of leaving it looking like nothing happened.
  useEffect(() => {
    if (isActive || pendingDeletes.size === 0) return;
    setPendingDeletes(new Map());
    refetchStrings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive]);

  // Focus the edit box the moment a candidate is picked, cursor at the
  // end, so you can click a candidate and start typing immediately
  // instead of needing a second click into the field. Deferred to the
  // next frame since the textarea's DOM value only reflects the new text
  // after this render commits — selecting a range against the stale
  // value would misplace the cursor.
  //
  // Shift+click appends instead of replacing — separated by two blank
  // lines, for stitching a candidate or TM suggestion onto the end of
  // what's already there (e.g. a multi-paragraph string where different
  // candidates each got one paragraph right) rather than always starting
  // over from scratch. Reading el.value.length after the state commits
  // (rather than computing the new length ourselves) keeps the cursor
  // placement correct for both modes without duplicating that math.
  // Set when a TM suggestion is applied, and cleared by ANY subsequent
  // change to the box — typing, inserting a glossary term, picking another
  // candidate, or the editor adopting newer server text.
  //
  // Deliberately not a value comparison against the suggestion. Reverting an
  // edit back to the identical text does NOT restore the flag: the claim
  // being made to Crowdin is "this came straight from the memory", and once
  // you've been through it by hand that's no longer what happened, however
  // the characters ended up. Only set on replace, never on shift-click
  // append, since a mixture of two sources isn't one suggestion.
  //
  // Resets on remount (switching string or tab), which is correct — the
  // provenance of a restored draft isn't knowable.
  const [appliedProvider, setAppliedProvider] = useState<string | null>(null);
  const submittedProvider = appliedProvider ?? undefined;

  const selectCandidate = (candidateText: string, append = false, fromTm = false) => {
    setAppliedProvider(fromTm && !append ? "tm" : null);
    setText((prev) => (append && prev.trim() !== "" ? `${prev}\n\n\n${candidateText}` : candidateText));
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.selectionStart = el.selectionEnd = el.value.length;
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
        setAppliedProvider(null);
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
        onChange={(e) => {
          setText(e.target.value);
          setAppliedProvider(null);
        }}
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
        {/* Crowdin has this in its own editor toolbar, and it's the fastest
            route for a string that's mostly markup or a proper noun — you
            want the source in the box to edit down, not to retype. Clears
            the TM flag like any other change: the source isn't a memory
            suggestion. */}
        <button
          className="link-button"
          onClick={() => {
            setText(s.text);
            setAppliedProvider(null);
            requestAnimationFrame(() => {
              const el = textareaRef.current;
              if (!el) return;
              el.focus();
              el.selectionStart = el.selectionEnd = el.value.length;
            });
          }}
          title="Put the source text in the translation box"
        >
          Copy source
        </button>
        <button
          className="btn-primary"
          onClick={() => submit.mutate()}
          disabled={!dirty || submit.isPending}
          title={submit.isPending ? undefined : saveDisabledReason}
        >
          {submit.isPending ? "Saving…" : "Save"}
        </button>
        <StatusBadge status={status} />
        {errorMessage && <span className="error">{errorMessage}</span>}
      </div>

      {displayTranslations.length > 0 && (
        <ul className="translation-list">
          {displayTranslations.map((t) => (
            <TranslationItem
              key={t.id}
              projectId={projectId}
              fileId={fileId}
              t={t}
              canApprove={canApprove}
              currentUserId={currentUserId}
              onChanged={refetchStrings}
              onDeleted={() => handleDeleted(t)}
              onSelect={(append) => selectCandidate(t.text, append)}
              selected={text === t.text}
              pendingDelete={pendingDeletes.has(t.id)}
              onUndoDelete={() => undoMutation.mutate(t.id)}
              undoPending={restoringIds.has(t.id)}
            />
          ))}
        </ul>
      )}

      <DeletedHistorySection
        items={historicalDeletes}
        restoringIds={restoringIds}
        onUndo={(translationId) => undoMutation.mutate(translationId)}
      />

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
                  onClick={(e) => selectCandidate(m.target_text, e.shiftKey, true)}
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
                  {(m.matched_user_name || m.updated_at) && (
                    <div className="suggestion-meta">
                      {m.matched_user_name ? (
                        <span title={fullDateTime(m.matched_created_at as string)}>
                          {m.matched_user_name} · {timeAgo(m.matched_created_at as string)}
                        </span>
                      ) : (
                        <span title={fullDateTime(m.updated_at as string)}>
                          Updated {timeAgo(m.updated_at as string)}
                        </span>
                      )}
                      {m.matched_string_id != null && m.matched_file_id != null && (
                        <button
                          className="link-button suggestion-jump-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            onJumpToMatch?.(m.matched_file_id as number, m.matched_string_id as number);
                          }}
                          title={m.matched_file_path ?? undefined}
                        >
                          <JumpIcon /> Go to string
                        </button>
                      )}
                    </div>
                  )}
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

/**
 * Collapsed-by-default, absent-if-empty section right under the
 * candidate list — every past deletion for this string that Crowdin
 * still keeps restorable (see delete_translation_endpoint's docstring),
 * not just the one you deleted a moment ago in this same session (that
 * one gets its own inline "Deleted · Undo" overlay in the candidate list
 * above, via pendingDeletes). Collapsed by default since most strings
 * have nothing here and it'd otherwise be dead weight under every single
 * one; the count in the header is enough to know it's worth opening.
 */
function DeletedHistorySection({
  items,
  restoringIds,
  onUndo,
}: {
  items: DeletedTranslationInfo[];
  restoringIds: Set<number>;
  onUndo: (translationId: number) => void;
}) {
  const [collapsed, setCollapsed] = useState(true);

  if (items.length === 0) return null;

  return (
    <div className="tm-suggestions-inline">
      <button
        type="button"
        className="tm-suggestions-inline-header"
        onClick={() => setCollapsed(!collapsed)}
        aria-expanded={!collapsed}
      >
        <span className={`tm-suggestions-inline-caret${collapsed ? "" : " tm-suggestions-inline-caret--open"}`}>▸</span>
        <h4 className="tm-suggestions-inline-title">Deleted</h4>
        <span className="tm-suggestions-inline-hint">{items.length}</span>
      </button>
      {!collapsed && (
        <ul className="suggestion-list">
          {items.map((d) => (
            <li key={d.id} className="translation-item translation-item--history">
              <div className="translation-text">{d.text}</div>
              <div className="translation-meta">
                {d.user_name && <span className="translation-author">{d.user_name}</span>}
                <span className="hint" title={fullDateTime(d.deleted_at)}>
                  deleted {timeAgo(d.deleted_at)}
                </span>
                <button
                  className="link-button"
                  onClick={() => onUndo(d.id)}
                  disabled={restoringIds.has(d.id)}
                >
                  {restoringIds.has(d.id) ? "Restoring…" : "Undo"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

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
  /** append is true on Shift+click — see TranslationEditor's
   * selectCandidate for what that does differently. */
  onSelect: (append: boolean) => void;
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
      onClick={pendingDelete ? undefined : (e) => onSelect(e.shiftKey)}
    >
      <div className="translation-text">{t.text}</div>
      <div className="translation-meta">
        {!!t.is_approved && <span className="approved-badge">✓ Approved</span>}
        <ProvenanceBadge translation={t} />
        {t.user_name && <span className="translation-author">{t.user_name}</span>}
        {t.created_at && (
          <span className="translation-date" title={fullDateTime(t.created_at)}>
            {timeAgo(t.created_at)}
          </span>
        )}
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
