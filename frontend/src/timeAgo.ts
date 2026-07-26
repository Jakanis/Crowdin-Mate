/** Shared by every place in the app that shows a relative timestamp
 * (translation candidates, TM suggestion matches, the offline queue, the
 * deleted-translations history, the tree's "last synced" tooltip) — was
 * previously copy-pasted into four separate components. fullDateTime is
 * the companion for a `title` tooltip wherever timeAgo's own output is
 * rendered as visible text, since "3d ago" alone can't answer "which day
 * exactly" without opening Crowdin itself. */
export function timeAgo(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function fullDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
