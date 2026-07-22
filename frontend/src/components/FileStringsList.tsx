import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef } from "react";
import type { SourceString } from "../api/client";

interface FileStringsListProps {
  strings: SourceString[];
  focusedStringId: number | null;
  onSelect: (stringId: number) => void;
}

const ROW_HEIGHT = 46;

/** Matches Crowdin's own "STRINGS" tab: a flat list of every string in the
 * currently open file, letting you jump straight to one in Comfortable
 * view instead of paging through them one at a time. */
export function FileStringsList({ strings, focusedStringId, onSelect }: FileStringsListProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: strings.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  if (strings.length === 0) {
    return <p className="hint">No strings in this file.</p>;
  }

  return (
    <div ref={parentRef} className="file-strings-scroll">
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const s = strings[virtualRow.index];
          const approved = s.translations.find((t) => t.is_approved);
          return (
            <div
              key={s.id}
              className={`fsl-row${s.id === focusedStringId ? " fsl-row--active" : ""}`}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`,
              }}
              onClick={() => onSelect(s.id)}
            >
              <div className="fsl-source">{s.text}</div>
              <div className="fsl-status">
                {approved ? "✓" : s.translations.length > 0 ? "…" : ""}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
