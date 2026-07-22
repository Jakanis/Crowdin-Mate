import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api/client";

interface CommentsPanelProps {
  projectId: number;
  stringId: number | null;
  languageId: string;
}

/**
 * Content for the right sidebar's "Comments" tab — tracks whichever
 * string currently has focus (the selected string in Comfortable mode,
 * or the expanded row in Side-by-Side). The surrounding chrome (aside,
 * icon rail, collapse) lives in RightSidebar; this just renders the tab
 * body so it composes cleanly alongside future TM/Glossary tabs.
 */
export function CommentsPanel({ projectId, stringId, languageId }: CommentsPanelProps) {
  const queryClient = useQueryClient();
  const [text, setText] = useState("");

  const query = useQuery({
    queryKey: ["comments", projectId, stringId],
    queryFn: () => api.getComments(projectId, stringId as number),
    enabled: stringId != null,
  });

  const post = useMutation({
    mutationFn: () => api.addComment(projectId, stringId as number, languageId, text),
    onSuccess: () => {
      setText("");
      queryClient.invalidateQueries({ queryKey: ["comments", projectId, stringId] });
    },
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
        {query.data?.comments.map((c) => (
          <div key={c.id} className="comment">
            <div className="comment-meta">
              <strong>{c.user_name ?? "Unknown"}</strong>
              {c.type === "issue" && <span className="issue-tag">issue</span>}
              {c.is_resolved ? <span className="resolved-tag">resolved</span> : null}
            </div>
            <div className="comment-text">{c.text}</div>
          </div>
        ))}
      </div>
      <div className="add-comment">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          placeholder="Add a comment…"
        />
        <button onClick={() => post.mutate()} disabled={!text.trim() || post.isPending}>
          {post.isPending ? "Posting…" : "Post"}
        </button>
        {post.isError && <span className="error">{(post.error as Error).message}</span>}
      </div>
    </>
  );
}
