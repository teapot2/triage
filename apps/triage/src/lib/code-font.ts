// The code viewers' font size: a saved choice in localStorage, applied as
// the --code-font-size variable on <html>. The same approach as the theme:
// shared by the client hook (reads, writes, other tabs' changes) and the
// inline script that applies it before first paint; kept out of the client
// module so a Server Component can import it.

export type CodeFontSize = "small" | "default" | "large";

export const CODE_FONT_STORAGE_KEY = "code-font-size";

// Default matches the 14px the code blocks used before the setting.
export const codeFontSizes: Record<CodeFontSize, string> = {
  small: "12px",
  default: "14px",
  large: "16px",
};

export function applyCodeFontSize(size: CodeFontSize) {
  document.documentElement.style.setProperty("--code-font-size", codeFontSizes[size]);
}

// Runs inline in <head>, before first paint, so a block on screen at load
// (a fix's diff) never jumps from the default size. With nothing saved, the
// variable's default in globals.css applies.
export const codeFontScript = `(function(){try{var s=${JSON.stringify(codeFontSizes)}[localStorage.getItem(${JSON.stringify(CODE_FONT_STORAGE_KEY)})];if(s)document.documentElement.style.setProperty("--code-font-size",s);}catch(e){}})();`;
