/**
 * FileTree's progress bars are plain component state fetched lazily
 * per expanded directory (see its own docstring — there's no bulk
 * progress endpoint, and it stays mounted for the whole session so a
 * directory, once fetched, is never refetched on its own). Approving/
 * unapproving/deleting/submitting a translation elsewhere in the app
 * changes exactly those numbers, but nothing was telling FileTree to
 * drop its cached values and re-fetch — the tree kept showing whatever
 * percentage was cached the moment the folder was first expanded, even
 * after a file the user just fully approved (see bug report: approved
 * file still showing its old percentage).
 *
 * A plain window CustomEvent rather than lifting all this state up or
 * threading a callback through every layout (Comfortable/Side-by-Side)
 * down to TranslationEditor — the two components are siblings several
 * levels apart with nothing else in common.
 */
const EVENT_NAME = "classicua-progress-changed";

export function notifyProgressChanged(fileId: number): void {
  window.dispatchEvent(new CustomEvent<{ fileId: number }>(EVENT_NAME, { detail: { fileId } }));
}

export function onProgressChanged(handler: (fileId: number) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<{ fileId: number }>).detail.fileId);
  window.addEventListener(EVENT_NAME, listener);
  return () => window.removeEventListener(EVENT_NAME, listener);
}
