"use client";

import { ArrowUpRight, Check, CircleAlert, LifeBuoy, Play, Rocket, Square, Undo2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Switch } from "radix-ui";
import { Button } from "@/components/ui/button";
import type { OpsState } from "@/lib/ops";
import { presets, profileFields, type Profile } from "@/lib/traffic-profile";
import { cn } from "@/lib/utils";
import { ProfileEditor } from "./profile-editor";

const POLL_MS = 1000;
// Past this, the product API's p95 counts against the store.
const SLOW_P95_MS = 500;

type Verdict = "healthy" | "degraded" | "down";

const verdicts: Record<Verdict, { label: string; dot: string; text: string }> = {
  healthy: { label: "Healthy", dot: "bg-primary", text: "text-primary" },
  degraded: { label: "Degraded", dot: "bg-sale", text: "text-[color-mix(in_oklab,var(--sale)_80%,black)]" },
  down: { label: "Down", dot: "bg-destructive", text: "text-[color-mix(in_oklab,var(--destructive)_80%,black)]" },
};

const percent = (ratio: number | null) => (ratio === null ? "–" : `${Math.round(ratio * 100)}%`);
const seconds = (ms: number) => (ms < 1000 ? "<1 s" : `${Math.round(ms / 1000)} s`);
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const sameProfile = (a: Profile, b: Profile) => profileFields.every((f) => a[f.key] === b[f.key]);

// How the store is doing, from what /ops can see without the database, and
// the signals from the last 10 s that decided it, so "Degraded" never has to
// be guessed at.
function assess({ pool, traffic }: OpsState): { verdict: Verdict; reasons: string[] } {
  const { last10s } = traffic;
  const errorRatio = last10s.errorRatio ?? 0;
  const p95 = last10s.p95 ?? 0;
  const poolFull = pool.checkedOut >= pool.max && pool.waiting > 0;

  const verdict: Verdict =
    poolFull || errorRatio >= 0.5
      ? "down"
      : pool.stuck > 0 || pool.waiting > 0 || errorRatio > 0 || p95 > SLOW_P95_MS
        ? "degraded"
        : "healthy";

  const waiting = `${count(pool.waiting, "request")} ${pool.waiting === 1 ? "is" : "are"} waiting`;
  const reasons: string[] = [];
  if (poolFull) reasons.push(`The pool is full and ${waiting}.`);
  else if (pool.waiting > 0) reasons.push(`${waiting} for a connection.`);
  if (pool.stuck > 0) reasons.push(`${count(pool.stuck, "connection")} held over ${seconds(pool.stuckAfterMs)}.`);
  if (errorRatio > 0) {
    reasons.push(`${percent(errorRatio)} of requests failed: a 5xx, or no answer within ${seconds(traffic.requestTimeoutMs)}.`);
  }
  if (p95 > SLOW_P95_MS) reasons.push(`Product API p95 is ${p95} ms, past the ${SLOW_P95_MS} ms mark.`);
  if (reasons.length === 0) {
    reasons.push(last10s.requests === 0 ? "No requests in the last 10 s." : "Nothing out of the ordinary in the last 10 s.");
  }
  return { verdict, reasons };
}

