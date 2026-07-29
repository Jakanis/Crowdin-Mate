import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef } from "react";
import type { SourceString } from "../api/client";
import { HighlightedSourceText } from "./HighlightedSourceText";
import { TranslationEditor, type TranslationEditorHandle } from "./TranslationEditor";

interface SideBySideViewProps {
  projectId: number;
  fileId: number;
  languageId: string;
  strings: SourceString[];
  focusedStringId: number | null;
  onFocusChange: (stringId: number) => void;
  canApprove: boolean;
  currentUserId: number | null;
  onJumpToTmMatch: (fileId: number, stringId: number) => void;
  isActive: boolean;
  /** Reported up so TranslationWorkspace knows whether a background
   * refresh would discard work in progress. */
  onEditorDirtyChange: (stringId: number, dirty: boolean) => void;
}

function bestTranslation(s: SourceString) {
  return s.translations.find((t) => t.is_approved) ?? s.translations[0] ?? null;
}

/** Matches Crowdin's "Side-by-Side" view: every string in the file as a
 * source | translation row. Rows are collapsed to a single-line preview
 * by default; clicking one expands the full candidate list + editor
 * inline (and focuses it for the Comments panel), same as the source
 * data and editing behavior Comfortable mode uses. */
export function SideBySideView({
  projectId,
  fileId,
  languageId,
  strings,
  focusedStringId,
  onFocusChange,
  canApprove,
  currentUserId,
  onJumpToTmMatch,
  isActive,
  onEditorDirtyChange,
}: SideBySideViewProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  // Only ever one expanded row (with a real TranslationEditor mounted)
  // at a time, so one shared ref is enough — same idea as
  // ComfortableView's editorRef.
  const editorRef = useRef<TranslationEditorHandle>(null);

  const virtualizer = useVirtualizer({
    count: strings.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 60,
    overscan: 6,
  });

  // Switching away from this tab makes the whole panel display: none
  // (see workspace-tab-panel's `hidden` attribute) without unmounting
  // it — so the expanded row's real measured size (via measureElement
  // below), taken while it had actual layout, can go stale relative to
  // whatever's expanded by the time you switch back (a different row,
  // or the same row now showing more candidates/suggestions than
  // before). Confirmed live: switching back to a tab whose expanded row
  // had grown taller than its cached measurement left the virtualizer's
  // position math wrong enough that it dropped the first couple of rows
  // from the rendered window entirely, despite scrollTop being 0.
  // measure() clears every cached size so the next render remeasures
  // from scratch against the panel's now-real (visible) layout.
  useEffect(() => {
    if (isActive) virtualizer.measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive]);

  return (
    <div ref={parentRef} className="side-by-side-scroll">
      <div className="side-by-side-header">
        <div>Source</div>
        <div>Translation</div>
      </div>
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const s = strings[virtualRow.index];
          const expanded = s.id === focusedStringId;
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
              <div
                className={`sbs-row${expanded ? " sbs-row--expanded" : ""}`}
                onClick={() => !expanded && onFocusChange(s.id)}
              >
                {expanded ? (
                  <HighlightedSourceText
                    projectId={projectId}
                    stringId={s.id}
                    languageId={languageId}
                    text={s.text}
                    className="sbs-source"
                    onTermClick={(targetText) => editorRef.current?.insertAtCursor(targetText)}
                  />
                ) : (
                  <div className="sbs-source">{s.text}</div>
                )}
                <div className="sbs-translation">
                  {expanded ? (
                    <TranslationEditor
                      ref={editorRef}
                      projectId={projectId}
                      fileId={fileId}
                      languageId={languageId}
                      s={s}
                      canApprove={canApprove}
                      currentUserId={currentUserId}
                      onJumpToMatch={onJumpToTmMatch}
                      isActive={isActive}
                      onDirtyChange={onEditorDirtyChange}
                    />
                  ) : (
                    <div className="sbs-translation-preview">
                      {!!bestTranslation(s)?.is_approved && (
                        <span className="approved-badge sbs-approved-badge" title="Approved">
                          ✓
                        </span>
                      )}
                      {bestTranslation(s)?.text ?? "(no translation yet)"}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
