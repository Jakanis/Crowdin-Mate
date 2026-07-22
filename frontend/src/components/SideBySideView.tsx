import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef } from "react";
import type { SourceString } from "../api/client";
import { TranslationEditor } from "./TranslationEditor";

interface SideBySideViewProps {
  projectId: number;
  fileId: number;
  languageId: string;
  strings: SourceString[];
  focusedStringId: number | null;
  onFocusChange: (stringId: number) => void;
  canApprove: boolean;
  currentUserId: number | null;
}

function bestTranslationText(s: SourceString): string {
  const approved = s.translations.find((t) => t.is_approved);
  return approved?.text ?? s.translations[0]?.text ?? "(no translation yet)";
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
}: SideBySideViewProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: strings.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 60,
    overscan: 6,
  });

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
                <div className="sbs-source">{s.text}</div>
                <div className="sbs-translation">
                  {expanded ? (
                    <TranslationEditor
                      projectId={projectId}
                      fileId={fileId}
                      languageId={languageId}
                      s={s}
                      canApprove={canApprove}
                      currentUserId={currentUserId}
                    />
                  ) : (
                    <div className="sbs-translation-preview">{bestTranslationText(s)}</div>
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
