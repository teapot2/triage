"use client";

import { HistoryIcon, LoaderCircleIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Timestamp } from "@/components/timestamp";
import { StatusBadge } from "@/components/ui/badge";
import type { RuleState, WatchState } from "@/lib/investigation/watch";
import type { Backtest } from "@/lib/investigation/watch-judge";
import type { WatchRule } from "@/lib/investigation/watch-rule-model";
import { cn } from "@/lib/utils";
import { ruleStatus, ruleStatuses } from "./rule-filters";

// What the Watch pages share in the browser: the watch's live state, a
// rule's status badge, saving the rule list, and the backtest.

export const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

// A rule's description as the start of a sentence: capitalized, except a
// metric name like p95, which stays as it's written.
export const sentence = (s: string) => (/^p\d/.test(s) ? s : s.charAt(0).toUpperCase() + s.slice(1));

// A form's header sentence as it's edited. While a number is invalid (its
// field says why) the last sentence that read stays, dimmed, rather than an
// empty line.
export function ReadBack({ text }: { text: string | undefined }) {
  const [last, setLast] = useState(text);
  if (text !== undefined && text !== last) setLast(text);
  return <span className={cn("min-h-5 transition-opacity", text === undefined && "opacity-50")}>{text ?? last}</span>;
}

export const windowLabel = (s: number) => (s < 60 ? `${s} seconds` : s === 60 ? "minute" : `${s / 60} minutes`);

// The watch's state, polled, for each rule's live status. The sidebar polls
// the same endpoint; the watch checks every 10 seconds.
export function useWatchState() {
  const [state, setState] = useState<WatchState>();
  useEffect(() => {
    let stopped = false;
    async function poll() {
      try {
        const res = await fetch("/api/watch", { cache: "no-store" });
        if (res.ok && !stopped) setState((await res.json()) as WatchState);
      } catch {
        // The next poll tries again.
      }
    }
    void poll();
    const timer = setInterval(() => void poll(), 5_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);
  return state;
}

// What the watch last made of the rule, as a status badge, in the same
// words and colors as the Watch list's Status filter.
export function liveBadge(rule: WatchRule, live: RuleState | undefined, watchOn: boolean | undefined): ReactNode {
  if (rule.enabled && watchOn === false) return <StatusBadge tone="muted">Watch paused</StatusBadge>;
  const status = ruleStatus(rule, live, watchOn);
  if (!status) {
    return (
      <StatusBadge tone="muted" loading>
        Checking
      </StatusBadge>
    );
  }
  const { label, tone } = ruleStatuses.find((s) => s.id === status) ?? ruleStatuses[0];
  return (
    <StatusBadge tone={tone} pulse={status === "breaching"}>
      {status === "breaching" && live ? `${label} · ${live.checks} of ${live.needed}` : label}
    </StatusBadge>
  );
}

// Changes the saved rule list: reads the server's current list, applies
// `change` and saves the result, so a change made on another page or tab in
// the meantime isn't overwritten. The watch checks against it right away.
export async function updateRules(
  change: (rules: WatchRule[]) => WatchRule[],
): Promise<{ rules?: WatchRule[]; error?: string }> {
  try {
    const current = await fetch("/api/watch/rules", { cache: "no-store" });
    if (!current.ok) return { error: `HTTP ${current.status}` };
    const { rules } = (await current.json()) as { rules: WatchRule[] };
    const res = await fetch("/api/watch/rules", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rules: change(rules) }),
    });
    const data = (await res.json()) as { rules?: WatchRule[]; error?: string };
    return res.ok && data.rules ? { rules: data.rules } : { error: data.error ?? `HTTP ${res.status}` };
  } catch (err) {
    return { error: message(err) };
  }
}

export type BacktestState = { loading: boolean; data?: Backtest; error?: string };

