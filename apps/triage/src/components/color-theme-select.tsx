"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useColorTheme } from "@/hooks/use-color-theme";
import { type ColorTheme, colorThemes, isColorTheme } from "@/lib/color-theme";

// The theme list, as in Codex's: each with an "Aa" swatch in that theme's
// own background and accent. The swatch sets data-color-theme itself, so
// the stylesheet's palette (in the current light or dark mode) paints it
// without the theme being on. The server renders Triage selected;
// hydration switches it to the saved choice.
export function ColorThemeSelect(props: { "aria-label"?: string; "aria-labelledby"?: string }) {
  const { colorTheme, setColorTheme } = useColorTheme();
  return (
    <Select value={colorTheme} onValueChange={(v) => isColorTheme(v) && setColorTheme(v)}>
      <SelectTrigger className="min-w-40" {...props}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper" align="end">
        {colorThemes.map((t) => (
          <SelectItem key={t.id} value={t.id}>
            <Swatch theme={t.id} />
            {t.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function Swatch({ theme }: { theme: ColorTheme }) {
  return (
    <span
      aria-hidden
      data-color-theme={theme}
      className="flex size-5 shrink-0 items-center justify-center rounded-full border bg-background font-medium text-[9px] text-brand"
    >
      Aa
    </span>
  );
}
