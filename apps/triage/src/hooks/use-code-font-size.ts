"use client";

import { useEffect, useSyncExternalStore } from "react";
import { applyCodeFontSize, CODE_FONT_STORAGE_KEY, type CodeFontSize } from "@/lib/code-font";

// The saved size: this tab's writes, and other tabs' via the storage event.
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

function readSize(): CodeFontSize {
  try {
    const saved = localStorage.getItem(CODE_FONT_STORAGE_KEY);
    return saved === "small" || saved === "large" ? saved : "default";
  } catch {
    return "default";
  }
}

// The saved size and a setter. The server render assumes the default (it
// can't see localStorage); the inline script has already applied the real
// size, and hydration then reads the real value.
export function useCodeFontSize() {
  const size = useSyncExternalStore(subscribe, readSize, () => "default" as const);

  const setSize = (next: CodeFontSize) => {
    try {
      if (next === "default") localStorage.removeItem(CODE_FONT_STORAGE_KEY);
      else localStorage.setItem(CODE_FONT_STORAGE_KEY, next);
    } catch {
      // Storage blocked (some private modes): nothing to save or apply.
      return;
    }
    applyCodeFontSize(next);
    notify();
  };

  return { size, setSize };
}

// Applies a size chosen in another tab. Mounted once, in the root layout.
// It reads the real size rather than the hook's value, which on the
// hydrating render is still the server's guess.
export function CodeFontSync() {
  const { size } = useCodeFontSize();
  useEffect(() => applyCodeFontSize(readSize()), [size]);
  return null;
}
