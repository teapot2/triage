"use client";

import { useEffect, useSyncExternalStore } from "react";
import { applyColorTheme, COLOR_THEME_STORAGE_KEY, type ColorTheme, isColorTheme } from "@/lib/color-theme";

// The saved theme: this tab's writes, and other tabs' via the storage event.
const listeners = new Set<() => void>();
const notify = () => {
  for (const l of listeners) l();
};

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  if (listeners.size === 1) window.addEventListener("storage", notify);
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0) window.removeEventListener("storage", notify);
  };
}

function readColorTheme(): ColorTheme {
  try {
    const saved = localStorage.getItem(COLOR_THEME_STORAGE_KEY);
    return isColorTheme(saved) ? saved : "triage";
  } catch {
    return "triage";
  }
}

// The saved theme and a setter. The server render assumes Triage (it can't
// see localStorage); the inline script has already applied the real theme,
// and hydration then reads the real value.
export function useColorTheme() {
  const colorTheme = useSyncExternalStore(subscribe, readColorTheme, () => "triage" as const);

  const setColorTheme = (next: ColorTheme) => {
    try {
      if (next === "triage") localStorage.removeItem(COLOR_THEME_STORAGE_KEY);
      else localStorage.setItem(COLOR_THEME_STORAGE_KEY, next);
    } catch {
      // Storage blocked (some private modes): nothing to save or apply.
      return;
    }
    applyColorTheme(next);
    notify();
  };

  return { colorTheme, setColorTheme };
}

// Applies a theme chosen in another tab. Mounted once, in the root layout.
// It reads the real theme rather than the hook's value, which on the
// hydrating render is still the server's guess.
export function ColorThemeSync() {
  const { colorTheme } = useColorTheme();
  useEffect(() => applyColorTheme(readColorTheme()), [colorTheme]);
  return null;
}
