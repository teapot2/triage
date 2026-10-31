// What synthetic traffic looks like, as numbers /ops can edit: how much, who
// visits, how shoppers behave, and how messy the requests are. Shared by the
// traffic generator and the /ops page, which builds its controls from
// `profileFields`. Every value is clamped to its field's range, so a bad
// request can't make the generator misbehave.

export type ProfileKey =
  | "rps"
  | "drift"
  | "rushesPerHour"
  | "shoppers"
  | "readers"
  | "app"
  | "crawlers"
  | "productsMin"
  | "productsMax"
  | "searchPct"
  | "cartPct"
  | "pace"
  | "stalePct"
  | "malformedPct"
  | "oversizedPct"
  | "abortPct";

export type Profile = Record<ProfileKey, number>;

export type ProfileField = {
  key: ProfileKey;
  group: "Rate" | "Visitors" | "Shoppers" | "Bad requests";
  label: string;
  help: string;
  min: number;
  max: number;
  step: number;
  unit?: string;
};

export const profileFields: ProfileField[] = [
  { key: "rps", group: "Rate", label: "Average rate", unit: "req/s", min: 0.5, max: 20, step: 0.5, help: "Requests a second across all visitors. The dev server slows down past about 4." },
  { key: "drift", group: "Rate", label: "Drift", unit: "%", min: 0, max: 80, step: 5, help: "How far the rate swings above and below the average over a ten-minute cycle." },
  { key: "rushesPerHour", group: "Rate", label: "Rushes", unit: "an hour", min: 0, max: 30, step: 1, help: "Bursts of 1.5 to 2.5 times the visitors, 15 to 45 s each." },

  { key: "shoppers", group: "Visitors", label: "Shoppers", min: 0, max: 100, step: 5, help: "Land on the home page, a category or a search, open products, sometimes the cart." },
  { key: "readers", group: "Visitors", label: "Readers", min: 0, max: 100, step: 5, help: "Read the help and company pages: shipping, returns, care, contact, makers, journal, wholesale." },
  { key: "app", group: "Visitors", label: "Mobile app", min: 0, max: 100, step: 5, help: "The product list and a few products from the JSON API, the route the latency alert watches." },
  { key: "crawlers", group: "Visitors", label: "Crawlers", min: 0, max: 100, step: 5, help: "Search engines: robots.txt, then a quick walk through categories, products and pages." },

  { key: "productsMin", group: "Shoppers", label: "Fewest products", min: 1, max: 10, step: 1, help: "Products a shopper opens, at least." },
  { key: "productsMax", group: "Shoppers", label: "Most products", min: 1, max: 10, step: 1, help: "Products a shopper opens, at most." },
  { key: "searchPct", group: "Shoppers", label: "Search", unit: "%", min: 0, max: 100, step: 5, help: "Shoppers who search before browsing." },
  { key: "cartPct", group: "Shoppers", label: "Open the cart", unit: "%", min: 0, max: 100, step: 5, help: "Shoppers who look at their cart before leaving." },
  { key: "pace", group: "Shoppers", label: "Pause between pages", unit: "×", min: 0.25, max: 4, step: 0.25, help: "Scales every visitor's reading time: below 1 is hurried, above 1 is leisurely." },

  { key: "stalePct", group: "Bad requests", label: "Stale links", unit: "%", min: 0, max: 30, step: 0.5, help: "Product links to an id that doesn't exist: 404 from the API." },
  { key: "malformedPct", group: "Bad requests", label: "Mangled ids", unit: "%", min: 0, max: 30, step: 0.5, help: "Ids like \"undefined\" or \"12abc\": 400 from the API." },
  { key: "oversizedPct", group: "Bad requests", label: "Oversized ids", unit: "%", min: 0, max: 30, step: 0.5, help: "Ids past the database's integer range. The API answers 500: real server errors on the watched route." },
  { key: "abortPct", group: "Bad requests", label: "Abandoned requests", unit: "%", min: 0, max: 30, step: 0.5, help: "Visitors who give up on a request within half a second, as on a bad connection." },
];

export const presets: { name: string; description: string; profile: Profile }[] = [
  {
    name: "Normal day",
    description: "Steady browsing with a little noise.",
    profile: {
      rps: 2, drift: 30, rushesPerHour: 8,
      shoppers: 50, readers: 10, app: 30, crawlers: 10,
      productsMin: 1, productsMax: 4, searchPct: 15, cartPct: 20, pace: 1,
      stalePct: 0.8, malformedPct: 0.3, oversizedPct: 0, abortPct: 0.5,
    },
  },
  {
    name: "Quiet night",
    description: "A trickle of visitors, mostly crawlers.",
    profile: {
      rps: 0.5, drift: 10, rushesPerHour: 0,
      shoppers: 30, readers: 10, app: 20, crawlers: 40,
      productsMin: 1, productsMax: 3, searchPct: 10, cartPct: 10, pace: 1.5,
      stalePct: 1, malformedPct: 0.3, oversizedPct: 0, abortPct: 0.5,
    },
  },
  {
    name: "Sale",
    description: "Busy, hurried shoppers and frequent rushes.",
    profile: {
      rps: 4, drift: 40, rushesPerHour: 20,
      shoppers: 65, readers: 10, app: 20, crawlers: 5,
      productsMin: 2, productsMax: 6, searchPct: 25, cartPct: 50, pace: 0.6,
      stalePct: 0.8, malformedPct: 0.3, oversizedPct: 0, abortPct: 1,
    },
  },
  {
    name: "Help desk",
    description: "Visitors reading shipping, returns and contact pages.",
    profile: {
      rps: 2, drift: 20, rushesPerHour: 4,
      shoppers: 25, readers: 55, app: 15, crawlers: 5,
      productsMin: 1, productsMax: 2, searchPct: 10, cartPct: 30, pace: 1.25,
      stalePct: 0.5, malformedPct: 0.2, oversizedPct: 0, abortPct: 0.5,
    },
  },
  {
    name: "Crawler storm",
    description: "Search engines hammering the catalog.",
    profile: {
      rps: 4, drift: 10, rushesPerHour: 10,
      shoppers: 15, readers: 5, app: 10, crawlers: 70,
      productsMin: 1, productsMax: 3, searchPct: 10, cartPct: 10, pace: 1,
      stalePct: 4, malformedPct: 0.5, oversizedPct: 0, abortPct: 0.5,
    },
  },
  {
    name: "Messy clients",
    description: "Lots of 404s and 400s, some 500s, abandoned requests.",
    profile: {
      rps: 2, drift: 30, rushesPerHour: 8,
      shoppers: 40, readers: 10, app: 40, crawlers: 10,
      productsMin: 1, productsMax: 4, searchPct: 15, cartPct: 20, pace: 1,
      stalePct: 6, malformedPct: 4, oversizedPct: 2, abortPct: 5,
    },
  },
];

export const defaultProfile: Profile = presets[0].profile;

// A full, valid profile from anything: missing or non-numeric values keep
// the current one, numbers are clamped and snapped to their field's step,
// and the fewest products never exceeds the most.
export function normalizeProfile(input: unknown, base: Profile = defaultProfile): Profile {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const out = { ...base };
  for (const f of profileFields) {
    const v = raw[f.key];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const snapped = Math.round(v / f.step) * f.step;
    out[f.key] = Math.min(f.max, Math.max(f.min, Number(snapped.toFixed(2))));
  }
  if (out.productsMin > out.productsMax) out.productsMax = out.productsMin;
  // Nobody visiting is no traffic: fall back to shoppers.
  if (out.shoppers + out.readers + out.app + out.crawlers === 0) out.shoppers = 100;
  return out;
}
