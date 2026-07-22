import { useEffect, useRef, useState } from "react";
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
  hasNextFile: boolean;
  hasPrevFile: boolean;
  onNavigateFile: (direction: "next" | "prev") => void;
}

const ARM_TIMEOUT_MS = 3000;

/** Matches Crowdin's own "Comfortable" editor view: one string at a time,
 * translation editor directly under the source, prev/next navigation.
 *
 * Pressing Next past the last string (or Previous before the first)
 * doesn't jump files immediately — it "arms" with a visible hint, and
 * only a second press within a few seconds actually switches tabs. A
 * single accidental extra click at the end of a file is common and
 * shouldn't fling you into the next one unannounced. */
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
  hasNextFile,
  hasPrevFile,
  onNavigateFile,
}: ComfortableViewProps) {
  const [armed, setArmed] = useState<"next" | "prev" | null>(null);
  const armTimeoutRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (armTimeoutRef.current != null) window.clearTimeout(armTimeoutRef.current);
  }, []);

  const disarm = () => {
    if (armTimeoutRef.current != null) window.clearTimeout(armTimeoutRef.current);
    setArmed(null);
  };

  const arm = (direction: "next" | "prev") => {
    if (armTimeoutRef.current != null) window.clearTimeout(armTimeoutRef.current);
    setArmed(direction);
    armTimeoutRef.current = window.setTimeout(() => setArmed(null), ARM_TIMEOUT_MS);
  };

  const s = strings[focusedIndex];
  if (!s) return null;

  const isLast = focusedIndex === strings.length - 1;
  const isFirst = focusedIndex === 0;

  const handlePrevious = () => {
    if (!isFirst) {
      disarm();
      onFocusChange(focusedIndex - 1);
      return;
    }
    if (armed === "prev") {
      disarm();
      onNavigateFile("prev");
    } else {
      arm("prev");
    }
  };

  const handleNext = () => {
    if (!isLast) {
      disarm();
      onFocusChange(focusedIndex + 1);
      return;
    }
    if (armed === "next") {
      disarm();
      onNavigateFile("next");
    } else {
      arm("next");
    }
  };

  return (
    <div className="comfortable-view">
      <div className="comfortable-scroll">
        <div className="string-source">{s.text}</div>
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
        <div className="comfortable-pager-nav">
          {armed === "prev" && <span className="pager-hint">Press again for the previous file</span>}
          <button onClick={handlePrevious} disabled={isFirst && !hasPrevFile}>
            ← Previous
          </button>
        </div>
        <span className="comfortable-pager-count">
          {focusedIndex + 1} / {strings.length}
        </span>
        <div className="comfortable-pager-nav">
          <button onClick={handleNext} disabled={isLast && !hasNextFile}>
            Next →
          </button>
          {armed === "next" && <span className="pager-hint">Press again for the next file</span>}
        </div>
      </div>
    </div>
  );
}
