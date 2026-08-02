import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api/client";
import {
  UI_SCALE_STEPS,
  useCrowdinPalette,
  useTheme,
  useUiScale,
  type OpenTabsLayout,
  type ThemePreference,
  type ViewMode,
} from "../theme";

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const VIEW_MODE_OPTIONS: { value: ViewMode; label: string }[] = [
  { value: "comfortable", label: "Comfortable" },
  { value: "side-by-side", label: "Side-by-Side" },
];

const OPEN_TABS_LAYOUT_OPTIONS: { value: OpenTabsLayout; label: string }[] = [
  { value: "top", label: "Top" },
  { value: "sidebar", label: "Sidebar" },
];

const SCALE_LABELS: Record<number, string> = {
  0.9: "Small",
  1: "Default",
  1.1: "Medium",
  1.25: "Large",
  1.4: "X-Large",
};

const LAUNCH_MODE_OPTIONS: { value: "window" | "browser"; label: string }[] = [
  { value: "window", label: "App window" },
  { value: "browser", label: "Browser" },
];

/** Whether this page is being shown in the app's own window rather than a
 * browser tab.
 *
 * pywebview injects a `pywebview` global into every page it loads (see
 * webview/js/api.js in the package), and nothing else does — so its absence
 * means a real browser. Asking the SERVER which mode it launched in would
 * answer a different question: "Open in browser now" can itself produce a
 * browser tab served by a window-mode instance, and that tab shouldn't
 * offer to open yet another one.
 *
 * Checked at render rather than once at module load, so a page that renders
 * before the injection lands picks it up on the next render instead of
 * being stuck with the wrong answer for the session.
 */
function inNativeWindow(): boolean {
  return typeof (window as { pywebview?: unknown }).pywebview !== "undefined";
}

/** Where the app opens itself — its own window, or a tab in your normal
 * browser (for extensions, devtools, multiple windows).
 *
 * Server-side rather than localStorage, unlike every other setting here:
 * the launcher has to read it before there's any window or frontend to ask,
 * and in browser mode there's never a webview whose storage could hold it.
 *
 * Deliberately does NOT restart the app for you. Restarting on a settings
 * click means taking away whatever you were in the middle of, and the app
 * you'd be restarting is the one showing this menu — so it says what it
 * needs instead, right where the change was made. The Quit button in the
 * header is one click away if you want it now.
 */
function LaunchModeSection() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["launch-mode"], queryFn: api.getLaunchMode });
  const [changed, setChanged] = useState(false);

  const setMode = useMutation({
    mutationFn: (mode: "window" | "browser") => api.setLaunchMode(mode),
    onSuccess: () => {
      setChanged(true);
      queryClient.invalidateQueries({ queryKey: ["launch-mode"] });
    },
  });
  const openNow = useMutation({ mutationFn: api.openInBrowser });

  const mode = query.data?.mode;
  // Null when the backend is running on its own (dev), where there is no
  // launcher to have chosen a mode and nothing for either control to act on.
  if (query.data && query.data.current_url == null) return null;

  return (
    <div className="settings-section">
      <div className="settings-label">Open in</div>
      <div className="settings-segmented">
        {LAUNCH_MODE_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            className={mode === opt.value ? "active" : ""}
            onClick={() => setMode.mutate(opt.value)}
            disabled={setMode.isPending || query.isLoading}
          >
            {opt.label}
          </button>
        ))}
      </div>
      {changed && <p className="settings-note">Applies the next time you start Crowdin Mate.</p>}
      {inNativeWindow() && (
        <button
          className="settings-wide-button"
          onClick={() => openNow.mutate()}
          disabled={openNow.isPending}
          title="Opens this running app in your default browser now, without restarting. The app window stays open."
        >
          {openNow.isSuccess ? "Opened in browser" : "Open in browser now"}
        </button>
      )}
    </div>
  );
}

