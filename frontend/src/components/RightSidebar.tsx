import { useState } from "react";
import { CommentsPanel } from "./CommentsPanel";

interface RightSidebarProps {
  projectId: number;
  stringId: number | null;
  languageId: string;
}

// One entry per tab. Adding TM suggestions / Glossary later is just
// another entry here plus a case in the switch below — the icon rail,
// collapse behavior, and panel chrome are already generic.
const TABS = [{ key: "comments", label: "Comments", icon: "💬" }] as const;

type TabKey = (typeof TABS)[number]["key"];

/** Right sidebar, matching Crowdin's own icon-rail layout: a vertical
 * strip of tab icons, one panel visible at a time, collapsible to just
 * the rail to reclaim width for the editor. Currently only Comments
 * exists; TM suggestions and Glossary will land as more tabs here. */
export function RightSidebar({ projectId, stringId, languageId }: RightSidebarProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>("comments");

  const selectTab = (key: TabKey) => {
    if (!collapsed && key === activeTab) {
      setCollapsed(true);
    } else {
      setActiveTab(key);
      setCollapsed(false);
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
          </button>
        ))}
      </div>

      {!collapsed && (
        <aside className="right-sidebar-panel">
          <h3 className="right-sidebar-title">{TABS.find((t) => t.key === activeTab)!.label}</h3>
          {activeTab === "comments" && (
            <CommentsPanel projectId={projectId} stringId={stringId} languageId={languageId} />
          )}
        </aside>
      )}
    </div>
  );
}
