import { useState } from "react";
import { UI_SCALE_STEPS, useCrowdinPalette, useTheme, useUiScale, type ThemePreference, type ViewMode } from "../theme";

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const VIEW_MODE_OPTIONS: { value: ViewMode; label: string }[] = [
  { value: "comfortable", label: "Comfortable" },
  { value: "side-by-side", label: "Side-by-Side" },
];

const SCALE_LABELS: Record<number, string> = {
  0.9: "Small",
  1: "Default",
  1.1: "Medium",
  1.25: "Large",
  1.4: "X-Large",
};

interface SettingsMenuProps {
  autoAdvance: boolean;
  onAutoAdvanceChange: (enabled: boolean) => void;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
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
export function SettingsMenu({ autoAdvance, onAutoAdvanceChange, viewMode, onViewModeChange }: SettingsMenuProps) {
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
            <div className="settings-section">
              <label className="settings-checkbox">
                <input
                  type="checkbox"
                  checked={crowdinPalette.enabled}
                  onChange={(e) => crowdinPalette.setEnabled(e.target.checked)}
                />
                Use Crowdin colors
              </label>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
