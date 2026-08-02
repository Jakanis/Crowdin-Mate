// The packaged desktop app serves the frontend and the API from the same
// origin (see desktop.py's _pick_port — the backend's port isn't always
// 8000, since it falls back to an OS-assigned one if 8000 is already
// taken), so relative requests just work there regardless of the actual
// port. The dev workflow is the one case frontend and backend are
// genuinely different origins — Vite's dev server is pinned to 5173
// (strictPort, see vite.config.ts) while the dev backend is always 8000 —
// so that's the only case needing an explicit absolute URL.
const API_BASE = window.location.port === "5173" ? "http://127.0.0.1:8000" : "";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export interface AuthStatus {
  configured: boolean;
  mode: "oauth" | "pat" | null;
  oauth_client_configured: boolean;
}

export interface ProjectLanguage {
  id: string;
  name: string;
}

export interface Project {
  id: number;
  name: string;
  identifier: string;
  source_language_id: string;
  target_languages: ProjectLanguage[];
}

export interface TreeDirectory {
  id: number;
  parent_id: number | null;
  name: string;
  path: string;
}

export interface TreeFile {
  id: number;
  directory_id: number | null;
  name: string;
  path: string;
  strings_count: number | null;
}

export interface TreeResponse {
  directories: TreeDirectory[];
  files: TreeFile[];
  last_full_sync_at: string | null;
}

export interface ProgressInfo {
  translation_progress: number;
  approval_progress: number;
  /** Raw counts behind the percentages, shown in the tooltip. Optional
   * because rows cached before these columns existed don't have them. */
  phrases_total?: number | null;
  phrases_translated?: number | null;
  phrases_approved?: number | null;
  words_total?: number | null;
  words_translated?: number | null;
  words_approved?: number | null;
}

export interface TreeProgressResponse {
  directories: Record<number, ProgressInfo>;
  files: Record<number, ProgressInfo>;
}

export interface TranslationInfo {
  string_id: number;
  id: number;
  text: string;
  user_id: number | null;
  user_name: string | null;
  rating: number;
  is_approved: number;
  approval_id: number | null;
  created_at: string | null;
  /** How the translation was produced, as Crowdin records it: null when
   * typed from scratch, "tm" when accepted from a TM suggestion, an engine
   * name for machine translation. Only the per-string sync reports it, so
   * a file cached by the fast offline pass has null until fully synced. */
  provider?: string | null;
  is_pre_translated?: number | null;
}

export interface DeletedTranslationInfo {
  id: number;
  string_id: number;
  text: string;
  user_id: number | null;
  user_name: string | null;
  rating: number;
  is_approved: number;
  created_at: string | null;
  deleted_at: string;
}

export interface DraftInfo {
  string_id: number;
  draft_text: string;
  dirty: number;
}

export interface StringLabel {
  id: number;
  title: string;
}

export interface SourceString {
  id: number;
  identifier: string | null;
  text: string;
  context: string | null;
  max_length: number | null;
  has_plurals: number;
  is_hidden: number;
  translations: TranslationInfo[];
  deleted_translations: DeletedTranslationInfo[];
  draft: DraftInfo | null;
  comment_count: number;
  labels: StringLabel[];
}

export interface FileStringsResponse {
  strings: SourceString[];
}

export interface SubmitTranslationResult {
  status: "synced" | "queued" | "rejected";
  reason?: string;
  translation?: { id: number; text: string; user_name: string | null };
}

export type IssueType = "general_question" | "translation_mistake" | "context_request" | "source_mistake";

export interface CommentInfo {
  id: number;
  text: string;
  user_name: string | null;
  type: string | null;
  issue_type: string | null;
  issue_status: string | null;
  is_resolved: number;
  created_at: string | null;
}

export interface TmMatch {
  source_text: string;
  target_text: string;
  relevant: number;
  tm_name: string | null;
  updated_at: string | null;
  matched_string_id: number | null;
  matched_file_id: number | null;
  matched_file_path: string | null;
  matched_user_name: string | null;
  matched_created_at: string | null;
}

