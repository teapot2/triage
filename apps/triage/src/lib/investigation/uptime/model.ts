import { z } from "zod";

// The uptime check model: a public URL Triage polls itself, what each poll
// recorded, and the two fixed rules (Slow, Down) in words. No server
// imports, so the endpoint form can use it too; saving checks is checks.ts,
// their results samples.ts.

export const MAX_CHECKS = 5;

export const checkIdPattern = /^chk_[a-z0-9]{6}$/;

// "chk_" and 6 base36 characters. getRandomValues works in the browser and
// on the server, so the form can mint one before it saves.
export function newCheckId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `chk_${Array.from(bytes, (b) => (b % 36).toString(36)).join("")}`;
}

// Why a URL can't be a check's target, from its text alone; guard.ts adds
// the address checks, which need DNS.
export function urlProblem(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "not a valid URL";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "only http and https URLs can be checked";
  if (u.username || u.password) return "the URL can't carry a user name or password";
  return undefined;
}

const statusCode = z.number().int().min(100).max(599);

// A header the request carries, for an endpoint behind a token: its name
// (Authorization, or an API-key header) and its value, a secret. The value
// never reaches the browser: the routes send a check with the name alone
// (publicCheck), and a save that comes back without the value keeps the one
// saved for that check (withSavedSecrets). On the server it's always there.
export const DEFAULT_AUTH_HEADER = "Authorization";

export const authSchema = z.object({
  header: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, "a header name: letters, digits and - only"),
  value: z
    .string()
    .min(1)
    .max(4000)
    .refine((v) => !/[\r\n\0]/.test(v), "the value can't contain line breaks")
    .optional(),
});
export type CheckAuth = z.infer<typeof authSchema>;

export const checkSchema = z
  .object({
    id: z.string().regex(checkIdPattern, "chk_ and 6 lowercase letters or digits"),
    name: z.string().trim().min(1).max(80),
    url: z
      .string()
      .trim()
      .max(2000)
      .superRefine((url, ctx) => {
        const problem = urlProblem(url);
        if (problem) ctx.addIssue({ code: "custom", message: problem });
      }),
    enabled: z.boolean(),
    intervalSeconds: z.number().int().min(10).max(300),
    timeoutMs: z.number().int().min(1000).max(30_000),
    // A response in range but slower than this is slow, not ok.
    slowMs: z.number().int().min(100),
    expectedStatus: z.object({ min: statusCode, max: statusCode }),
    auth: authSchema.optional(),
    // Slow responses in a row before Slow opens an incident.
    slowChecksToOpen: z.number().int().min(1).max(10),
    // Minutes with no acceptable response before Down opens one.
    downMinutesToOpen: z.number().int().min(1).max(30),
    // Ok responses in a row that confirm a recovery; one could be luck.
    healthyChecksToRecover: z.number().int().min(2).max(10),
  })
  .refine((c) => c.slowMs <= c.timeoutMs, { message: "the slow limit can't be past the timeout", path: ["slowMs"] })
  .refine((c) => c.expectedStatus.min <= c.expectedStatus.max, {
    message: "the lowest expected status can't be above the highest",
    path: ["expectedStatus"],
  });
export type UptimeCheck = z.infer<typeof checkSchema>;

export const checksSchema = z
  .array(checkSchema)
  .max(MAX_CHECKS, `at most ${MAX_CHECKS} checks`)
  .refine((checks) => new Set(checks.map((c) => c.id)).size === checks.length, "check ids must be unique");

// The check as the browser may see it: the header's name without its value.
export const publicCheck = (c: UptimeCheck): UptimeCheck => (c.auth ? { ...c, auth: { header: c.auth.header } } : c);

// The URL's origin, or the URL itself when it doesn't parse.
export const originOf = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
};

// The saved values back onto a list that came from the browser without them.
// A check whose header has no value keeps the value saved for it, as long as
// the check still targets the same origin: a token meant for one host must
// not follow the check to another. The reason, naming the check, when a
// value is missing and nothing saved can stand in.
export function withSavedSecrets(next: UptimeCheck[], saved: UptimeCheck[]): { checks?: UptimeCheck[]; problem?: string } {
  const checks: UptimeCheck[] = [];
  for (const c of next) {
    if (!c.auth || c.auth.value) {
      checks.push(c);
      continue;
    }
    const was = saved.find((s) => s.id === c.id);
    const value = was?.auth?.value;
    if (!was || !value) return { problem: `${c.name}: enter the ${c.auth.header} header's value` };
    if (originOf(was.url) !== originOf(c.url)) {
      return { problem: `${c.name}: the ${c.auth.header} value saved was for ${checkHost(was)}; enter the one for ${checkHost(c)}` };
    }
    checks.push({ ...c, auth: { header: c.auth.header, value } });
  }
  return { checks };
}

