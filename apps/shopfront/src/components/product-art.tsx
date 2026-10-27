import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// Drawn stand-ins for product photos: a flat illustration of the object on a
// tinted backdrop, like a studio shot on colored paper. No real photography,
// so nothing to license, and the grid stays one consistent style.

const tints = {
  sage: { bg: "#e4e8dc", body: "#8a9a7b", shade: "#5f6f52", light: "#b9c4ad" },
  sand: { bg: "#efe6d6", body: "#c9b08a", shade: "#9b7f58", light: "#e2d2b4" },
  clay: { bg: "#f1ddd2", body: "#c47f61", shade: "#8f5340", light: "#e0b09a" },
  sky: { bg: "#dfe6ea", body: "#8fa7b5", shade: "#5d7686", light: "#bccbd3" },
  honey: { bg: "#f3e7c8", body: "#d8b25a", shade: "#a7832f", light: "#ecd59a" },
} as const;

type Tint = keyof typeof tints;
type Colors = (typeof tints)[Tint];

// Each object drawn in a 200×200 box, resting on y≈150.
const drawings: Record<string, (c: Colors) => ReactNode> = {
  mug: (c) => (
    <>
      <path d="M128 92h10a18 18 0 0 1 0 36h-10" fill="none" stroke={c.shade} strokeWidth="9" />
      <rect x="62" y="78" width="70" height="72" rx="12" fill={c.body} />
      <rect x="62" y="78" width="70" height="12" rx="6" fill={c.shade} opacity=".35" />
    </>
  ),
  bowl: (c) => (
    <>
      <path d="M40 102h120a60 50 0 0 1-120 0z" fill={c.body} />
      <ellipse cx="100" cy="102" rx="60" ry="10" fill={c.shade} />
      <circle cx="78" cy="122" r="2.5" fill={c.shade} opacity=".5" />
      <circle cx="112" cy="132" r="2" fill={c.shade} opacity=".5" />
      <circle cx="128" cy="116" r="2.5" fill={c.shade} opacity=".5" />
    </>
  ),
  towel: (c) => (
    <>
      <rect x="58" y="44" width="84" height="106" rx="4" fill={c.light} />
      <rect x="58" y="44" width="84" height="18" rx="4" fill={c.body} />
      {[80, 96, 112, 128].map((y) => (
        <rect key={y} x="58" y={y} width="84" height="4" fill={c.body} opacity=".7" />
      ))}
    </>
  ),
  board: (c) => (
    <>
      <rect x="54" y="40" width="92" height="112" rx="22" fill={c.body} />
      <circle cx="100" cy="60" r="7" fill={c.light} />
      <path d="M70 92c18 8 42 8 60 0M70 112c18 8 42 8 60 0" stroke={c.shade} strokeWidth="2" fill="none" opacity=".5" />
    </>
  ),
  vase: (c) => (
    <>
      <path d="M100 40c-6 14 10 22 4 34" stroke={c.shade} strokeWidth="3" fill="none" />
      <circle cx="100" cy="40" r="7" fill={c.shade} />
      <path d="M92 74h16v8c18 10 22 30 14 50-4 10-12 18-22 18s-18-8-22-18c-8-20-4-40 14-50z" fill={c.body} />
    </>
  ),
  candle: (c) => (
    <>
      <path d="M100 52c8 8 8 18 0 22-8-4-8-14 0-22z" fill="#e9a23b" />
      <rect x="99" y="72" width="2" height="10" fill={c.shade} />
      <rect x="74" y="82" width="52" height="68" rx="6" fill={c.body} />
      <path d="M74 92h52" stroke={c.light} strokeWidth="4" />
    </>
  ),
  jar: (c) => (
    <>
      <rect x="66" y="58" width="68" height="14" rx="4" fill={c.shade} />
      <rect x="64" y="70" width="72" height="80" rx="12" fill={c.light} />
      <rect x="72" y="104" width="56" height="38" rx="6" fill={c.body} opacity=".75" />
    </>
  ),
  plate: (c) => (
    <>
      <ellipse cx="100" cy="128" rx="66" ry="20" fill={c.shade} />
      <ellipse cx="100" cy="120" rx="66" ry="20" fill={c.body} />
      <ellipse cx="100" cy="118" rx="44" ry="12" fill={c.light} />
    </>
  ),
  teapot: (c) => (
    <>
      <path d="M58 104c-12-4-20-14-22-22l12 2c4 8 10 12 16 12z" fill={c.shade} />
      <path d="M140 94c14 0 20 10 18 22-2 10-10 16-20 18" fill="none" stroke={c.shade} strokeWidth="8" />
      <ellipse cx="100" cy="114" rx="44" ry="36" fill={c.body} />
      <rect x="84" y="74" width="32" height="8" rx="4" fill={c.shade} />
      <circle cx="100" cy="70" r="6" fill={c.shade} />
    </>
  ),
  glass: (c) => (
    <>
      {[66, 104].map((x) => (
        <g key={x}>
          <path d={`M${x} 70h32l-4 80h-24z`} fill={c.light} />
          {[0, 8, 16, 24].map((d) => (
            <path key={d} d={`M${x + 4 + d} 74v72`} stroke={c.body} strokeWidth="2" opacity=".6" />
          ))}
        </g>
      ))}
    </>
  ),
  napkin: (c) => (
    <>
      <rect x="56" y="112" width="88" height="38" rx="4" fill={c.shade} />
      <rect x="56" y="96" width="88" height="20" rx="4" fill={c.body} />
      <rect x="56" y="80" width="88" height="20" rx="4" fill={c.light} />
      <path d="M70 86h60" stroke={c.body} strokeWidth="2" opacity=".6" />
    </>
  ),
  planter: (c) => (
    <>
      <path d="M100 96c-4-24 4-40 22-48-2 20-8 34-22 48zM100 96c-12-18-30-22-44-16 10 14 24 20 44 16z" fill="#6f8f5a" />
      <path d="M100 96c10-14 24-20 38-18-8 12-20 18-38 18z" fill="#86a76f" />
      <path d="M68 96h64l-8 54H76z" fill={c.body} />
      <rect x="64" y="92" width="72" height="12" rx="3" fill={c.shade} />
    </>
  ),
};

export function ProductArt({ art, tint, className }: { art: string; tint: string; className?: string }) {
  const colors = tints[tint as Tint] ?? tints.sand;
  const draw = drawings[art] ?? drawings.mug;
  return (
    // slice: fill non-square tiles like object-fit: cover, trimming backdrop
    // rather than leaving bars. The object sits well inside the crop.
    <svg
      viewBox="0 0 200 200"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      className={cn("block size-full", className)}
    >
      <rect width="200" height="200" fill={colors.bg} />
      <ellipse cx="100" cy="152" rx="56" ry="7" fill="#000" opacity=".06" />
      {draw(colors)}
    </svg>
  );
}