interface SettingsMenuProps {
  autoAdvance: boolean;
  onAutoAdvanceChange: (enabled: boolean) => void;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  openTabsLayout: OpenTabsLayout;
  onOpenTabsLayoutChange: (layout: OpenTabsLayout) => void;
}

/** Gear icon in the header opening a small popover — theme (with an
 * explicit light/dark choice always winning over the OS preference,
 * see theme.ts) and a UI-scale stepper standing in for a "font size"
 * setting: it zooms the whole app rather than rewriting every font-size
 * rule to rem, which scales text, icons and spacing together the same
 * way a browser's own Ctrl+/Ctrl- zoom would. autoAdvance and viewMode
 * are lifted to App.tsx rather than read via their own hook instances
 * here — see the comment on useAutoAdvance's call site in App.tsx for
 * why (viewMode used to be a per-file-tab toggle in the workspace
 * toolbar; moved here as a global preference instead). */
export function SettingsMenu({
  autoAdvance,
  onAutoAdvanceChange,
  viewMode,
  onViewModeChange,
  openTabsLayout,
  onOpenTabsLayoutChange,
}: SettingsMenuProps) {
  const [open, setOpen] = useState(false);
  const { preference, setPreference } = useTheme();
  const { scale, setScale } = useUiScale();
  const crowdinPalette = useCrowdinPalette();

  const scaleIndex = UI_SCALE_STEPS.indexOf(scale);

  return (
    <div className="settings-menu">
      <button className="settings-gear" onClick={() => setOpen((v) => !v)} title="Settings">
        ⚙
      </button>
      {open && (
        <>
          <div className="settings-backdrop" onClick={() => setOpen(false)} />
          <div className="settings-popover">
            <div className="settings-section">
              <div className="settings-label">Theme</div>
              <div className="settings-segmented">
                {THEME_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    className={preference === opt.value ? "active" : ""}
                    onClick={() => setPreference(opt.value)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              {/* Sits inside the Theme section rather than as a section of
                  its own: it doesn't pick a theme, it restyles whichever
                  theme is selected, so it belongs under that control. */}
              <label className="settings-checkbox settings-checkbox--sub">
                <input
                  type="checkbox"
                  checked={crowdinPalette.enabled}
                  onChange={(e) => crowdinPalette.setEnabled(e.target.checked)}
                />
                Crowdin-like
              </label>
            </div>
            <div className="settings-section">
              <div className="settings-label">Layout</div>
              <div className="settings-segmented">
                {VIEW_MODE_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    className={viewMode === opt.value ? "active" : ""}
                    onClick={() => onViewModeChange(opt.value)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="settings-section">
              <div className="settings-label">Open file tabs</div>
              <div className="settings-segmented">
                {OPEN_TABS_LAYOUT_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    className={openTabsLayout === opt.value ? "active" : ""}
                    onClick={() => onOpenTabsLayoutChange(opt.value)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            <LaunchModeSection />
            <div className="settings-section">
              <div className="settings-label">Font size</div>
              <div className="settings-stepper">
                <button
                  disabled={scaleIndex <= 0}
                  onClick={() => setScale(UI_SCALE_STEPS[Math.max(0, scaleIndex - 1)])}
                  title="Smaller"
                >
                  A−
                </button>
                <span className="settings-stepper-value">{SCALE_LABELS[scale] ?? `${Math.round(scale * 100)}%`}</span>
                <button
                  disabled={scaleIndex >= UI_SCALE_STEPS.length - 1}
                  onClick={() => setScale(UI_SCALE_STEPS[Math.min(UI_SCALE_STEPS.length - 1, scaleIndex + 1)])}
                  title="Larger"
                >
                  A+
                </button>
              </div>
            </div>
            <div className="settings-section">
              <label className="settings-checkbox">
                <input
                  type="checkbox"
                  checked={autoAdvance}
                  onChange={(e) => onAutoAdvanceChange(e.target.checked)}
                />
                Automatically move to next string
              </label>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
