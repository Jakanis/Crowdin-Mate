import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { api } from "../api/client";
import { CommentsPanel } from "./CommentsPanel";
import { GlossaryPanel } from "./GlossaryPanel";
import { TmPanel } from "./TmPanel";

interface RightSidebarProps {
  projectId: number;
  stringId: number | null;
  languageId: string;
  sourceLanguageId: string;
  /** The focused string's own source text — passed through to TmPanel
   * to diff against fuzzy TM matches. */
  sourceText: string | null;
  width: number;
  onResizeStart: (e: React.MouseEvent) => void;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  activeTab: string;
  onActiveTabChange: (tab: string) => void;
  /** Whether the panel stays open when you move to a different string —
   * see useRightSidebarState's own doc comment. */
  pinned: boolean;
  onPinnedChange: (pinned: boolean) => void;
  onJumpToTmMatch: (fileId: number, stringId: number) => void;
}

// One entry per tab — the icon rail, collapse behavior, and panel chrome
// are all generic, so a new tab is just another entry here plus a case
// in the render switch below.
const TABS = [
  { key: "comments", label: "Comments", icon: "💬" },
  { key: "tm", label: "TM", icon: "🧠" },
  { key: "glossary", label: "Glossary", icon: "📖" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

/** Right sidebar, matching Crowdin's own icon-rail layout: a vertical
 * strip of tab icons, one panel visible at a time, collapsible to just
 * the rail to reclaim width for the editor. collapsed/activeTab are
 * lifted to App.tsx (see rightSidebarState.ts) rather than owned here —
 * every open tab gets its own RightSidebar instance, all mounted at
 * once, so local state here wouldn't stay in sync across them. */
export function RightSidebar({
  projectId,
  stringId,
  languageId,
  sourceLanguageId,
  sourceText,
  width,
  onResizeStart,
  collapsed,
  onCollapsedChange,
  activeTab,
  onActiveTabChange,
  pinned,
  onPinnedChange,
  onJumpToTmMatch,
}: RightSidebarProps) {

  // Same queryKey CommentsPanel uses, so opening the tab reuses this
  // fetch instead of firing a second one. A short staleTime keeps quick
  // back-and-forth navigation (arrow keys, Prev/Next) from re-triggering
  // a live Crowdin fetch for every string it passes through — this runs
  // on every focus change now, not just when the tab is opened, so it's
  // a much hotter path than before. Query itself is fire-and-forget: it
  // never blocks rendering the translation editor, which loads via its
  // own separate query.
  const commentsQuery = useQuery({
    queryKey: ["comments", projectId, stringId],
    queryFn: () => api.getComments(projectId, stringId as number),
    enabled: stringId != null,
    staleTime: 60_000,
  });
  const commentCount = commentsQuery.data?.comments.length;

  // Unpinned means "just needed this once" — moving on to a different
  // string auto-collapses the panel instead of leaving it parked open.
  // Skips the very first run so simply opening a tab (which mounts this
  // component with whatever string was already focused) doesn't
  // immediately collapse a sidebar you just explicitly opened; only a
  // real navigation to a NEW string after that counts as "done with it".
  const hasMountedRef = useRef(false);
  useEffect(() => {
    if (!hasMountedRef.current) {
      hasMountedRef.current = true;
      return;
    }
    if (!pinned) onCollapsedChange(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stringId]);

  const selectTab = (key: TabKey) => {
    if (!collapsed && key === activeTab) {
      onCollapsedChange(true);
    } else {
      onActiveTabChange(key);
      onCollapsedChange(false);
    }
  };

  return (
    <div className="right-sidebar">
      <div className="right-sidebar-rail">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`rail-icon${!collapsed && activeTab === t.key ? " active" : ""}`}
            onClick={() => selectTab(t.key)}
            title={t.label}
          >
            {t.icon}
            {t.key === "comments" && !!commentCount && (
              <span className="rail-icon-badge">{commentCount}</span>
            )}
          </button>
        ))}
      </div>

      {!collapsed && (
        <>
          <div className="resize-handle" onMouseDown={onResizeStart} />
          <aside className="right-sidebar-panel" style={{ width }}>
          <div className="right-sidebar-header">
            <h3 className="right-sidebar-title">{TABS.find((t) => t.key === activeTab)!.label}</h3>
            <button
              className={`right-sidebar-pin${pinned ? " right-sidebar-pin--active" : ""}`}
              onClick={() => onPinnedChange(!pinned)}
              title={
                pinned
                  ? "Pinned — stays open when you move to a different string. Click to unpin."
                  : "Unpinned — closes automatically when you move to a different string. Click to pin."
              }
            >
              📌
            </button>
          </div>
          {activeTab === "comments" && (
            <CommentsPanel projectId={projectId} stringId={stringId} languageId={languageId} />
          )}
          {activeTab === "tm" && (
            <TmPanel
              projectId={projectId}
              stringId={stringId}
              languageId={languageId}
              sourceLanguageId={sourceLanguageId}
              sourceText={sourceText}
              onJumpToMatch={onJumpToTmMatch}
            />
          )}
          {activeTab === "glossary" && (
            <GlossaryPanel
              projectId={projectId}
              stringId={stringId}
              languageId={languageId}
              sourceLanguageId={sourceLanguageId}
            />
          )}
          </aside>
        </>
      )}
    </div>
  );
}
