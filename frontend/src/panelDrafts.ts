import { useCallback, useSyncExternalStore } from "react";

/**
 * Scratch state for the right sidebar's panels — a typed-in search query,
 * a comment you've started writing — held outside the components that
 * render it.
 *
 * It has to live outside them because collapsing the sidebar UNMOUNTS the
 * panel. That's deliberate: every open tab has its own RightSidebar and
 * they're all mounted at once, so keeping the panels mounted while
 * collapsed would leave each one's TM and comment queries live for every
 * open tab, firing real Crowdin requests for panels nobody is looking at.
 * Unmounting keeps that off, but it also threw away whatever you'd typed
 * the moment the panel hid itself — which for an unpinned sidebar is
 * every time you click back into the editor.
 *
 * Keys decide the sharing, and the two kinds of state want different
 * answers:
 *
 * - A search query belongs to the PANEL. Unpinned, the sidebar is a
 *   per-tab scratch pad, so the key is the file. Pinned, it's one panel
 *   you keep parked open while moving between tabs, so every tab shares
 *   one key (see rightSidebarDraftKey).
 * - A comment draft belongs to the STRING it's about, never to a tab or a
 *   panel — so CommentsPanel keys by string id in both modes. Carrying a
 *   half-written comment from one string to another wouldn't just look
 *   odd, it would post it against the wrong string.
 *
 * useSyncExternalStore rather than a plain module variable read at mount:
 * with the sidebar pinned, several mounted instances share one key, and
 * they all have to see the same value as you type — not each keep whatever
 * it happened to read when it mounted.
 */
const values = new Map<string, unknown>();
const listeners = new Map<string, Set<() => void>>();

function subscribe(key: string, listener: () => void): () => void {
  let forKey = listeners.get(key);
  if (!forKey) {
    forKey = new Set();
    listeners.set(key, forKey);
  }
  forKey.add(listener);
  return () => {
    forKey.delete(listener);
    if (forKey.size === 0) listeners.delete(key);
  };
}

function emit(key: string): void {
  for (const listener of listeners.get(key) ?? []) listener();
}

export function setPanelDraft(key: string, value: unknown): void {
  values.set(key, value);
  emit(key);
}

/** Drops the entry entirely rather than storing an empty value — a posted
 * comment's draft shouldn't keep its string's key alive forever. */
export function clearPanelDraft(key: string): void {
  if (!values.has(key)) return;
  values.delete(key);
  emit(key);
}

/** Like useState, but the value outlives this component and is shared with
 * anything else using the same key. `fallback` is used whenever nothing is
 * stored — it is NOT written, so an untouched panel stores nothing.
 *
 * Store primitives, one key per field. getSnapshot has to return a
 * referentially stable value for an unchanged store, and an object or array
 * built inline at the call site is a new reference every render, which
 * useSyncExternalStore treats as a change and loops on. */
export function usePanelDraft<T>(key: string, fallback: T): [T, (value: T) => void] {
  const value = useSyncExternalStore(
    useCallback((listener: () => void) => subscribe(key, listener), [key]),
    () => (values.has(key) ? (values.get(key) as T) : fallback),
  );
  const setValue = useCallback((next: T) => setPanelDraft(key, next), [key]);
  return [value, setValue];
}

/** Which bucket the right sidebar's own panels write into: one shared
 * bucket while pinned, one per file while not. See the note above on why
 * the two modes differ. */
export function rightSidebarDraftKey(pinned: boolean, fileId: number): string {
  return pinned ? "right-sidebar:pinned" : `right-sidebar:file:${fileId}`;
}
