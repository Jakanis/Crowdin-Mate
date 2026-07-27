import { useRef } from "react";
import type { SourceString } from "../api/client";
import { HighlightedSourceText } from "./HighlightedSourceText";
import { TranslationEditor, type TranslationEditorHandle } from "./TranslationEditor";

interface ComfortableViewProps {
  projectId: number;
  fileId: number;
  languageId: string;
  strings: SourceString[];
  focusedIndex: number;
  onFocusChange: (index: number) => void;
  canApprove: boolean;
  canVote: boolean;
  currentUserId: number | null;
  autoAdvance: boolean;
  onJumpToTmMatch: (fileId: number, stringId: number) => void;
  isActive: boolean;
}

/** Matches Crowdin's own "Comfortable" editor view: one string at a time,
 * translation editor directly under the source. Prev/Next navigation
 * itself lives in TranslationWorkspace's header now (alongside the file
 * path and refresh button) rather than at the bottom of this view — see
 * that component's doc comment for the double-press-to-jump-file logic. */
export function ComfortableView({
  projectId,
  fileId,
  languageId,
  strings,
  focusedIndex,
  onFocusChange,
  canApprove,
  canVote,
  currentUserId,
  autoAdvance,
  onJumpToTmMatch,
  isActive,
}: ComfortableViewProps) {
  const editorRef = useRef<TranslationEditorHandle>(null);

  const s = strings[focusedIndex];
  if (!s) return null;

  const isLast = focusedIndex === strings.length - 1;

  return (
    <div className="comfortable-view">
      <div className="comfortable-scroll">
        <HighlightedSourceText
          projectId={projectId}
          stringId={s.id}
          languageId={languageId}
          text={s.text}
          className="string-source"
          onTermClick={(targetText) => editorRef.current?.insertAtCursor(targetText)}
        />
        {(s.context || s.identifier || s.labels.length > 0) && (
          <div className="string-meta-block">
            {/* Crowdin's own context field is often just a copy of the
                identifier for these XML-sourced strings (TITLE/OBJECTIVE/
                etc.) — only show it as prose when it actually adds
                something beyond the identifier badge below. */}
            {s.context && s.context !== s.identifier && <div className="string-context">{s.context}</div>}
            <div className="string-meta-row">
              {s.identifier && (
                <span className="string-identifier" title="String key">
                  🔑 {s.identifier}
                </span>
              )}
              {s.labels.map((label) => (
                <span key={label.id} className="string-label-tag">
                  {label.title}
                </span>
              ))}
            </div>
          </div>
        )}

        <TranslationEditor
          ref={editorRef}
          key={s.id}
          projectId={projectId}
          fileId={fileId}
          languageId={languageId}
          s={s}
          canApprove={canApprove}
          canVote={canVote}
          currentUserId={currentUserId}
          onSaved={autoAdvance && !isLast ? () => onFocusChange(focusedIndex + 1) : undefined}
          onJumpToMatch={onJumpToTmMatch}
          isActive={isActive}
        />
      </div>
    </div>
  );
}
