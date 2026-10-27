"use client";

import { type CSSProperties, useSyncExternalStore } from "react";
import { TriageMark } from "@/components/triage-mark";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

type Mode = "light" | "dark";

interface Candidate {
  name: string;
  note: string;
  primary: Record<Mode, { bg: string; fg: string }>;
  // The logo check; the brand color unless set.
  check?: string;
}

// Brand color candidates for --primary (and the focus ring and logo check),
// each shown in both themes. Hues sit clear of the status colors: red 27,
// amber 70, green 155, info blue 250.
const candidates: Candidate[] = [
  {
    name: "Violet (applied)",
    note: "Hue 292, well clear of every status color. The app's primary now.",
    primary: {
      light: { bg: "oklch(0.55 0.22 292)", fg: "oklch(0.985 0 0)" },
      dark: { bg: "oklch(0.56 0.21 292)", fg: "oklch(0.985 0 0)" },
    },
  },
  {
    name: "Indigo",
    note: "Hue 272, only about 20° from the info blue.",
    primary: {
      light: { bg: "oklch(0.52 0.2 272)", fg: "oklch(0.985 0 0)" },
      dark: { bg: "oklch(0.55 0.19 272)", fg: "oklch(0.985 0 0)" },
    },
  },
  {
    name: "Teal",
    note: "Hue 190, calm, but between success green and info blue.",
    primary: {
      light: { bg: "oklch(0.52 0.1 190)", fg: "oklch(0.985 0 0)" },
      dark: { bg: "oklch(0.74 0.12 190)", fg: "oklch(0.18 0.02 190)" },
    },
  },
  {
    name: "Monochrome (previous)",
    note: "The theme before violet, for comparison, with its red check.",
    primary: {
      light: { bg: "oklch(0.205 0 0)", fg: "oklch(0.985 0 0)" },
      dark: { bg: "oklch(0.922 0 0)", fg: "oklch(0.205 0 0)" },
    },
    check: "var(--destructive)",
  },
];

// The neutral and status tokens of each theme, copied from globals.css, so a
// panel shows its theme whatever theme the page is in.
const themeTokens: Record<Mode, Record<string, string>> = {
  light: {
    "--background": "oklch(1 0 0)",
    "--foreground": "oklch(0.145 0 0)",
    "--muted": "oklch(0.97 0 0)",
    "--muted-foreground": "oklch(0.556 0 0)",
    "--secondary": "oklch(0.97 0 0)",
    "--secondary-foreground": "oklch(0.205 0 0)",
    "--border": "oklch(0.922 0 0)",
    "--destructive": "oklch(0.577 0.245 27.325)",
    "--warning": "oklch(0.7 0.16 70)",
    "--success": "oklch(0.6 0.15 155)",
    "--info": "oklch(0.58 0.16 250)",
    colorScheme: "light",
  },
  dark: {
    "--background": "oklch(0.145 0 0)",
    "--foreground": "oklch(0.985 0 0)",
    "--muted": "oklch(0.269 0 0)",
    "--muted-foreground": "oklch(0.708 0 0)",
    "--secondary": "oklch(0.269 0 0)",
    "--secondary-foreground": "oklch(0.985 0 0)",
    "--border": "oklch(1 0 0 / 10%)",
    "--destructive": "oklch(0.704 0.191 22.216)",
    "--warning": "oklch(0.8 0.15 75)",
    "--success": "oklch(0.72 0.16 155)",
    "--info": "oklch(0.72 0.14 250)",
    colorScheme: "dark",
  },
};

const statuses = [
  { label: "Failed", token: "var(--destructive)" },
  { label: "Pending", token: "var(--warning)" },
  { label: "Healthy", token: "var(--success)" },
  { label: "Info", token: "var(--info)" },
];

export function BrandPreview() {
  return (
    <div className="grid w-full gap-6">
      {candidates.map((c) => (
        <div key={c.name} className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium text-sm">{c.name}</span>
            <span className="text-muted-foreground text-xs">{c.note}</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Panel candidate={c} mode="light" />
            <Panel candidate={c} mode="dark" />
          </div>
        </div>
      ))}
    </div>
  );
}

function Panel({ candidate, mode }: { candidate: Candidate; mode: Mode }) {
  const { bg, fg } = candidate.primary[mode];
  const style = {
    ...themeTokens[mode],
    "--primary": bg,
    "--primary-foreground": fg,
    "--ring": bg,
  } as CSSProperties;
  // Needs a canvas, so it's measured in the browser; the server render shows
  // the placeholder. A string, so the snapshot compares stable.
  const contrast = useSyncExternalStore(
    subscribeNever,
    () => describeContrast(fg, bg, themeTokens[mode]["--background"]),
    () => "Measuring contrast…",
  );

  return (
    <div
      style={style}
      // `dark` turns on dark: variants inside the dark panel; the components
      // shown here have none, so the light panel is accurate in a dark page.
      className={cn(mode === "dark" && "dark", "flex flex-col gap-4 rounded-lg border bg-background p-4 text-foreground")}
    >
      <div className="flex items-center gap-2">
        <TriageMark className="size-5 text-foreground" checkColor={candidate.check ?? "var(--primary)"} />
        <span className="font-semibold tracking-tight">Triage</span>
        <span className="ml-auto text-muted-foreground text-xs">{mode}</span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" tabIndex={-1}>
          Approve fix
        </Button>
        <Button size="sm" variant="secondary" tabIndex={-1}>
          Deny
        </Button>
        <Button size="sm" variant="secondary" tabIndex={-1} className="border-ring ring-3 ring-ring/50">
          Focused
        </Button>
      </div>

      <ul className="flex flex-col gap-0.5 text-sm">
        {["Overview", "Fix", "Investigation"].map((label, i) => (
          <li
            key={label}
            className={cn(
              "rounded-md px-2 py-1",
              i === 0 ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground",
            )}
          >
            {label}
          </li>
        ))}
      </ul>

      <div className="flex flex-col gap-1.5">
        <span className="text-muted-foreground text-xs">86% confidence</span>
        <Progress value={86} aria-label="Confidence" />
      </div>

      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
        {statuses.map((s) => (
          <span key={s.label} className="flex items-center gap-1.5 text-muted-foreground">
            <span className="size-2 rounded-full" style={{ background: s.token }} />
            {s.label}
          </span>
        ))}
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <span className="size-2 rounded-full bg-primary" />
          Brand
        </span>
      </div>

      <p className="text-muted-foreground text-xs tabular-nums">{contrast}</p>
    </div>
  );
}

const subscribeNever = () => () => {};

// WCAG contrast of the primary button's text against its fill (text needs
// 4.5:1), and of its fill against the page (a control needs 3:1).
function describeContrast(fg: string, fill: string, page: string): string {
  const f = luminance(fill);
  const text = ratio(luminance(fg), f);
  const surface = ratio(f, luminance(page));
  const mark = (v: number, min: number) => `${v.toFixed(1)}:1 ${v >= min ? "✓" : "✗"}`;
  return `Button text ${mark(text, 4.5)} · button on page ${mark(surface, 3)}`;
}

// Any CSS color to relative luminance, via a 1px canvas (which handles oklch).
function luminance(color: string): number {
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!ctx) return 0;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function ratio(a: number, b: number): number {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}
