import { type ProviderId, providers } from "./providers";
import type { StageId } from "./stages";

// How long a model call may take and how it's retried, for every stage.
//
// Attempt: one HTTP request, up to its whole answer (a stream's headers).
// The slowest of 105 Spark 1.3 calls on record took 28 s; 90 s leaves room
// for a long reasoning call. A model on your own machine can take minutes.
// A timed-out attempt is retried like a 503 (fetch.ts).
const ATTEMPT_MS = 90_000;
const LOCAL_ATTEMPT_MS = 5 * 60_000;
// Four attempts, waiting a random 0–1 s, 0–2 s, then 0–4 s between them
// (Meta's guidance: a 0.5–1 s base, doubling, with jitter, 3–5 attempts).
const ATTEMPTS = 4;
const BASE_DELAY_MS = 1_000;
// A 429 that asks to wait longer than this fails instead.
const MAX_RETRY_AFTER_MS = 30_000;

// A stream (Ask, the postmortem) that goes this long without a chunk once
// it has started fails: the model stopped mid-answer. Not retried, since
// the answer so far is already on screen.
export const STALL_MS = 60_000;

// Each stage's whole run: every pass, model call and tool. Runs on record
// took 11–77 s to investigate, 29–101 s to fix (the sandbox included) and
// 16–33 s to write a postmortem.
const RUN_BUDGET_MS: Record<StageId, number> = {
  investigate: 10 * 60_000,
  fix: 15 * 60_000,
  ask: 5 * 60_000,
  postmortem: 5 * 60_000,
};
const RUN_NAMES: Record<StageId, string> = {
  investigate: "The investigation",
  fix: "The fix",
  ask: "The answer",
  postmortem: "The postmortem",
};

export type RetryPolicy = {
  // Who answers, for error messages: "Meta's API".
  label: string;
  attempts: number;
  attemptMs: number;
  baseDelayMs: number;
  maxRetryAfterMs: number;
};

export function policyFor(provider: ProviderId): RetryPolicy {
  const info = providers[provider];
  return {
    label: info.label,
    attempts: ATTEMPTS,
    attemptMs: info.local ? LOCAL_ATTEMPT_MS : ATTEMPT_MS,
    baseDelayMs: BASE_DELAY_MS,
    maxRetryAfterMs: MAX_RETRY_AFTER_MS,
  };
}

// A run that went past its budget. Named TimeoutError so the AI SDK treats
// it as the abort it is (never retried), while its message reads as is.
export class RunTimeoutError extends Error {
  override name = "TimeoutError";
  readonly runTimeout = true;
}

// The signal that ends a stage's run at its budget, passed to every
// generate() and stream() of that run. `ms` is for tests.
export function runBudget(stage: StageId, ms = RUN_BUDGET_MS[stage]): AbortSignal {
  const controller = new AbortController();
  const minutes = Math.round(ms / 60_000);
  const limit = minutes >= 1 ? `${minutes}-minute` : `${Math.round(ms / 1000)}-second`;
  const timer = setTimeout(() => controller.abort(new RunTimeoutError(`${RUN_NAMES[stage]} ran past its ${limit} limit.`)), ms);
  // A finished run doesn't keep the process (or a test) alive.
  timer.unref?.();
  return controller.signal;
}
