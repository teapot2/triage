// The color theme: a saved preference (system, light or dark) in
// localStorage, applied as the `dark` class and `color-scheme` on <html>.
// The same approach as next-themes. Shared by the client hook (reads,
// writes, live updates) and the inline script that applies it before first
// paint; kept out of the client module so a Server Component can import it.

export type ThemePreference = "system" | "light" | "dark";
export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "theme";
export const darkQuery = "(prefers-color-scheme: dark)";

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
}

// Runs inline in <head>, before first paint: resolves the saved preference
// (or the system's, when there is none) and applies it, so the page never
// flashes the other theme. The client hook takes over after hydration.
export const themeScript = `(function(){try{var p=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});var t=p==="light"||p==="dark"?p:matchMedia(${JSON.stringify(darkQuery)}).matches?"dark":"light";var r=document.documentElement;r.classList.toggle("dark",t==="dark");r.style.colorScheme=t;}catch(e){}})();`;