export interface GlossaryMatch {
  source_term: string;
  target_term: string;
  description: string | null;
  glossary_name: string | null;
}

export interface GlossarySearchResult {
  concept_id: number;
  source_term: string;
  target_term: string;
  description: string | null;
}

export interface GlossaryStatus {
  terms: number;
  synced_at: string | null;
}

export interface SearchResult {
  string_id: number;
  file_id: number;
  identifier: string | null;
  file_path: string;
  source_snippet: string;
  target_snippet: string;
  /** Whichever translation the target_snippet came from — null when
   * there's no translation at all yet (source-only match). */
  translator_name: string | null;
  submitted_at: string | null;
  is_approved: boolean;
}

export interface SearchIndexStatus {
  total: number;
  synced: number;
  running: boolean;
  errors: number;
  current_file_path: string | null;
}

/** What's genuinely usable with no connection. files_cached vs files_total
 * is the number that matters: the tree lists every file, but only ones
 * whose content has been synced for this language can be translated
 * offline. */
export interface CacheStatus {
  files_total: number;
  directories: number;
  tree_synced_at: string | null;
  files_cached: number;
  files_stale: number;
  strings: number;
  translations: number;
  search_indexed: number;
  tm_lookups: number;
  glossary_terms: number;
  glossary_synced_at: string | null;
  pending_drafts: number;
  queue_done: number;
}

/** Progress of the opt-in "cache the whole project" job. `pending` counts
 * files never cached for this language PLUS ones Crowdin has touched since,
 * so it isn't simply total - cached. */
export interface OfflineCacheStatus {
  total: number;
  cached: number;
  pending: number;
  running: boolean;
  errors: number;
  current_file_path: string | null;
}

export interface OfflineQueueItem {
  id: number;
  operation_type: string;
  string_id: number;
  language_id: string;
  created_at: string;
  attempts: number;
  last_attempt_at: string | null;
  last_error: string | null;
  status: "pending" | "failed";
  source_text: string | null;
  file_id: number | null;
  file_path: string | null;
  draft_text: string | null;
}