export function OpsPanel({ initial, triageUrl }: { initial: OpsState; triageUrl: string }) {
  const [state, setState] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Counts the actions sent. A poll that left before one would answer with
  // the state from before it, so its answer is dropped if it lands after.
  const actions = useRef(0);

  useEffect(() => {
    const timer = setInterval(async () => {
      const before = actions.current;
      try {
        const res = await fetch("/api/ops", { cache: "no-store" });
        const json = await res.json();
        if (res.ok && actions.current === before) setState(json);
      } catch {
        // The next poll tries again; a failed poll isn't worth a banner.
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, []);

  async function act(body: object, done?: (next: OpsState & { released?: number }) => void) {
    actions.current++;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/ops", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
      setState(json);
      done?.(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // Profile edits don't block the other controls, and a failed one shows
  // like any other.
  async function sendProfile(profile: object) {
    actions.current++;
    try {
      const res = await fetch("/api/ops", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "profile", profile }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
      setState(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const { verdict, reasons } = assess(state);
  const { pool, traffic, flags, release, releases } = state;
  const { last10s } = traffic;
  const activeFault = flags.find((f) => f.enabled);
  // A flag or a deployed release: whichever is on is the run's one fault.
  const faultLabel = activeFault?.label ?? (release ? `Release ${release.name}` : null);
  const preset = presets.find((p) => sameProfile(traffic.profile, p.profile));

  return (
    <div className="min-h-svh bg-secondary/40">
      <header className="border-b bg-card">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 sm:px-6">
          <Link href="/" className="font-serif text-lg font-semibold">
            Fernhill Goods
          </Link>
          <span className="rounded-md bg-foreground px-1.5 py-0.5 text-xs font-medium text-background">Ops</span>
          <nav className="ml-auto flex items-center gap-1 text-sm">
            <ExternalLink href="/">Store</ExternalLink>
            <ExternalLink href={triageUrl}>Triage</ExternalLink>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        {/* The verdict and why, then the five numbers that decide it. */}
        <section className="rounded-xl border bg-card p-5">
          <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
            <div className="flex items-start gap-3">
              <span className={cn("mt-2 size-3 shrink-0 rounded-full", verdicts[verdict].dot)} aria-hidden="true" />
              <div>
                <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Store status</p>
                {/* Only the verdict is announced; the numbers around it change every second. */}
                <h1 aria-live="polite" className={cn("text-2xl font-semibold tracking-tight", verdicts[verdict].text)}>
                  {verdicts[verdict].label}
                </h1>
                <p className="mt-1 text-sm text-muted-foreground">{reasons.join(" ")}</p>
              </div>
            </div>
            <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm sm:text-right">
              <div>
                <dt className="text-xs text-muted-foreground">Fault</dt>
                <dd className={cn("font-medium", faultLabel && "text-destructive")}>{faultLabel ?? "None"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Traffic</dt>
                <dd className="font-medium">
                  {traffic.running ? `${preset?.name ?? "Custom"}, ${traffic.profile.rps} req/s` : "Off"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Updates</dt>
                <dd className="font-medium">Every second</dd>
              </div>
            </dl>
          </div>
          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <Tile label="Requests" value={last10s.requests} hint="last 10 s" />
            <Tile
              label="Failed requests"
              value={percent(last10s.errorRatio)}
              hint="5xx or timed out"
              alert={(last10s.errorRatio ?? 0) > 0}
            />
            <Tile
              label="Product API p95"
              value={last10s.p95 === null ? "–" : `${last10s.p95} ms`}
              hint={`slow past ${SLOW_P95_MS} ms`}
              alert={(last10s.p95 ?? 0) > SLOW_P95_MS}
            />
            <Tile
              label="Pool in use"
              value={`${pool.checkedOut} / ${pool.max}`}
              hint={`${count(pool.idle, "connection")} idle`}
              alert={pool.checkedOut >= pool.max}
            />
            <Tile
              label="Stuck connections"
              value={pool.stuck}
              hint={`${pool.waiting} waiting for one`}
              alert={pool.stuck > 0 || pool.waiting > 0}
            />
          </div>
        </section>

        {(error || notice) && (
          <p
            role={error ? "alert" : "status"}
            className={cn(
              "mt-4 flex items-center gap-2 rounded-lg border p-3 text-sm",
              error ? "border-destructive/30 bg-destructive/5" : "bg-card",
            )}
          >
            {error && <CircleAlert className="size-4 shrink-0 text-destructive" />}
            {error ?? notice}
          </p>
        )}

        <div className="mt-6 grid gap-6 lg:grid-cols-[1.4fr_1fr]">
          <div className="space-y-6">
            <Card
              title="Synthetic traffic"
              aside={
                traffic.running
                  ? `${count(traffic.visits, "visitor")}${traffic.rush ? ", rush on" : ""}, ${traffic.inFlight} in flight`
                  : "Off"
              }
            >
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  size="lg"
                  variant={traffic.running ? "outline" : "default"}
                  className={cn("h-9 px-4", traffic.running && "bg-card")}
                  disabled={busy}
                  onClick={() => act({ action: "traffic", on: !traffic.running })}
                >
                  {traffic.running ? <Square /> : <Play />}
                  {traffic.running ? "Stop traffic" : "Start traffic"}
                </Button>
                <p className="text-sm text-muted-foreground">
                  {preset?.name ?? "Custom profile"}, about {traffic.profile.rps} req/s.{" "}
                  <a href="#profile" className="text-foreground underline-offset-4 hover:underline">
                    Shape it below
                  </a>
                  .
                </p>
              </div>
              <Timeline timeline={traffic.timeline} />
              <dl className="mt-4 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
                <Stat label="4xx" value={percent(last10s.clientErrorRatio)} hint="stale links, bad ids" />
                <Stat label="Abandoned" value={percent(last10s.abortedRatio)} hint="gave up early" />
                <Stat label="Visitors" value={traffic.running ? traffic.visits : "–"} hint="since the start" />
                <Stat label="In flight" value={traffic.running ? traffic.inFlight : "–"} hint="right now" />
              </dl>
              <RouteTable routes={traffic.routes} />
            </Card>

            <Card title="Connection pool" aside={`${pool.checkedOut} of ${pool.max} checked out`}>
              <PoolCells pool={pool} />
              <dl className="mt-4 grid grid-cols-3 gap-4 text-sm">
                <Stat label="Waiting" value={pool.waiting} hint="for a connection" alert={pool.waiting > 0} />
                <Stat label="Stuck" value={pool.stuck} hint={`held over ${seconds(pool.stuckAfterMs)}`} alert={pool.stuck > 0} />
                <Stat label="Held longest" value={pool.held.length ? seconds(pool.held[0]) : "–"} hint="of those in use" />
              </dl>
              <div className="mt-5 flex flex-wrap items-center gap-3 border-t pt-4">
                <Button
                  variant="outline"
                  size="lg"
                  className="bg-card"
                  disabled={busy || pool.stuck === 0}
                  onClick={() =>
                    act({ action: "release" }, (next) =>
                      setNotice(`Released ${count(next.released ?? 0, "stuck connection")}.`),
                    )
                  }
                >
                  <LifeBuoy />
                  Release stuck connections{pool.stuck > 0 ? ` (${pool.stuck})` : ""}
                </Button>
                <p className="text-sm text-muted-foreground">
                  Hands back connections held over {seconds(pool.stuckAfterMs)}, as a restart would. They leak again
                  unless the fault is off.
                </p>
              </div>
            </Card>
          </div>

          <div className="space-y-6">
            <Card title="Faults">
              <p className="-mt-2 mb-4 text-sm text-muted-foreground">
                One at a time, so every incident has a single root cause. Each flip is logged like a config push.
              </p>
              <ul className="space-y-2">
                {flags.map((flag) => (
                  <li
                    key={flag.name}
                    className={cn(
                      "rounded-lg border p-3 transition-colors",
                      flag.enabled ? "border-destructive/40 bg-destructive/5" : "bg-card",
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <Switch.Root
                        id={flag.name}
                        checked={flag.enabled}
                        disabled={busy}
                        onCheckedChange={(enabled) => act({ action: "flag", name: flag.name, enabled })}
                        className="relative mt-px inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full bg-border transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-60 data-[state=checked]:bg-destructive"
                      >
                        <Switch.Thumb className="block size-5 translate-x-0.5 rounded-full bg-card shadow-sm transition-transform data-[state=checked]:translate-x-[1.125rem]" />
                      </Switch.Root>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-2">
                          <label htmlFor={flag.name} className="text-sm font-medium">
                            {flag.label}
                          </label>
                          {flag.enabled && <span className="text-xs font-medium text-destructive">On</span>}
                        </div>
                        <code className="font-mono text-xs text-muted-foreground">{flag.name}</code>
                        <p className="mt-1 text-sm text-muted-foreground">{flag.effect}</p>
                        <details className="group mt-1.5">
                          <summary className="cursor-pointer list-none text-xs text-muted-foreground hover:text-foreground">
                            <span className="group-open:hidden">How it breaks the store</span>
                            <span className="hidden group-open:inline">Hide</span>
                          </summary>
                          <p className="mt-1.5 text-sm text-muted-foreground">{flag.description}</p>
                        </details>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>

            <Card title="Releases">
              <p className="-mt-2 mb-4 text-sm text-muted-foreground">
                A real commit, applied to the running store and logged like a deploy. Counts as the one fault.
              </p>
              <ul className="space-y-2">
                {releases.map((r) => {
                  const deployed = release?.name === r.name;
                  return (
                    <li
                      key={r.name}
                      className={cn(
                        "rounded-lg border p-3 transition-colors",
                        deployed ? "border-destructive/40 bg-destructive/5" : "bg-card",
                      )}
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <p className="text-sm font-medium">{r.label}</p>
                        {deployed && <span className="text-xs font-medium text-destructive">Deployed</span>}
                      </div>
                      <code className="font-mono text-xs text-muted-foreground">
                        {r.sha ? `${r.sha} ${r.message}` : r.branch}
                      </code>
                      {r.effect && <p className="mt-1 text-sm text-muted-foreground">{r.effect}</p>}
                      {r.description && (
                        <details className="group mt-1.5">
                          <summary className="cursor-pointer list-none text-xs text-muted-foreground hover:text-foreground">
                            <span className="group-open:hidden">How it breaks the store</span>
                            <span className="hidden group-open:inline">Hide</span>
                          </summary>
                          <p className="mt-1.5 text-sm text-muted-foreground">{r.description}</p>
                        </details>
                      )}
                      <div className="mt-3 flex flex-wrap items-center gap-3">
                        {r.sha ? (
                          <Button
                            size="sm"
                            variant={deployed ? "outline" : "default"}
                            className={cn(deployed && "bg-card")}
                            disabled={busy || (!deployed && Boolean(release))}
                            onClick={() => act(deployed ? { action: "rollback" } : { action: "deploy", name: r.name })}
                          >
                            {deployed ? <Undo2 /> : <Rocket />}
                            {deployed ? "Roll back" : "Deploy"}
                          </Button>
                        ) : (
                          <p className="text-xs text-muted-foreground">
                            No branch yet. Run{" "}
                            <code className="font-mono text-foreground">pnpm --filter @triage/shopfront release {r.name}</code>.
                          </p>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Card>

            <Card title="Run the demo">
              <p className="-mt-2 mb-4 text-sm text-muted-foreground">
                Plant a fault in the live store, send it traffic, and let Triage find out what broke.
              </p>
              <ol className="space-y-3">
                <Step n={1} done={traffic.running} title="Start traffic">
                  Normal day is enough. For cart traffic too, run{" "}
                  <code className="font-mono text-xs text-foreground">pnpm --filter @triage/shopfront shoppers</code>.
                </Step>
                <Step n={2} done={Boolean(faultLabel)} title="Turn on a fault or deploy a release">
                  The pool leak is the classic: each view of the Cast Iron Teapot keeps one connection.
                </Step>
                <Step n={3} done={verdict !== "healthy"} title="Watch the store degrade">
                  The status above turns Degraded, then Down, as the numbers cross their marks.
                </Step>
                <Step n={4} title="Investigate in Triage">
                  A watch rule opens an incident; Triage reads the telemetry and names the cause.{" "}
                  <a
                    href={triageUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-0.5 text-foreground underline-offset-4 hover:underline"
                  >
                    Open Triage
                    <ArrowUpRight className="size-3.5" />
                  </a>
                </Step>
                <Step n={5} title="Recover">
                  Turn the fault off or roll the release back, then release stuck connections if the pool is still full.
                </Step>
              </ol>
            </Card>
          </div>
        </div>

        <div className="mt-6" id="profile">
          <Card title="Traffic profile" aside="Applies to the next visitor, running or not">
            <ProfileEditor profile={traffic.profile} onChange={sendProfile} />
          </Card>
        </div>
      </main>
    </div>
  );
}

function Card({ title, aside, children }: { title: string; aside?: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border bg-card p-5">
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h2 className="font-medium">{title}</h2>
        {aside && <p className="text-sm text-muted-foreground tabular-nums">{aside}</p>}
      </div>
      {children}
    </section>
  );
}

// A headline number in the status band.
function Tile({ label, value, hint, alert }: { label: string; value: ReactNode; hint: string; alert?: boolean }) {
  return (
    <div
      className={cn(
        "rounded-lg border bg-secondary/50 px-3.5 py-3 max-sm:last:col-span-2",
        alert && "border-destructive/30 bg-destructive/5",
      )}
    >
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn("mt-1 text-2xl font-semibold tracking-tight tabular-nums", alert && "text-destructive")}>{value}</p>
      <p className="mt-0.5 truncate text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

function Stat({ label, value, hint, alert }: { label: string; value: ReactNode; hint?: string; alert?: boolean }) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("mt-0.5 text-xl font-medium tabular-nums", alert && "text-destructive")}>{value}</dd>
      {hint && <dd className="text-xs text-muted-foreground">{hint}</dd>}
    </div>
  );
}

// A walkthrough step; the first three tick themselves as the store gets there.
function Step({ n, done, title, children }: { n: number; done?: boolean; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        className={cn(
          "mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full border text-xs font-medium tabular-nums transition-colors",
          done ? "border-primary bg-primary text-primary-foreground" : "bg-card text-muted-foreground",
        )}
        aria-label={done ? `Step ${n}, done` : `Step ${n}`}
      >
        {done ? <Check className="size-3" /> : n}
      </span>
      <div className="text-sm">
        <p className="font-medium">{title}</p>
        <p className="text-muted-foreground">{children}</p>
      </div>
    </li>
  );
}

// One cell per pool slot: held past the stuck threshold, held, or free.
function PoolCells({ pool }: { pool: OpsState["pool"] }) {
  return (
    <div className="grid grid-cols-10 gap-1.5" role="img" aria-label={`${pool.checkedOut} of ${pool.max} connections checked out, ${pool.stuck} stuck`}>
      {Array.from({ length: pool.max }, (_, i) => {
        const state = i < pool.stuck ? "stuck" : i < pool.checkedOut ? "held" : "free";
        return (
          <div
            key={i}
            className={cn(
              "h-8 rounded-md border transition-colors duration-300",
              state === "stuck" && "border-destructive bg-destructive/80",
              state === "held" && "border-primary bg-primary/70",
              state === "free" && "bg-secondary",
            )}
          />
        );
      })}
    </div>
  );
}

// p95 latency per second over the last minute, on a log scale so 40 ms and
// 3 s both read. Seconds with errors are red; empty seconds stay flat.
function Timeline({ timeline }: { timeline: OpsState["traffic"]["timeline"] }) {
  // Whole percents: unrounded floats serialize differently on the server and
  // in the browser, which breaks hydration.
  const height = (s: { ok: number; errors: number; p95: number | null }) => {
    if (s.ok + s.errors === 0) return 0;
    const scaled = s.p95 === null ? 0 : Math.log10(Math.max(s.p95, 10)) / Math.log10(5000);
    return Math.max(4, Math.round(Math.min(1, scaled) * 100));
  };
  return (
    <figure className="mt-5">
      <div className="flex h-20 items-end gap-px border-b" aria-hidden="true">
        {timeline.map((s, i) => (
          <div
            key={i}
            className={cn("flex-1 rounded-t-[2px]", s.errors > 0 ? "bg-destructive/80" : "bg-primary/60")}
            style={{ height: `${height(s)}%` }}
          />
        ))}
      </div>
      <figcaption className="mt-1.5 flex justify-between text-xs text-muted-foreground">
        <span>60 s ago</span>
        <span className="max-sm:hidden">product API p95 each second, red when a request failed</span>
        <span>now</span>
      </figcaption>
    </figure>
  );
}

// What the visitors asked for in the last minute, busiest first.
function RouteTable({ routes }: { routes: OpsState["traffic"]["routes"] }) {
  if (routes.length === 0) return null;
  return (
    <table className="mt-5 w-full text-sm">
      <caption className="mb-2 text-left text-xs text-muted-foreground">Last minute, by page</caption>
      <thead className="text-xs text-muted-foreground">
        <tr className="border-b">
          <th scope="col" className="py-1.5 text-left font-normal">Page</th>
          <th scope="col" className="py-1.5 text-right font-normal">Requests</th>
          <th scope="col" className="py-1.5 text-right font-normal">4xx</th>
          <th scope="col" className="py-1.5 text-right font-normal">Failed</th>
          <th scope="col" className="py-1.5 text-right font-normal">Abandoned</th>
        </tr>
      </thead>
      <tbody className="tabular-nums">
        {routes.map((r) => (
          <tr key={r.route} className="border-b last:border-0">
            <th scope="row" className="py-1.5 text-left font-normal">{r.route}</th>
            <td className="py-1.5 text-right">{r.requests}</td>
            <td className="py-1.5 text-right text-muted-foreground">{r.clientErrors || "–"}</td>
            <td className={cn("py-1.5 text-right", r.errors ? "font-medium text-destructive" : "text-muted-foreground")}>
              {r.errors || "–"}
            </td>
            <td className="py-1.5 text-right text-muted-foreground">{r.aborted || "–"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target={href.startsWith("http") ? "_blank" : undefined}
      rel="noreferrer"
      className="inline-flex items-center gap-0.5 rounded-md px-2.5 py-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
    >
      {children}
      <ArrowUpRight className="size-3.5" />
    </a>
  );
}
