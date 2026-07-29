import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type IssueType } from "../api/client";

interface CommentsPanelProps {
  projectId: number;
  stringId: number | null;
  languageId: string;
}

const ISSUE_TYPE_LABELS: Record<IssueType, string> = {
  general_question: "General question",
  translation_mistake: "Translation mistake",
  context_request: "Context request",
  source_mistake: "Source mistake",
};

/**
 * Content for the right sidebar's "Comments" tab — tracks whichever
 * string currently has focus (the selected string in Comfortable mode,
 * or the expanded row in Side-by-Side). The surrounding chrome (aside,
 * icon rail, collapse) lives in RightSidebar; this just renders the tab
 * body so it composes cleanly alongside future TM/Glossary panels.
 */
export function CommentsPanel({ projectId, stringId, languageId }: CommentsPanelProps) {
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [isIssue, setIsIssue] = useState(false);
  const [issueType, setIssueType] = useState<IssueType>("translation_mistake");

  const query = useQuery({
    queryKey: ["comments", projectId, stringId],
    queryFn: () => api.getComments(projectId, stringId as number),
    enabled: stringId != null,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["comments", projectId, stringId] });

  const post = useMutation({
    mutationFn: () =>
      api.addComment(projectId, stringId as number, languageId, text, isIssue ? issueType : undefined),
    onSuccess: () => {
      setText("");
      setIsIssue(false);
      invalidate();
    },
  });

  const resolve = useMutation({
    mutationFn: (commentId: number) => api.resolveComment(projectId, stringId as number, commentId),
    onSuccess: invalidate,
  });
  const unresolve = useMutation({
    mutationFn: (commentId: number) => api.unresolveComment(projectId, stringId as number, commentId),
    onSuccess: invalidate,
  });

  if (stringId == null) {
    return <p className="hint">Select a string to see its comments.</p>;
  }

  return (
    <>
      {query.isLoading && <p className="hint">Loading…</p>}
      {query.isError && <p className="error">{(query.error as Error).message}</p>}
      {query.data && query.data.comments.length === 0 && <p className="hint">No comments yet.</p>}
      <div className="comments-sidebar-list">
        {query.data?.comments.map((c) => {
          // A negative id is a placeholder for a comment written offline
          // that hasn't reached Crowdin yet (see _insert_pending_comment) —
          // it has no author or real id from Crowdin, so labelling it
          // "Unknown" alongside a Resolve button that can't work would
          // misrepresent your own unsent comment as someone else's.
          const pending = c.id < 0;
          return (
            <div key={c.id} className={`comment${pending ? " comment--pending" : ""}`}>
              <div className="comment-meta">
                <strong>{pending ? "You" : c.user_name ?? "Unknown"}</strong>
                {pending && <span className="issue-tag">not sent yet</span>}
                {c.type === "issue" && <span className="issue-tag">{c.issue_type ?? "issue"}</span>}
                {c.is_resolved ? <span className="resolved-tag">resolved</span> : null}
              </div>
              <div className="comment-text">{c.text}</div>
              {c.type === "issue" && !pending && (
                <button
                  className="link-button"
                  onClick={() => (c.is_resolved ? unresolve.mutate(c.id) : resolve.mutate(c.id))}
                  disabled={resolve.isPending || unresolve.isPending}
                >
                  {c.is_resolved ? "Reopen" : "Resolve"}
                </button>
              )}
            </div>
          );
        })}
      </div>
      <div className="add-comment-form">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          placeholder="Add a comment…"
        />
        <div className="add-comment-options">
          <label className="settings-checkbox">
            <input type="checkbox" checked={isIssue} onChange={(e) => setIsIssue(e.target.checked)} />
            Report as issue
          </label>
          {isIssue && (
            <select value={issueType} onChange={(e) => setIssueType(e.target.value as IssueType)}>
              {(Object.keys(ISSUE_TYPE_LABELS) as IssueType[]).map((key) => (
                <option key={key} value={key}>
                  {ISSUE_TYPE_LABELS[key]}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="add-comment">
          <button className="btn-primary" onClick={() => post.mutate()} disabled={!text.trim() || post.isPending}>
            {post.isPending ? "Posting…" : isIssue ? "Report issue" : "Post"}
          </button>
          {post.isError && <span className="error">{(post.error as Error).message}</span>}
        </div>
      </div>
    </>
  );
}
