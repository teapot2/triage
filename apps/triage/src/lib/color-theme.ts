// The color theme: a palette from a popular editor or app (GitHub, Linear,
// Catppuccin…), each with a light and a dark side, so it combines with the
// light/dark mode (lib/theme) rather than replacing it. A saved choice in
// localStorage, applied as data-color-theme on <html>; the palettes
// themselves are CSS in globals.css. The same approach as the code font
// size: shared by the client hook and the inline script that applies it
// before first paint; kept out of the client module so a Server Component
// can import it.

// Triage first, as the default; the rest A to Z, as the picker lists them.
export const colorThemes = [
  { id: "triage", label: "Triage" },
  { id: "one", label: "Atom One" },
  { id: "catppuccin", label: "Catppuccin" },
  { id: "github", label: "GitHub" },
  { id: "gruvbox", label: "Gruvbox" },
  { id: "linear", label: "Linear" },
  { id: "solarized", label: "Solarized" },
  { id: "vercel", label: "Vercel" },
] as const;

export type ColorTheme = (typeof colorThemes)[number]["id"];

export const COLOR_THEME_STORAGE_KEY = "color-theme";

export const isColorTheme = (value: unknown): value is ColorTheme => colorThemes.some((t) => t.id === value);

// Triage is the stylesheet's own palette, so it sets no attribute.
export function applyColorTheme(theme: ColorTheme) {
  const root = document.documentElement;
  if (theme === "triage") delete root.dataset.colorTheme;
  else root.dataset.colorTheme = theme;
}

// Runs inline in <head>, before first paint, so the page never flashes
// Triage's colors first. An unknown saved value (a theme since removed) is
// ignored.
export const colorThemeScript = `(function(){try{var t=localStorage.getItem(${JSON.stringify(COLOR_THEME_STORAGE_KEY)});if(${JSON.stringify(colorThemes.map((t) => t.id).filter((id) => id !== "triage"))}.indexOf(t)>=0)document.documentElement.dataset.colorTheme=t;}catch(e){}})();`;
