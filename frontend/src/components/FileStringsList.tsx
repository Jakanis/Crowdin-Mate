import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef, useState } from "react";
import type { SourceString } from "../api/client";

interface FileStringsListProps {
  strings: SourceString[];
  focusedStringId: number | null;
  onSelect: (stringId: number) => void;
}

const ROW_HEIGHT = 46;

/** Matches Crowdin's own "STRINGS" tab: a flat list of every string in the
 * currently open file, letting you jump straight to one in Comfortable
 * view instead of paging through them one at a time. The filter box
 * matches source text, any translation, and the identifier — all
 * client-side against the file's already-loaded strings (no round trip,
 * unlike the project-wide Search tab which needs the FTS index). */
export function FileStringsList({ strings, focusedStringId, onSelect }: FileStringsListProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return strings;
    return strings.filter(
      (s) =>
        s.text.toLowerCase().includes(q) ||
        (s.identifier?.toLowerCase().includes(q) ?? false) ||
        s.translations.some((t) => t.text.toLowerCase().includes(q)),
    );
  }, [strings, query]);

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  if (strings.length === 0) {
    return <p className="hint">No strings in this file.</p>;
  }

  return (
    <div className="fsl-container">
      <input
        className="fsl-search-input"
        type="text"
        placeholder="Search strings in this file…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {filtered.length === 0 ? (
        <p className="hint">No strings match "{query}".</p>
      ) : (
        <div ref={parentRef} className="file-strings-scroll">
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const s = filtered[virtualRow.index];
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
      )}
    </div>
  );
}