// Replays a rule over the last 3 hours of telemetry, half a second after it
// last changed, cancelling a replay still in flight. Keyed on what decides
// when it fires, so renaming it doesn't replay. While a new replay runs, the
// last result stays, to show dimmed.
export function useBacktest(rule: WatchRule | undefined): BacktestState {
  const key = rule ? JSON.stringify({ ...rule, id: "draft", name: "draft", enabled: true, severity: "sev4" }) : undefined;
  const [result, setResult] = useState<{ key: string; data?: Backtest; error?: string }>();
  useEffect(() => {
    if (!key) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      fetch("/api/watch/rules/backtest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rule: JSON.parse(key) }),
        signal: ctrl.signal,
      })
        .then(async (res) => {
          const data = (await res.json()) as Backtest & { error?: string };
          setResult(res.ok ? { key, data } : { key, error: data.error ?? `HTTP ${res.status}` });
        })
        .catch((err) => {
          if (!ctrl.signal.aborted) setResult({ key, error: message(err) });
        });
    }, 500);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [key]);
  return { loading: Boolean(key) && result?.key !== key, data: result?.data, error: result?.error };
}

// "1 h 14 min", for how far back the telemetry reaches.
function span(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
}

// What the replay found: whether the rule would have opened incidents, and
// when, or why there's nothing to say.
export function BacktestResult({ backtest, checksToOpen }: { backtest: BacktestState; checksToOpen: number }) {
  const { loading, data, error } = backtest;
  let body: ReactNode;
  if (error) body = <p className="text-muted-foreground">Couldn&apos;t replay it: {error}</p>;
  else if (!data) body = <p className="text-muted-foreground">Replaying the last 3 hours…</p>;
  else if (data.judged === 0) body = <p>No traffic on the routes it covers, so nothing to judge it on.</p>;
  else {
    const traffic = `${plural(data.judged, "check", "checks")} with traffic`;
    body = (
      <>
        <p>
          <span className="font-medium">
            {data.fired.length === 0
              ? "Wouldn't have opened an incident."
              : `Would have opened ${plural(data.fired.length, "incident", "incidents")}.`}
          </span>{" "}
          <span className="text-muted-foreground">
            {data.breaching === 0
              ? `Within its limit in all ${traffic}.`
              : data.fired.length === 0
                ? `Over its limit in ${data.breaching.toLocaleString()} of ${traffic}, never ${plural(checksToOpen, "check", "checks")} in a row.`
                : `Over its limit in ${data.breaching.toLocaleString()} of ${traffic}.`}
          </span>
        </p>
        {data.fired.length > 0 && (
          <ul className="flex flex-col gap-0.5 text-xs">
            {data.fired.slice(-5).map((f) => (
              <li key={f.at} className="flex flex-wrap gap-x-2">
                <Timestamp date={f.at} className="font-mono text-muted-foreground tabular-nums" />
                <span className="min-w-0 break-words">{f.summary ?? f.route}</span>
              </li>
            ))}
            {data.fired.length > 5 && <li className="text-muted-foreground">and {data.fired.length - 5} earlier</li>}
          </ul>
        )}
      </>
    );
  }
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border bg-muted/30 px-3 py-2.5 text-sm" aria-live="polite">
      <div className="flex items-center gap-1.5 font-medium text-xs">
        <HistoryIcon className="size-3.5 text-muted-foreground" aria-hidden />
        Backtest · last 3 hours
        {loading && <LoaderCircleIcon className="size-3 animate-spin text-muted-foreground" aria-label="Replaying" />}
      </div>
      <div className={cn("flex flex-col gap-1.5 transition-opacity", loading && data && "opacity-60")}>{body}</div>
      <p className="text-muted-foreground text-xs">
        The watch&apos;s 10-second checks replayed with this rule on its own.
        {data?.dataFrom && ` Telemetry only reaches back ${span(Date.parse(data.to) - Date.parse(data.dataFrom))}.`}
      </p>
    </div>
  );
}
