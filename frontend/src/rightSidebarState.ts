import { useState } from "react";

const COLLAPSED_KEY = "crowdin-mate-right-sidebar-collapsed";
const ACTIVE_TAB_KEY = "crowdin-mate-right-sidebar-tab";
const PINNED_KEY = "crowdin-mate-right-sidebar-pinned";

/**
 * Right sidebar's collapsed/active-tab state, lifted here (rather than
 * each RightSidebar instance calling its own useState) for the same
 * reason useAutoAdvance is lifted to App.tsx: one TranslationWorkspace
 * (and its own RightSidebar) exists per OPEN TAB, all mounted at once
 * (hidden via CSS, not unmounted, so switching tabs doesn't lose scroll
 * position). A plain useState per instance would only read localStorage
 * once at that instance's own mount time — toggling collapse in file
 * A's sidebar would never be reflected in file B's already-mounted
 * instance, which is exactly the reported bug ("opens by default
 * regardless of previous state"). One shared instance here, threaded
 * down as props, means every open tab's RightSidebar reflects the same
 * live state, and persists across restarts. Defaults to collapsed.
 *
 * pinned governs whether the sidebar stays open once you've moved on to
 * a different string, or auto-collapses (see RightSidebar's own effect)
 * — for a quick "check this one thing and get out of the way" lookup
 * rather than a panel you want parked open the whole session. Defaults
 * to true (today's only behavior, before pinning existed) so upgrading
 * doesn't change anything until you explicitly unpin.
 */
export function useRightSidebarState() {
  const [collapsed, setCollapsedState] = useState<boolean>(() => {
    const stored = localStorage.getItem(COLLAPSED_KEY);
    return stored === null ? true : stored === "1";
  });
  const [activeTab, setActiveTabState] = useState<string>(
    () => localStorage.getItem(ACTIVE_TAB_KEY) ?? "comments",
  );
  const [pinned, setPinnedState] = useState<boolean>(() => {
    const stored = localStorage.getItem(PINNED_KEY);
    return stored === null ? true : stored === "1";
  });

  const setCollapsed = (next: boolean) => {
    localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
    setCollapsedState(next);
  };

  const setActiveTab = (tab: string) => {
    localStorage.setItem(ACTIVE_TAB_KEY, tab);
    setActiveTabState(tab);
  };

  const setPinned = (next: boolean) => {
    localStorage.setItem(PINNED_KEY, next ? "1" : "0");
    setPinnedState(next);
  };

  return { collapsed, setCollapsed, activeTab, setActiveTab, pinned, setPinned };
}
