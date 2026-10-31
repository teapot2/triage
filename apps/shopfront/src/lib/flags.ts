// Feature flags for gradual rollouts. Each starts from its env var ("1" or
// "true" turns it on) and can be flipped at runtime without a restart. Kept
// in memory, not the database, so a flag still answers when the database
// doesn't.

export const featureFlags = {
  FF_STOCK_DIRECT_QUERY: {
    label: "Direct stock query",
    description: "Read stock levels with a hand-written query on a pooled client instead of through Drizzle.",
  },
  FF_LIST_PRICES: {
    label: "List prices",
    description: "Serve prices on the product page, the product API and the cart from the price list instead of the catalog.",
  },
} as const;

export type FeatureFlag = keyof typeof featureFlags;

const fromEnv = (name: FeatureFlag) => ["1", "true"].includes((process.env[name] ?? "").toLowerCase());

// On globalThis so dev hot reloads keep what was switched at runtime.
const globalForFlags = globalThis as unknown as { shopfrontFlags?: Partial<Record<FeatureFlag, boolean>> };
const overrides = (globalForFlags.shopfrontFlags ??= {});

export const isEnabled = (name: FeatureFlag) => overrides[name] ?? fromEnv(name);

export function setFlag(name: FeatureFlag, on: boolean) {
  overrides[name] = on;
}

export const flagStates = () =>
  (Object.keys(featureFlags) as FeatureFlag[]).map((name) => ({ name, ...featureFlags[name], enabled: isEnabled(name) }));
