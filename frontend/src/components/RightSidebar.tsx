import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "../api/client";
import { PinIcon } from "./PinIcon";
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
  /** Whether the panel stays open once you click away from it — see
   * useRightSidebarState's own doc comment. */
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

  // Unpinned means "get out of the way once I'm done with it", and what
  // marks being done is looking somewhere else — clicking back into the
  // translation pane, the tree, anywhere outside. Pinned stays put.
  //
  // This replaces collapsing whenever the focused STRING changed, which
  // fired at the wrong moments in both directions: paging to the next
  // string closed a panel you were reading, while clicking away from it and
  // staying on the same string left it open.
  //
  // Matched by selector rather than a ref to this instance: one
  // RightSidebar is mounted per open tab and they share collapsed state, so
  // a hidden instance's own ref wouldn't contain a click inside the VISIBLE
  // panel and would collapse it out from under you.
  useEffect(() => {
    if (collapsed || pinned) return;
    const onPointerDown = (e: MouseEvent) => {
      const el = e.target as Element | null;
      if (el?.closest?.(".right-sidebar")) return;
      onCollapsedChange(true);
    };
    // Capture, so it still runs for handlers that stop propagation.
    document.addEventListener("mousedown", onPointerDown, true);
    return () => document.removeEventListener("mousedown", onPointerDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapsed, pinned]);

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
              title={pinned ? "Unpin — hides when you click away" : "Pin — keeps this panel open"}
            >
              <PinIcon />
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
