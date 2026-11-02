import { context, ROOT_CONTEXT } from "@opentelemetry/api";
import { infoSections } from "@/lib/info-pages";
import { defaultProfile, normalizeProfile, type Profile } from "@/lib/traffic-profile";

// Synthetic visitors for the demo: real HTTP requests to the store, sent from
// the server (a timer on globalThis) so they keep going with no browser open,
// and shaped like customer traffic so the telemetry has a normal baseline.
// What they do is set by a profile (src/lib/traffic-profile.ts) that /ops
// edits while traffic runs.
//
// Traffic comes in visits, not single requests, from four kinds of visitor:
// shoppers land on the home page, a category or a search, open products and
// sometimes their cart; readers go through the help and company pages; the
// mobile app reads the product API, the route Triage's latency alert
// watches; crawlers walk everything quickly. Popular products (more reviews)
// get more views. Some requests go wrong the way real ones do: stale links
// (404), mangled ids (400), ids past the database's integer range (a real
// 500 from the API) and visitors who give up on a request. The rate drifts
// over a ten-minute cycle, with the odd rush, around the profile's average.
// Cart changes are server actions, which need a browser: scripts/shoppers.ts
// drives those.

const HISTORY_SECONDS = 60;
const REQUEST_TIMEOUT_MS = 10_000;
// A load balancer checks a store behind it around the clock.
const HEALTH_PROBE_MS = 10_000;
// Past this many unanswered requests, or visits under way, new visitors
// stay away instead of piling on.
const MAX_IN_FLIGHT = 60;
const MAX_VISITS = 400;
const CYCLE_MS = 10 * 60_000;
// The first id the products table's integer column can't hold.
const PAST_INT_RANGE = 2 ** 31;

export type CatalogItem = { id: number; name: string; category: string; reviewCount: number };

type Step = { path: string; route: string; pauseMs: number; json?: boolean };
type Visit = { userAgent: string; steps: Step[] };
type RouteCount = { requests: number; clientErrors: number; errors: number; aborted: number };
type Second = {
  at: number;
  ok: number;
  clientErrors: number;
  errors: number;
  aborted: number;
  durations: number[];
  routes: Record<string, RouteCount>;
};
type Traffic = {
  profile: Profile;
  timer: ReturnType<typeof setTimeout> | null;
  probe: ReturnType<typeof setInterval> | null;
  // Bumped on every start and stop, so visits from an earlier run stop
  // after their current request.
  run: number;
  origin: string;
  catalog: CatalogItem[];
  stepsPerVisit: number;
  rushUntil: number;
  rushFactor: number;
  visits: number;
  inFlight: number;
  seconds: Second[];
};

const initial: Traffic = {
  profile: defaultProfile,
  timer: null,
  probe: null,
  run: 0,
  origin: "",
  catalog: [],
  stepsPerVisit: 1,
  rushUntil: 0,
  rushFactor: 1,
  visits: 0,
  inFlight: 0,
  seconds: [],
};

// On globalThis so dev hot reloads keep one set of visitors. Fields the
// object from before a reload lacks start from their defaults.
const globalForTraffic = globalThis as unknown as { shopfrontTraffic?: Traffic };
const existing = globalForTraffic.shopfrontTraffic;
const state: Traffic = (globalForTraffic.shopfrontTraffic = Object.assign(existing ?? {}, { ...initial, ...existing }));
// Seconds counted by an older version have a different shape.
state.seconds = state.seconds.filter((s) => s.routes);

const nowSecond = () => Math.floor(Date.now() / 1000);

type Outcome = "ok" | "clientError" | "error" | "aborted";

// Every request counts toward the rate and its route; latency is the product
// API's only, the route Triage's alert watches, so slow page renders in dev
// don't read as a slow store.
function record(route: string, outcome: Outcome, durationMs: number, timed: boolean) {
  const at = nowSecond();
  let second = state.seconds.at(-1);
  if (!second || second.at !== at) {
    second = { at, ok: 0, clientErrors: 0, errors: 0, aborted: 0, durations: [], routes: {} };
    state.seconds.push(second);
    while (state.seconds.length > HISTORY_SECONDS) state.seconds.shift();
  }
  const r = (second.routes[route] ??= { requests: 0, clientErrors: 0, errors: 0, aborted: 0 });
  r.requests++;
  if (outcome === "ok") second.ok++;
  if (outcome === "clientError") {
    second.clientErrors++;
    r.clientErrors++;
  }
  if (outcome === "error") {
    second.errors++;
    r.errors++;
  }
  if (outcome === "aborted") {
    second.aborted++;
    r.aborted++;
  }
  if (timed && outcome !== "aborted") second.durations.push(durationMs);
}

