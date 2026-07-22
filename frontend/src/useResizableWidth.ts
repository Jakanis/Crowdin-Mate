import { useRef, useState } from "react";

/**
 * Drag-to-resize width for a side panel, persisted to localStorage.
 * `sign` says which side of the drag handle the panel sits on: 1 if the
 * panel is to the left of the handle (dragging right grows it, like the
 * left file-tree sidebar), -1 if the panel is to the right of the handle
 * (dragging left grows it, like the right TM/comments sidebar).
 */
export function useResizableWidth(storageKey: string, defaultWidth: number, min: number, max: number) {
  const [width, setWidth] = useState<number>(() => {
    const stored = Number(localStorage.getItem(storageKey));
    return stored >= min && stored <= max ? stored : defaultWidth;
  });
  const widthRef = useRef(width);
  widthRef.current = width;

  const startResize = (e: React.MouseEvent, sign: 1 | -1) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = widthRef.current;

    const onMove = (moveEvent: MouseEvent) => {
      const delta = (moveEvent.clientX - startX) * sign;
      setWidth(Math.min(max, Math.max(min, startWidth + delta)));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      localStorage.setItem(storageKey, String(widthRef.current));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return { width, startResize };
}
