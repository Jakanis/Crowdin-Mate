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
    request<{ directories: number; files: number; synced_at: string }>(
      `/projects/${projectId}/sync-tree`,
      { method: "POST" },
    ),
  getTree: (projectId: number) => request<TreeResponse>(`/projects/${projectId}/tree`),
  getFileStrings: (projectId: number, fileId: number, languageId: string) =>
    request<FileStringsResponse>(
      `/projects/${projectId}/files/${fileId}/strings?language_id=${encodeURIComponent(languageId)}`,
    ),
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
};