// --- Picking at random -----------------------------------------------------

const chance = (pct: number) => Math.random() * 100 < pct;
const between = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));
const oneOf = <T>(items: readonly T[]) => items[Math.floor(Math.random() * items.length)];
// Mostly short pauses, now and then a long read: log-uniform between the two,
// scaled by the profile's pace.
const pause = (minS: number, maxS: number) =>
  Math.round(1000 * state.profile.pace * minS * (maxS / minS) ** Math.random());

function weighted<T>(items: readonly T[], weight: (item: T) => number): T {
  let left = Math.random() * items.reduce((sum, i) => sum + weight(i), 0);
  for (const item of items) {
    left -= weight(item);
    if (left < 0) return item;
  }
  return items[items.length - 1];
}

// A product to view, popular ones more often. Within a visit people often
// stay in the category they're browsing.
function pickProduct(category?: string): CatalogItem {
  const pool = category && chance(40) ? state.catalog.filter((p) => p.category === category) : state.catalog;
  return weighted(pool.length ? pool : state.catalog, (p) => p.reviewCount + 30);
}

// A product's page or API path, or, as often as the profile says, one that
// goes wrong: a product that was taken down, an id mangled on the way, or
// one too large for the database.
function productStep(api: boolean, product: CatalogItem, pauseMs: number, label?: string): Step {
  const { stalePct, malformedPct, oversizedPct } = state.profile;
  const prefix = api ? "/api/products/" : "/products/";
  const route = label ?? (api ? "API: product" : "Product page");
  let id = String(product.id);
  if (chance(oversizedPct)) id = String(PAST_INT_RANGE + between(0, 1_000_000));
  else if (chance(malformedPct)) id = oneOf(["undefined", "null", `${product.id}abc`, `${product.id}%20`]);
  else if (chance(stalePct)) id = String(Math.max(...state.catalog.map((p) => p.id)) + between(1, 500));
  return { path: prefix + id, route, pauseMs, json: api };
}

const categoryStep = (category: string, pauseMs: number): Step => ({
  path: `/?category=${encodeURIComponent(category)}`,
  route: "Category",
  pauseMs,
});

// Help and company pages, the common questions more often.
const pageWeights: Record<string, number> = {
  "/shipping": 25,
  "/returns": 20,
  "/care": 15,
  "/contact": 15,
  "/makers": 10,
  "/journal": 10,
  "/wholesale": 5,
};
const infoLinks: { label: string; href: string }[] = infoSections.flatMap((s) => [...s.links]);
const infoStep = (pauseMs: number): Step => {
  const link = weighted(infoLinks, (l) => pageWeights[l.href] ?? 5);
  return { path: link.href, route: link.label, pauseMs };
};

const browsers = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0",
];
const apps = ["FernhillGoods/3.4.1 (iPhone; iOS 19.0)", "FernhillGoods/3.4.0 (Android 15; Pixel 8)"];
const crawlers = [
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
];
const searchMisses = ["kettle", "napkin rings", "teaspoons", "rug"];

function searchTerm() {
  if (chance(20)) return oneOf(searchMisses);
  const words = oneOf(state.catalog).name.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4);
  return words.length ? oneOf(words) : "mug";
}

// --- Visits ----------------------------------------------------------------

// Someone browsing the store: a landing page, maybe a search, a few
// products, now and then a question about shipping, sometimes the cart.
function shopperVisit(): Visit {
  const { productsMin, productsMax, searchPct, cartPct } = state.profile;
  const steps: Step[] = [];
  let category: string | undefined;
  if (chance(20)) {
    category = oneOf(state.catalog).category;
    steps.push(categoryStep(category, 0));
  } else {
    steps.push({ path: "/", route: "Home", pauseMs: 0 });
  }
  if (chance(searchPct)) {
    steps.push({ path: `/?q=${encodeURIComponent(searchTerm())}`, route: "Search", pauseMs: pause(3, 12) });
  }
  for (let i = between(productsMin, productsMax); i > 0; i--) {
    const product = pickProduct(category);
    category = product.category;
    steps.push(productStep(false, product, pause(2, 20)));
  }
  if (chance(10)) steps.push(infoStep(pause(2, 10)));
  if (chance(cartPct)) steps.push({ path: "/cart", route: "Cart", pauseMs: pause(2, 10) });
  return { userAgent: oneOf(browsers), steps };
}

