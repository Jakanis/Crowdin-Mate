const API_BASE = "http://127.0.0.1:8000";

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
}

export interface Project {
  id: number;
  name: string;
  identifier: string;
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
}

export interface ProgressInfo {
  translation_progress: number;
  approval_progress: number;
}

export interface TreeProgressResponse {
  directories: Record<number, ProgressInfo>;
  files: Record<number, ProgressInfo>;
}

export interface TranslationInfo {
  string_id: number;
  id: number;
  text: string;
  user_name: string | null;
  rating: number;
  is_approved: number;
  approval_id: number | null;
  created_at: string | null;
}

export interface DraftInfo {
  string_id: number;
  draft_text: string;
  dirty: number;
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
  draft: DraftInfo | null;
  comment_count: number;
}

export interface FileStringsResponse {
  strings: SourceString[];
}

export interface SubmitTranslationResult {
  status: "synced" | "queued" | "rejected";
  reason?: string;
  translation?: { id: number; text: string; user_name: string | null };
}

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
}

export interface GlossaryMatch {
  source_term: string;
  target_term: string;
  description: string | null;
  glossary_name: string | null;
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
  listProjects: () => request<{ projects: Project[] }>("/projects"),
  syncTree: (projectId: number) =>
    request<{ directories: number; files: number; synced_at: string; changed_file_ids: number[] }>(
      `/projects/${projectId}/sync-tree`,
      { method: "POST" },
    ),
  getTree: (projectId: number) => request<TreeResponse>(`/projects/${projectId}/tree`),
  getTreeProgress: (projectId: number, languageId: string, parentId?: number) =>
    request<TreeProgressResponse>(
      `/projects/${projectId}/tree-progress?language_id=${encodeURIComponent(languageId)}` +
        (parentId != null ? `&parent_id=${parentId}` : ""),
    ),
  getPermissions: (projectId: number) =>
    request<{ is_member: boolean; role: string | null }>(`/projects/${projectId}/permissions`),
  getFileStrings: (projectId: number, fileId: number, languageId: string) =>
    request<FileStringsResponse>(
      `/projects/${projectId}/files/${fileId}/strings?language_id=${encodeURIComponent(languageId)}`,
    ),
  resyncFile: (projectId: number, fileId: number, languageId: string) =>
    request<{ file_id: number; strings: number; translations: number; approvals: number; synced_at: string }>(
      `/projects/${projectId}/files/${fileId}/resync?language_id=${encodeURIComponent(languageId)}`,
      { method: "POST" },
    ),
  getOfflineQueue: () => request<{ items: OfflineQueueItem[] }>("/offline-queue"),
  drainOfflineQueue: () => request<{ drained: number }>("/offline-queue/drain", { method: "POST" }),
  retryOfflineQueueItem: (itemId: number) =>
    request<{ drained: number }>(`/offline-queue/${itemId}/retry`, { method: "POST" }),
  submitTranslation: (projectId: number, stringId: number, languageId: string, text: string) =>
    request<SubmitTranslationResult>(`/projects/${projectId}/strings/${stringId}/translations`, {
      method: "POST",
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
  getComments: (projectId: number, stringId: number) =>
    request<{ comments: CommentInfo[] }>(`/projects/${projectId}/strings/${stringId}/comments`),
  addComment: (projectId: number, stringId: number, languageId: string, text: string) =>
    request<{ status: string; count: number }>(
      `/projects/${projectId}/strings/${stringId}/comments`,
      { method: "POST", body: JSON.stringify({ text, language_id: languageId }) },
    ),
  getTmMatches: (projectId: number, stringId: number, languageId: string) =>
    request<{ matches: TmMatch[] }>(
      `/projects/${projectId}/strings/${stringId}/tm-matches?language_id=${encodeURIComponent(languageId)}`,
    ),
  getGlossaryMatches: (projectId: number, stringId: number, languageId: string) =>
    request<{ matches: GlossaryMatch[] }>(
      `/projects/${projectId}/strings/${stringId}/glossary-matches?language_id=${encodeURIComponent(languageId)}`,
    ),
};