export const api = {
  authStatus: () => request<AuthStatus>("/auth/status"),
  setToken: (token: string) =>
    request<{ ok: boolean; username?: string; name?: string }>("/auth/token", {
      method: "POST",
      body: JSON.stringify({ token }),
    }),
  clearToken: () => request<{ ok: boolean }>("/auth/token", { method: "DELETE" }),
  setOAuthClient: (clientId: string, clientSecret: string) =>
    request<{ ok: boolean }>("/auth/oauth/client", {
      method: "POST",
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
    }),
  getOAuthAuthorizeUrl: () => request<{ url: string }>("/auth/oauth/authorize-url"),
  listProjects: () => request<{ projects: Project[] }>("/projects"),
  syncTree: (projectId: number) =>
    request<{ directories: number; files: number; synced_at: string; changed_file_ids: number[] }>(
      `/projects/${projectId}/sync-tree`,
      { method: "POST" },
    ),
  checkSyncTree: (projectId: number) =>
    request<{ project_id: number; changed: boolean }>(`/projects/${projectId}/sync-tree/check`, {
      method: "POST",
    }),
  getTree: (projectId: number) => request<TreeResponse>(`/projects/${projectId}/tree`),
  getTreeProgress: (projectId: number, languageId: string, parentId?: number) =>
    request<TreeProgressResponse>(
      `/projects/${projectId}/tree-progress?language_id=${encodeURIComponent(languageId)}` +
        (parentId != null ? `&parent_id=${parentId}` : ""),
    ),
  getPermissions: (projectId: number) =>
    request<{ is_member: boolean; role: string | null; user_id: number | null }>(
      `/projects/${projectId}/permissions`,
    ),
  getFileStrings: (projectId: number, fileId: number, languageId: string) =>
    request<FileStringsResponse>(
      `/projects/${projectId}/files/${fileId}/strings?language_id=${encodeURIComponent(languageId)}`,
    ),
  resyncFile: (projectId: number, fileId: number, languageId: string) =>
    request<{ file_id: number; strings: number; translations: number; approvals: number; synced_at: string }>(
      `/projects/${projectId}/files/${fileId}/resync?language_id=${encodeURIComponent(languageId)}`,
      { method: "POST" },
    ),
  searchStrings: (projectId: number, q: string, languageId: string) =>
    request<{ results: SearchResult[] }>(
      `/projects/${projectId}/search?${new URLSearchParams({ q, language_id: languageId }).toString()}`,
    ),
  getSearchIndexStatus: (projectId: number, languageId: string) =>
    request<SearchIndexStatus>(
      `/projects/${projectId}/search-index/status?language_id=${encodeURIComponent(languageId)}`,
    ),
  buildSearchIndex: (projectId: number, languageId: string) =>
    request<SearchIndexStatus & { started: boolean }>(
      `/projects/${projectId}/search-index/build?language_id=${encodeURIComponent(languageId)}`,
      { method: "POST" },
    ),
  stopSearchIndex: (projectId: number, languageId: string) =>
    request<SearchIndexStatus>(
      `/projects/${projectId}/search-index/stop?language_id=${encodeURIComponent(languageId)}`,
      { method: "POST" },
    ),
  getCacheStatus: (projectId: number, languageId: string) =>
    request<CacheStatus>(
      `/projects/${projectId}/cache-status?language_id=${encodeURIComponent(languageId)}`,
    ),
  clearCompletedQueue: () =>
    request<{ deleted: number }>("/offline-queue/clear-completed", { method: "POST" }),
  getOfflineCacheStatus: (projectId: number, languageId: string) =>
    request<OfflineCacheStatus>(
      `/projects/${projectId}/offline-cache/status?language_id=${encodeURIComponent(languageId)}`,
    ),
  buildOfflineCache: (projectId: number, languageId: string) =>
    request<OfflineCacheStatus & { started: boolean }>(
      `/projects/${projectId}/offline-cache/build?language_id=${encodeURIComponent(languageId)}`,
      { method: "POST" },
    ),
  stopOfflineCache: (projectId: number, languageId: string) =>
    request<OfflineCacheStatus>(
      `/projects/${projectId}/offline-cache/stop?language_id=${encodeURIComponent(languageId)}`,
      { method: "POST" },
    ),
  getOfflineQueue: () => request<{ items: OfflineQueueItem[] }>("/offline-queue"),
  drainOfflineQueue: () => request<{ drained: number }>("/offline-queue/drain", { method: "POST" }),
  retryOfflineQueueItem: (itemId: number) =>
    request<{ drained: number }>(`/offline-queue/${itemId}/retry`, { method: "POST" }),
  deleteOfflineQueueItem: (itemId: number) =>
    request<{ ok: boolean }>(`/offline-queue/${itemId}`, { method: "DELETE" }),
  /** Stops the app itself, not just this page — see the endpoint's own note
   * on what "stopping" means per launch mode. */
  shutdown: () => request<{ stopping: boolean }>("/shutdown", { method: "POST" }),
  getSimulateOffline: () => request<{ enabled: boolean }>("/debug/simulate-offline"),
  setSimulateOffline: (enabled: boolean) =>
    request<{ enabled: boolean }>("/debug/simulate-offline", {
      method: "POST",
      body: JSON.stringify({ enabled }),
    }),
  submitTranslation: (
    projectId: number, stringId: number, languageId: string, text: string, provider?: string,
  ) =>
    request<SubmitTranslationResult>(`/projects/${projectId}/strings/${stringId}/translations`, {
      method: "POST",
      body: JSON.stringify({ language_id: languageId, text, provider }),
    }),
  saveDraft: (projectId: number, stringId: number, languageId: string, text: string) =>
    request<{ status: string }>(`/projects/${projectId}/strings/${stringId}/draft`, {
      method: "PUT",
      body: JSON.stringify({ language_id: languageId, text }),
    }),
  approveTranslation: (projectId: number, translationId: number) =>
    request<{ status: string; approval_id: number }>(
      `/projects/${projectId}/translations/${translationId}/approve`,
      { method: "POST" },
    ),
  unapproveTranslation: (projectId: number, translationId: number) =>
    request<{ status: string }>(`/projects/${projectId}/translations/${translationId}/approve`, {
      method: "DELETE",
    }),
  deleteTranslation: (projectId: number, translationId: number) =>
    request<{ status: string }>(`/projects/${projectId}/translations/${translationId}`, {
      method: "DELETE",
    }),
  restoreTranslation: (projectId: number, stringId: number, translationId: number, languageId: string) =>
    request<{ status: string; translation: { id: number; text: string; user_name: string | null } }>(
      `/projects/${projectId}/strings/${stringId}/translations/${translationId}/restore?language_id=${encodeURIComponent(languageId)}`,
      { method: "POST" },
    ),
  voteTranslation: (projectId: number, translationId: number, mark: "up" | "down") =>
    request<{ status: string; rating: number }>(`/projects/${projectId}/translations/${translationId}/vote`, {
      method: "POST",
      body: JSON.stringify({ mark }),
    }),
  getComments: (projectId: number, stringId: number) =>
    request<{ comments: CommentInfo[] }>(`/projects/${projectId}/strings/${stringId}/comments`),
  addComment: (projectId: number, stringId: number, languageId: string, text: string, issueType?: IssueType) =>
    request<{ status: string; count: number }>(
      `/projects/${projectId}/strings/${stringId}/comments`,
      { method: "POST", body: JSON.stringify({ text, language_id: languageId, issue_type: issueType ?? null }) },
    ),
  resolveComment: (projectId: number, stringId: number, commentId: number) =>
    request<{ status: string }>(
      `/projects/${projectId}/strings/${stringId}/comments/${commentId}/resolve`,
      { method: "POST" },
    ),
  unresolveComment: (projectId: number, stringId: number, commentId: number) =>
    request<{ status: string }>(
      `/projects/${projectId}/strings/${stringId}/comments/${commentId}/resolve`,
      { method: "DELETE" },
    ),
  getTmMatches: (projectId: number, stringId: number, languageId: string) =>
    request<{ matches: TmMatch[] }>(
      `/projects/${projectId}/strings/${stringId}/tm-matches?language_id=${encodeURIComponent(languageId)}`,
    ),
  searchTm: (projectId: number, q: string, sourceLanguageId: string, targetLanguageId: string) =>
    request<{ matches: TmMatch[] }>(
      `/projects/${projectId}/tm-search?${new URLSearchParams({
        q,
        source_language_id: sourceLanguageId,
        target_language_id: targetLanguageId,
      }).toString()}`,
    ),
  getGlossaryMatches: (projectId: number, stringId: number, languageId: string) =>
    request<{ matches: GlossaryMatch[] }>(
      `/projects/${projectId}/strings/${stringId}/glossary-matches?language_id=${encodeURIComponent(languageId)}`,
    ),
  getGlossaryStatus: (projectId: number) =>
    request<GlossaryStatus>(`/projects/${projectId}/glossary/status`),
  syncGlossary: (projectId: number) =>
    request<{ terms: number }>(`/projects/${projectId}/glossary/sync`, { method: "POST" }),
  searchGlossary: (projectId: number, q: string, sourceLanguageId: string, targetLanguageId: string) =>
    request<{ results: GlossarySearchResult[] }>(
      `/projects/${projectId}/glossary/search?${new URLSearchParams({
        q,
        source_language_id: sourceLanguageId,
        target_language_id: targetLanguageId,
      }).toString()}`,
    ),
};
