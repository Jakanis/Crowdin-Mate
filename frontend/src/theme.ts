import { useEffect, useState } from "react";

export type ThemePreference = "system" | "light" | "dark";
type ResolvedTheme = "light" | "dark";

const THEME_KEY = "classicua-theme";
const SCALE_KEY = "classicua-ui-scale";

function resolveSystemTheme(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

// data-theme is left unset for "system" — the @media (prefers-color-scheme)
// block in styles.css handles that case on its own. Only an explicit
// light/dark choice needs the attribute, since :root[data-theme=...] is
// what outranks the media query when the user disagrees with the OS.
function applyTheme(pref: ThemePreference): ResolvedTheme {
  if (pref === "system") {
    delete document.documentElement.dataset.theme;
    return resolveSystemTheme();
  }
  document.documentElement.dataset.theme = pref;
  return pref;
}

export function useTheme() {
  const [preference, setPreferenceState] = useState<ThemePreference>(
    () => (localStorage.getItem(THEME_KEY) as ThemePreference | null) ?? "system",
  );
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => applyTheme(preference));

  useEffect(() => {
    setResolvedTheme(applyTheme(preference));
    if (preference !== "system") return;
    // Only matters while following the system — an explicit choice
    // shouldn't move just because the OS theme changes underneath it.
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setResolvedTheme(resolveSystemTheme());
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [preference]);

  const setPreference = (pref: ThemePreference) => {
    localStorage.setItem(THEME_KEY, pref);
    setPreferenceState(pref);
  };

  return { preference, resolvedTheme, setPreference };
}

const AUTO_ADVANCE_KEY = "classicua-auto-advance";

// Mirrors Crowdin's own "Automatically move to next string" editor
// setting — same default (on), same meaning: only fires in Comfortable
// view (Side-by-Side already shows every row at once, so "next" isn't a
// meaningful action there), and only after a successful save.
export function useAutoAdvance() {
  const [enabled, setEnabledState] = useState<boolean>(() => {
    const stored = localStorage.getItem(AUTO_ADVANCE_KEY);
    return stored === null ? true : stored === "1";
  });

  const setEnabled = (next: boolean) => {
    localStorage.setItem(AUTO_ADVANCE_KEY, next ? "1" : "0");
    setEnabledState(next);
  };

  return { enabled, setEnabled };
}

const PALETTE_KEY = "classicua-crowdin-palette";

// Swaps our own accent/success/warning/danger tokens for crowdin.com's
// actual editor colors (pulled live via getComputedStyle on their
// CSS custom properties, both themes). Self-contained like useTheme —
// the effect (data-palette on the root) is what styles.css's
// :root[data-palette="crowdin"] blocks key off, so it doesn't matter
// that this hook's own boolean state isn't shared across instances.
export function useCrowdinPalette() {
  const [enabled, setEnabledState] = useState<boolean>(() => {
    const stored = localStorage.getItem(PALETTE_KEY) === "1";
    if (stored) document.documentElement.dataset.palette = "crowdin";
    return stored;
  });

  const setEnabled = (next: boolean) => {
    localStorage.setItem(PALETTE_KEY, next ? "1" : "0");
    if (next) document.documentElement.dataset.palette = "crowdin";
    else delete document.documentElement.dataset.palette;
    setEnabledState(next);
  };

  return { enabled, setEnabled };
}

export const UI_SCALE_STEPS = [0.9, 1, 1.1, 1.25, 1.4];
const DEFAULT_SCALE = 1.1;

function applyScale(scale: number) {
  document.documentElement.style.setProperty("--ui-scale", String(scale));
}

export function useUiScale() {
  const [scale, setScaleState] = useState<number>(() => {
    const stored = Number(localStorage.getItem(SCALE_KEY));
    return UI_SCALE_STEPS.includes(stored) ? stored : DEFAULT_SCALE;
  });

  useEffect(() => applyScale(scale), [scale]);

  const setScale = (next: number) => {
    localStorage.setItem(SCALE_KEY, String(next));
    setScaleState(next);
  };

  return { scale, setScale };
}

export type ViewMode = "comfortable" | "side-by-side";
const VIEW_MODE_KEY = "classicua-view-mode";

// Global preference (moved out of per-file TranslationWorkspace state,
// which meant switching layout in one open tab didn't affect any
// other) — the same "value read directly by a distant component" case
// useAutoAdvance is already lifted for. Lives in Settings now, not a
// per-file toggle.
export function useViewMode() {
  const [mode, setModeState] = useState<ViewMode>(
    () => (localStorage.getItem(VIEW_MODE_KEY) as ViewMode | null) ?? "comfortable",
  );

  const setMode = (next: ViewMode) => {
    localStorage.setItem(VIEW_MODE_KEY, next);
    setModeState(next);
  };

  return { mode, setMode };
}
