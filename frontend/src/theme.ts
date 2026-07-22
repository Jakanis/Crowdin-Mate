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
