import { z } from "zod";

// The watch rule model: what a rule is, the defaults, and how one reads in
// words. A rule over several routes judges each route on its own, so one
// slow route can't hide behind fast ones. No server imports, so Settings'
// rule editor can use it too; saving them is watch-rules.ts.

const ms = z.number().int().min(1).max(600_000);
const percent = z.number().min(0).max(100);

export const conditionSchema = z.discriminatedUnion("metric", [
  // p95 latency over a limit.
  z.object({ metric: z.literal("p95"), aboveMs: ms }),
  // More than N requests slower than a limit. Holds up at low traffic, where
  // one slow request moves a p95, and shrugs off a lone slow one (a dev
  // server compiling a page on its first visit).
  z.object({ metric: z.literal("slowCount"), slowerThanMs: ms, moreThan: z.number().int().min(0).max(100_000) }),
  // More than a share of requests slower than a limit; scales with traffic.
  z.object({ metric: z.literal("slowShare"), slowerThanMs: ms, moreThanPercent: percent }),
  // The share of requests that failed: a 5xx, or an error on the span.
  z.object({ metric: z.literal("errorRate"), moreThanPercent: percent }),
]);
export type WatchCondition = z.infer<typeof conditionSchema>;

export const targetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all") }),
  z.object({ kind: z.literal("api") }),
  z.object({ kind: z.literal("pages") }),
  // A route as Next names it (/api/products/[id]), or a pattern whose
  // trailing * matches the rest (/api/*).
  z.object({ kind: z.literal("route"), route: z.string().trim().regex(/^\//, "starts with /").max(200) }),
]);
export type WatchTarget = z.infer<typeof targetSchema>;

export const ruleSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "lowercase letters, digits and dashes"),
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean(),
  target: targetSchema,
  condition: conditionSchema,
  // The requests judged at each check: those in the last windowSeconds.
  windowSeconds: z.number().int().min(30).max(900),
  // Checks in a row over the limit before an incident opens; 2 rides out a
  // single blip.
  checksToOpen: z.number().int().min(1).max(10),
  // Fewer requests than this on a route and it isn't judged (p95, shares and
  // error rate mean little on two requests). Counting rules ignore it.
  minRequests: z.number().int().min(1).max(1000),
  severity: z.enum(["sev1", "sev2", "sev3", "sev4"]),
});
export type WatchRule = z.infer<typeof ruleSchema>;

// The kinds of target and condition by name, for the rule form's selects
// and the Watch list's filters.
export const targetOptions: { value: WatchTarget["kind"]; label: string }[] = [
  { value: "all", label: "Every route" },
  { value: "api", label: "API routes" },
  { value: "pages", label: "Pages" },
  { value: "route", label: "One route or pattern" },
];

export const metricOptions: { value: WatchCondition["metric"]; label: string }[] = [
  { value: "p95", label: "p95 latency" },
  { value: "slowCount", label: "Slow requests, counted" },
  { value: "slowShare", label: "Slow requests, as a share" },
  { value: "errorRate", label: "Error rate" },
];

export const rulesSchema = z
  .array(ruleSchema)
  .max(50)
  .refine((rules) => new Set(rules.map((r) => r.id)).size === rules.length, "rule ids must be unique");

// API latency is the check the watch always made, now on every API route;
// pages get a looser, count-based limit; errors are judged everywhere.
export const defaultRules: WatchRule[] = [
  {
    id: "api-latency",
    name: "API latency",
    enabled: true,
    target: { kind: "api" },
    condition: { metric: "p95", aboveMs: 500 },
    windowSeconds: 60,
    checksToOpen: 2,
    minRequests: 5,
    severity: "sev2",
  },
  {
    id: "page-latency",
    name: "Page latency",
    enabled: true,
    target: { kind: "pages" },
    condition: { metric: "slowCount", slowerThanMs: 1500, moreThan: 3 },
    windowSeconds: 60,
    checksToOpen: 2,
    minRequests: 1,
    severity: "sev3",
  },
  {
    id: "errors",
    name: "Server errors",
    enabled: true,
    target: { kind: "all" },
    condition: { metric: "errorRate", moreThanPercent: 5 },
    windowSeconds: 60,
    checksToOpen: 2,
    minRequests: 5,
    severity: "sev2",
  },
];

export function matchesTarget(target: WatchTarget, route: string): boolean {
  switch (target.kind) {
    case "all":
      return true;
    case "api":
      return route.startsWith("/api/");
    case "pages":
      return !route.startsWith("/api/");
    case "route":
      return target.route.endsWith("*") ? route.startsWith(target.route.slice(0, -1)) : route === target.route;
  }
}

// --- words -------------------------------------------------------------------

export const targetText = (t: WatchTarget) =>
  ({ all: "each route", api: "each API route", pages: "each page", route: t.kind === "route" ? t.route : "" })[t.kind];

export function conditionText(c: WatchCondition): string {
  switch (c.metric) {
    case "p95":
      return `p95 over ${c.aboveMs} ms`;
    case "slowCount":
      return `more than ${c.moreThan} ${c.moreThan === 1 ? "request" : "requests"} slower than ${c.slowerThanMs} ms`;
    case "slowShare":
      return `more than ${c.moreThanPercent}% of requests slower than ${c.slowerThanMs} ms`;
    case "errorRate":
      return `error rate over ${c.moreThanPercent}%`;
  }
}

// "p95 over 500 ms on each API route": the rule in a line, for the watch's
// tooltip and the investigation's prompt.
export const describeRule = (r: WatchRule) => `${conditionText(r.condition)} on ${targetText(r.target)}`;

// An incident's title when this rule trips on a route, e.g. "p95 latency
// above 500 ms on GET /api/products/[id]", the title the watch always used.
export function tripTitle(r: WatchRule, method: string, route: string): string {
  const where = `on ${method} ${route}`;
  const c = r.condition;
  switch (c.metric) {
    case "p95":
      return `p95 latency above ${c.aboveMs} ms ${where}`;
    case "slowCount":
      return `More than ${c.moreThan} ${c.moreThan === 1 ? "request" : "requests"} slower than ${c.slowerThanMs} ms ${where}`;
    case "slowShare":
      return `More than ${c.moreThanPercent}% of requests slower than ${c.slowerThanMs} ms ${where}`;
    case "errorRate":
      return `Error rate above ${c.moreThanPercent}% ${where}`;
  }
}

// The series an incident from this rule charts, and the limit drawn on it:
// the route's p95 against the latency limit, or its error ratio against the
// error limit.
export function tripMetric(r: WatchRule, route: string): { metric: string; threshold: number } {
  const c = r.condition;
  if (c.metric === "errorRate") return { metric: `http.server.error_ratio{route=${route}}`, threshold: c.moreThanPercent / 100 };
  return {
    metric: `http.server.request.duration.p95{route=${route}}`,
    threshold: c.metric === "p95" ? c.aboveMs : c.slowerThanMs,
  };
}