// Someone with a question: in from the home page, a product or a search
// result, through a page or three, sometimes back to a product.
function readerVisit(): Visit {
  const landing = Math.random();
  const steps: Step[] =
    landing < 0.5
      ? [{ path: "/", route: "Home", pauseMs: 0 }]
      : landing < 0.8
        ? [productStep(false, pickProduct(), 0)]
        : [];
  for (let i = between(1, 3); i > 0; i--) steps.push(infoStep(steps.length ? pause(3, 25) : 0));
  if (chance(30)) steps.push(productStep(false, pickProduct(), pause(2, 10)));
  return { userAgent: oneOf(browsers), steps };
}

// The mobile app: the product list, then a few products from the API.
function appVisit(): Visit {
  const steps: Step[] = [{ path: "/api/products", route: "API: product list", pauseMs: 0, json: true }];
  for (let i = between(1, 3); i > 0; i--) steps.push(productStep(true, pickProduct(), pause(1, 8)));
  return { userAgent: oneOf(apps), steps };
}

// A search engine: robots.txt (the store has none), then a quick walk
// through categories, products and pages.
function crawlerVisit(): Visit {
  const steps: Step[] = [{ path: "/robots.txt", route: "robots.txt", pauseMs: 0 }];
  for (let i = between(3, 6); i > 0; i--) {
    const kind = Math.random();
    const gap = pause(0.5, 2);
    steps.push(
      kind < 0.2
        ? categoryStep(oneOf(state.catalog).category, gap)
        : kind < 0.4
          ? infoStep(gap)
          : productStep(false, oneOf(state.catalog), gap),
    );
  }
  return { userAgent: oneOf(crawlers), steps };
}

function planVisit(): Visit {
  const { shoppers, readers, app, crawlers: bots } = state.profile;
  const kinds: [number, () => Visit][] = [
    [shoppers, shopperVisit],
    [readers, readerVisit],
    [app, appVisit],
    [bots, crawlerVisit],
  ];
  return weighted(kinds, ([w]) => w)[1]();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(step: Step, userAgent: string) {
  state.inFlight++;
  const timed = step.route === "API: product";
  // A visitor who gives up does so within half a second.
  const abandon = chance(state.profile.abortPct);
  const started = performance.now();
  try {
    const res = await fetch(state.origin + step.path, {
      headers: { "user-agent": userAgent, accept: step.json ? "application/json" : "text/html" },
      cache: "no-store",
      signal: AbortSignal.timeout(abandon ? between(50, 500) : REQUEST_TIMEOUT_MS),
    });
    await res.arrayBuffer();
    // Only 5xx count as errors, as in Triage's own error rate.
    const outcome = res.status >= 500 ? "error" : res.status >= 400 ? "clientError" : "ok";
    record(step.route, outcome, performance.now() - started, timed);
  } catch {
    record(step.route, abandon ? "aborted" : "error", performance.now() - started, timed);
  } finally {
    state.inFlight--;
  }
}

// The health check a load balancer sends. Not counted with the visits: it
// isn't a customer. A failed probe is the store's to log, not the checker's.
async function probeHealth() {
  try {
    const res = await fetch(`${state.origin}/api/health`, {
      headers: { "user-agent": "ELB-HealthChecker/2.0" },
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    await res.arrayBuffer();
  } catch {
    // nothing to record
  }
}

async function visit(run: number) {
  const { userAgent, steps } = planVisit();
  state.visits++;
  try {
    for (const step of steps) {
      if (step.pauseMs) await sleep(step.pauseMs);
      if (state.run !== run) return;
      await request(step, userAgent);
    }
  } finally {
    state.visits--;
  }
}

// Visitors a second right now: the average, raised or lowered by the slow
// cycle and any rush under way.
function arrivalRate(now: number) {
  const { rps, drift } = state.profile;
  const cycle = 1 + (drift / 100) * Math.sin((2 * Math.PI * now) / CYCLE_MS);
  return (rps / state.stepsPerVisit) * cycle * (now < state.rushUntil ? state.rushFactor : 1);
}

// Visitors arrive independently (a Poisson process), so gaps vary the way
// real arrivals do. Each visit starts its own trace, like a real visitor's:
// without the root context, every request would land in the trace of the
// /api/ops request that started traffic.
function scheduleNext(run: number) {
  const now = Date.now();
  const gapMs = -Math.log(1 - Math.random()) * (1000 / arrivalRate(now));
  const { rushesPerHour } = state.profile;
  if (rushesPerHour > 0 && now > state.rushUntil && Math.random() < (gapMs * rushesPerHour) / 3_600_000) {
    state.rushUntil = now + between(15, 45) * 1000;
    state.rushFactor = 1.5 + Math.random();
  }
  state.timer = setTimeout(() => {
    if (state.run !== run) return;
    if (state.inFlight < MAX_IN_FLIGHT && state.visits < MAX_VISITS) void context.with(ROOT_CONTEXT, () => visit(run));
    scheduleNext(run);
  }, gapMs);
}

// Requests per visit, on average, to turn the rate into visitors.
function measureVisits() {
  if (state.catalog.length === 0) return;
  const sample = Array.from({ length: 1000 }, planVisit);
  state.stepsPerVisit = sample.reduce((n, v) => n + v.steps.length, 0) / sample.length;
}

// Changes what traffic looks like, running or not; a running generator
// picks it up with the next visitor.
export function setProfile(input: unknown) {
  state.profile = normalizeProfile(input, state.profile);
  measureVisits();
  return state.profile;
}

// Starting and stopping aren't logged: a customer's app has no visitor
// generator, and a "synthetic traffic started" line in the logs Triage
// reads would give the demo away. The ops page shows the state instead.
export function startTraffic(origin: string, catalog: CatalogItem[]) {
  stopTraffic();
  state.origin = origin;
  state.catalog = catalog;
  measureVisits();
  scheduleNext(state.run);
  state.probe = setInterval(probeHealth, HEALTH_PROBE_MS);
  state.probe.unref();
}

export function stopTraffic() {
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  if (state.probe) clearInterval(state.probe);
  state.probe = null;
  state.run++;
  state.rushUntil = 0;
}

const p95 = (values: number[]) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]);
};