export const outcomes = ["ok", "slow", "down"] as const;
export type UptimeOutcome = (typeof outcomes)[number];

export const sampleSchema = z.object({
  at: z.iso.datetime(),
  // Start to response headers; a timeout's is the timeout.
  ms: z.number().int().min(0),
  // The final response's status, after redirects; none when nothing answered.
  status: statusCode.optional(),
  // ok: status in range within slowMs; slow: in range past it; down: anything
  // else (timeout, connection or DNS failure, bad status, refused redirect).
  outcome: z.enum(outcomes),
  error: z.string().max(500).optional(),
});
export type UptimeSample = z.infer<typeof sampleSchema>;

export const checkDefaults = {
  enabled: true,
  intervalSeconds: 30,
  timeoutMs: 15_000,
  slowMs: 10_000,
  expectedStatus: { min: 200, max: 299 },
  slowChecksToOpen: 3,
  downMinutesToOpen: 5,
  healthyChecksToRecover: 3,
} satisfies Omit<UptimeCheck, "id" | "name" | "url">;

// A new check for the form to fill in: the defaults, a fresh id, and an
// empty name and URL until someone types them.
export function defaultCheck(init: Partial<UptimeCheck> = {}): UptimeCheck {
  return { id: newCheckId(), name: "", url: "", ...structuredClone(checkDefaults), ...init };
}

// --- rules -------------------------------------------------------------------

export const uptimeRules = ["slow", "down"] as const;
export type UptimeRule = (typeof uptimeRules)[number];

// The id an incident's trigger carries, which reopening is keyed on.
export const ruleId = (check: UptimeCheck, rule: UptimeRule) => `uptime:${check.id}:${rule}`;

export function parseRuleId(id: string): { checkId: string; rule: UptimeRule } | undefined {
  const m = /^uptime:(chk_[a-z0-9]{6}):(slow|down)$/.exec(id);
  return m ? { checkId: m[1], rule: m[2] as UptimeRule } : undefined;
}

// Down is an outage; slow still answers.
export const ruleSeverity = (rule: UptimeRule) => (rule === "down" ? "sev2" : "sev3");

export const ruleName = (rule: UptimeRule) => (rule === "down" ? "Down" : "Slow");

// --- words -------------------------------------------------------------------

// 184 → "184 ms", 10000 → "10 s", 1500 → "1.5 s".
export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${Math.round(ms / 100) / 10} s`;
}

// The host a check targets, port included, for titles; the URL itself when
// it doesn't parse.
export function checkHost(check: Pick<UptimeCheck, "url">): string {
  try {
    return new URL(check.url).host;
  } catch {
    return check.url;
  }
}

const statusRange = ({ min, max }: UptimeCheck["expectedStatus"]) => (min === max ? `${min}` : `${min}–${max}`);

const article = (word: string) => (/^[aeiou]/i.test(word) ? "an" : "a");

// " with an Authorization header", or nothing.
const withHeader = (c: Pick<UptimeCheck, "auth">) => (c.auth ? ` with ${article(c.auth.header)} ${c.auth.header} header` : "");

// "Every 30 s, GET https://www.google.com and expect 200–299 within 10 s
// (gives up after 15 s)": the check in a line, for its page and tooltip.
export const describeCheck = (c: UptimeCheck) =>
  `Every ${c.intervalSeconds} s, GET ${c.url}${withHeader(c)} and expect ${statusRange(c.expectedStatus)} within ${duration(c.slowMs)} (gives up after ${duration(c.timeoutMs)})`;

// The rule in a line, written for the slot Slack and the investigation print
// it in: "3 checks in a row slower than 10 s on https://www.google.com".
export function ruleDescription(check: UptimeCheck, rule: UptimeRule): string {
  if (rule === "down") return `no acceptable response for ${check.downMinutesToOpen} min from ${check.url}`;
  const n = check.slowChecksToOpen;
  const checks = n === 1 ? "1 check" : `${n} checks in a row`;
  return `${checks} slower than ${duration(check.slowMs)} on ${check.url}`;
}

// The status every result of a failing run answered with, when they all
// answered with the same one; none when any didn't answer or they differ.
export function runStatus(run: UptimeSample[]): number | undefined {
  const status = run[0]?.status;
  return status !== undefined && run.every((s) => s.status === status) ? status : undefined;
}

// "Slow responses from www.google.com", "www.google.com is not responding".
// A Down run that was answered, every time, with 401 or 403 is the endpoint
// turning the check away, not an outage, and the title says so.
export function incidentTitle(check: UptimeCheck, rule: UptimeRule, status?: number): string {
  if (rule !== "down") return `Slow responses from ${checkHost(check)}`;
  if (status === 401 || status === 403) return `${checkHost(check)} is rejecting the check's credentials`;
  return `${checkHost(check)} is not responding`;
}
