import type { SourceString } from "../api/client";
import { TranslationEditor } from "./TranslationEditor";

interface ComfortableViewProps {
  projectId: number;
  fileId: number;
  languageId: string;
  strings: SourceString[];
  focusedIndex: number;
  onFocusChange: (index: number) => void;
  canApprove: boolean;
  currentUserId: number | null;
  autoAdvance: boolean;
}

/** Matches Crowdin's own "Comfortable" editor view: one string at a time,
 * translation editor directly under the source, prev/next navigation. */
export function ComfortableView({
  projectId,
  fileId,
  languageId,
  strings,
  focusedIndex,
  onFocusChange,
  canApprove,
  currentUserId,
  autoAdvance,
}: ComfortableViewProps) {
  const s = strings[focusedIndex];
  if (!s) return null;

  const isLast = focusedIndex === strings.length - 1;

  return (
    <div className="comfortable-view">
      <div className="comfortable-scroll">
        <div className="string-source">{s.text}</div>
        {s.context && <div className="string-context">{s.context}</div>}

        <TranslationEditor
          key={s.id}
          projectId={projectId}
          fileId={fileId}
          languageId={languageId}
          s={s}
          canApprove={canApprove}
          currentUserId={currentUserId}
          onSaved={autoAdvance && !isLast ? () => onFocusChange(focusedIndex + 1) : undefined}
        />
      </div>

      <div className="comfortable-pager">
        <button
          onClick={() => onFocusChange(Math.max(0, focusedIndex - 1))}
          disabled={focusedIndex === 0}
        >
          ← Previous
        </button>
        <span className="comfortable-pager-count">
          {focusedIndex + 1} / {strings.length}
        </span>
        <button
          onClick={() => onFocusChange(Math.min(strings.length - 1, focusedIndex + 1))}
          disabled={focusedIndex === strings.length - 1}
        >
          Next →
        </button>
      </div>
    </div>
  );
}
