"use client";

import { useEffect, useSyncExternalStore } from "react";
import { applyTheme, darkQuery, THEME_STORAGE_KEY, type Theme, type ThemePreference } from "@/lib/theme";

// One store for both inputs: the saved preference (this tab's writes, and
// other tabs' via the storage event) and the system's light/dark setting.
const listeners = new Set<() => void>();
const notify = () => {
  for (const l of listeners) l();
};

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  const mql = window.matchMedia(darkQuery);
  if (listeners.size === 1) {
    window.addEventListener("storage", notify);
    mql.addEventListener("change", notify);
  }
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0) {
      window.removeEventListener("storage", notify);
      mql.removeEventListener("change", notify);
    }
  };
}

function readPreference(): ThemePreference {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    return saved === "light" || saved === "dark" ? saved : "system";
  } catch {
    return "system";
  }
}

const systemTheme = (): Theme => (window.matchMedia(darkQuery).matches ? "dark" : "light");

// The saved preference, the theme it resolves to, and a setter. The server
// render assumes "system" (it can't see localStorage); the inline script has
// already applied the real theme, and hydration then reads the real value.
export function useTheme() {
  const preference = useSyncExternalStore(subscribe, readPreference, () => "system" as const);
  const system = useSyncExternalStore(subscribe, systemTheme, () => "dark" as const);
  const theme: Theme = preference === "system" ? system : preference;

  const setPreference = (next: ThemePreference) => {
    try {
      if (next === "system") localStorage.removeItem(THEME_STORAGE_KEY);
      else localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage blocked (some private modes): nothing to save or apply.
      return;
    }
    notify();
  };

  return { preference, theme, setPreference };
}

// Keeps <html> on the resolved theme after hydration: when the preference
// changes here or in another tab, or the system flips while on "system".
// Mounted once, in the root layout. It reads the real theme rather than the
// hook's value: on the hydrating render that value is still the server's
// guess, and applying it would flash the wrong theme for a frame.
export function ThemeSync() {
  const { theme } = useTheme();
  useEffect(() => {
    const preference = readPreference();
    applyTheme(preference === "system" ? systemTheme() : preference);
  }, [theme]);
  return null;
}