const sum = (seconds: Second[], key: "ok" | "clientErrors" | "errors" | "aborted") =>
  seconds.reduce((n, s) => n + s[key], 0);

// The last minute, one entry per second (gaps filled), per route, and the
// last 10 s summed up.
export function trafficSnapshot() {
  const now = nowSecond();
  const bySecond = new Map(state.seconds.map((s) => [s.at, s]));
  const timeline = Array.from({ length: HISTORY_SECONDS }, (_, i) => {
    const s = bySecond.get(now - HISTORY_SECONDS + 1 + i);
    return { ok: s ? s.ok + s.clientErrors + s.aborted : 0, errors: s?.errors ?? 0, p95: s ? p95(s.durations) : null };
  });

  const minute = state.seconds.filter((s) => s.at > now - HISTORY_SECONDS);
  const routes = new Map<string, RouteCount>();
  for (const s of minute) {
    for (const [route, c] of Object.entries(s.routes)) {
      const r = routes.get(route) ?? { requests: 0, clientErrors: 0, errors: 0, aborted: 0 };
      r.requests += c.requests;
      r.clientErrors += c.clientErrors;
      r.errors += c.errors;
      r.aborted += c.aborted;
      routes.set(route, r);
    }
  }

  const recent = minute.filter((s) => s.at > now - 10);
  const requests = sum(recent, "ok") + sum(recent, "clientErrors") + sum(recent, "errors") + sum(recent, "aborted");
  const ratio = (n: number) => (requests === 0 ? null : n / requests);
  return {
    running: state.timer !== null,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    profile: state.profile,
    visits: state.visits,
    rush: Date.now() < state.rushUntil,
    inFlight: state.inFlight,
    timeline,
    routes: [...routes].map(([route, c]) => ({ route, ...c })).sort((a, b) => b.requests - a.requests),
    last10s: {
      requests,
      errorRatio: ratio(sum(recent, "errors")),
      clientErrorRatio: ratio(sum(recent, "clientErrors")),
      abortedRatio: ratio(sum(recent, "aborted")),
      p95: p95(recent.flatMap((s) => s.durations)),
    },
  };
}
