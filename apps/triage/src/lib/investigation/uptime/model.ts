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

// "Every 30 s, GET https://www.google.com and expect 200–299 within 10 s
// (gives up after 15 s)": the check in a line, for its page and tooltip.
export const describeCheck = (c: UptimeCheck) =>
  `Every ${c.intervalSeconds} s, GET ${c.url} and expect ${statusRange(c.expectedStatus)} within ${duration(c.slowMs)} (gives up after ${duration(c.timeoutMs)})`;

// The rule in a line, written for the slot Slack and the investigation print
// it in: "3 checks in a row slower than 10 s on https://www.google.com".
export function ruleDescription(check: UptimeCheck, rule: UptimeRule): string {
  if (rule === "down") return `no acceptable response for ${check.downMinutesToOpen} min from ${check.url}`;
  const n = check.slowChecksToOpen;
  const checks = n === 1 ? "1 check" : `${n} checks in a row`;
  return `${checks} slower than ${duration(check.slowMs)} on ${check.url}`;
}

// "Slow responses from www.google.com", "www.google.com is not responding".
export const incidentTitle = (check: UptimeCheck, rule: UptimeRule) =>
  rule === "down" ? `${checkHost(check)} is not responding` : `Slow responses from ${checkHost(check)}`;
