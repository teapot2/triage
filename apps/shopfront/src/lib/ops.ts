import { pool } from "@/db/client";
import { heldFor, STUCK_AFTER_MS } from "@/db/pool-watch";
import { flagStates, type FeatureFlag } from "@/lib/flags";
import { currentRelease, releases } from "@/lib/releases";
import { trafficSnapshot } from "@/lib/traffic";

// The demo controls are for local runs and demos. In a production build they
// are off unless OPS_ENABLED=1, so a deployed store doesn't ship a "break
// the database" button.
export const opsEnabled = () => process.env.NODE_ENV !== "production" || process.env.OPS_ENABLED === "1";

// What each flag does to the store, for whoever runs the demo. It lives here
// with the other demo controls, not in lib/flags.ts: the store's own code
// reads like any team's, so Triage, which reads that code, has to find the
// bug the way it would in a real app. Triage can't read this file.
// `effect` is what the operator will see; `description` is how it happens.
const faults: Record<FeatureFlag, { label: string; effect: string; description: string }> = {
  FF_STOCK_DIRECT_QUERY: {
    label: "Connection pool leak",
    effect:
      "About ten views of the Cast Iron Teapot fill the pool. After that every database-backed page waits 3 s and fails.",
    description:
      "getStockLevel switches to a direct query that keeps its pooled connection when a product has no stock row. " +
      "About ten views of such a product use up the pool, then every database-backed page times out after 3 s.",
  },
  FF_LIST_PRICES: {
    label: "Price list gap",
    effect:
      "The product API answers 500 for four products: the Cast Iron Teapot and the three new arrivals. Everything else stays up.",
    description:
      "Product pages, the product API and the cart read prices from product_prices, which syncListPrices fills with an " +
      "inner join on stock_levels. The Cast Iron Teapot and the three new arrivals have no stock row, so no price row, " +
      "and every view of them fails with a 500 (TypeError). Turning it off stops the errors at once.",
  },
  FF_LIVE_RATINGS: {
    label: "Live ratings loop",
    effect:
      "Listings and GET /api/products slow from about 20 ms to about a second. No errors, and the pool stays nearly empty.",
    description:
      "Listings and GET /api/products work out each product's rating with one query per product that fetches every one " +
      "of its review rows (REVIEWS_PER_PRODUCT in the seed), then average them in JavaScript. GET /api/products goes from " +
      "about 20 ms to about a second (0.6 to 3.4 s), with no errors and the pool far from full, and the API latency rule opens an " +
      "incident. Turning it off recovers at once.",
  },
};

// What each release does to the store, keyed by the patch's name in
// releases/. Same split as the flags: `effect` is what the operator will
// see, `description` is how it happens. A release without an entry here
// still deploys; it just shows no effect.
const releaseFaults: Partial<Record<string, { label: string; effect: string; description: string }>> = {
  "formatted-price": {
    label: "Formatted price",
    effect:
      "Every GET /api/products/[id] answers 500 within a second of the deploy. Product pages, listings and the pool are unaffected.",
    description:
      "The commit adds formatPrice (src/lib/money.ts), which formats cents with Intl.NumberFormat in the currency named " +
      "by STORE_CURRENCY, and has GET /api/products/[id] return `price` next to priceCents. Nobody set STORE_CURRENCY, so " +
      "the currency is undefined and the constructor throws TypeError: Currency code is required with currency style on " +
      "every call. The fix is a rollback, or a default currency. Rolling back stops the errors at once.",
  },
  "journal-copy": {
    label: "Journal copy",
    effect:
      "Nothing. One sentence on the journal page changes. Deploy it, then raise the traffic rate, and the question is whether Triage blames the release for the slowdown.",
    description:
      "The commit rewrites the journal page's intro line and touches nothing else: no query, no API route, no shared module. " +
      "Latency that climbs after it comes from the traffic, not the code, so the right answer is no rollback. A control for " +
      "the deploy fault: the same deploy record in the window, with nothing behind it.",
  },
  "vulnerable-dep": {
    label: "Vulnerable dependency",
    effect:
      "Nothing on the dashboards. /api/health gains a runtime field, and the next dependency audit finds a high advisory: Triage opens a sev3 incident on its own.",
    description:
      "The commit adds semver 7.5.1 as a runtime dependency (src/lib/runtime.ts checks the Node version against the engines " +
      "range for /api/health) and installs it. semver below 7.5.2 has a high ReDoS advisory, GHSA-c2qf-rxjj-qqgw, in its range " +
      "parsing. No traffic or latency changes: only Triage's audit of Shopfront's dependencies sees it (Audit now on its Watch " +
      "page, or the next scheduled audit). The fix is a bump to 7.5.2; rolling back removes the package.",
  },
};

// Everything /ops shows. No database query: it has to answer while the pool
// is jammed. The releases come from git the first time and are then kept in
// memory until a deploy or rollback.
export async function opsState() {
  const held = heldFor();
  return {
    flags: flagStates().map((f) => ({ ...f, ...faults[f.name] })),
    release: currentRelease(),
    releases: (await releases()).map((r) => ({ ...r, label: r.name, effect: "", description: "", ...releaseFaults[r.name] })),
    pool: {
      max: pool.options.max ?? 10,
      checkedOut: pool.totalCount - pool.idleCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
      held,
      stuck: held.filter((ms) => ms >= STUCK_AFTER_MS).length,
      stuckAfterMs: STUCK_AFTER_MS,
    },
    traffic: trafficSnapshot(),
  };
}

export type OpsState = Awaited<ReturnType<typeof opsState>>;
