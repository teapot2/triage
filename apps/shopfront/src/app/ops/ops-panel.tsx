"use client";

import { ArrowUpRight, CircleAlert, LifeBuoy, Play, Square } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { Switch } from "radix-ui";
import { Button } from "@/components/ui/button";
import type { OpsState } from "@/lib/ops";
import { cn } from "@/lib/utils";
import { ProfileEditor } from "./profile-editor";

const POLL_MS = 1000;

type Verdict = "healthy" | "degraded" | "down";

// How the store is doing, from what /ops can see without the database.
function verdict({ pool, traffic }: OpsState): Verdict {
  const errorRatio = traffic.last10s.errorRatio ?? 0;
  if ((pool.checkedOut >= pool.max && pool.waiting > 0) || errorRatio >= 0.5) return "down";
  if (pool.stuck > 0 || pool.waiting > 0 || errorRatio > 0 || (traffic.last10s.p95 ?? 0) > 500) return "degraded";
  return "healthy";
}

const verdicts: Record<Verdict, { label: string; className: string }> = {
  healthy: { label: "Healthy", className: "bg-primary/10 text-primary" },
  degraded: { label: "Degraded", className: "bg-sale/10 text-[color-mix(in_oklab,var(--sale)_80%,black)]" },
  down: { label: "Down", className: "bg-destructive/10 text-[color-mix(in_oklab,var(--destructive)_80%,black)]" },
};

const percent = (ratio: number | null) => (ratio === null ? "–" : `${Math.round(ratio * 100)}%`);

const seconds = (ms: number) => (ms < 1000 ? "<1 s" : `${Math.round(ms / 1000)} s`);

export function OpsPanel({ initial, triageUrl }: { initial: OpsState; triageUrl: string }) {
  const [state, setState] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const timer = setInterval(async () => {
      try {
        const res = await fetch("/api/ops", { cache: "no-store" });
        if (res.ok) setState(await res.json());
      } catch {
        // The next poll tries again; a failed poll isn't worth a banner.
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, []);

  async function act(body: object, done?: (next: OpsState & { released?: number }) => void) {
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

  const v = verdict(state);
  const { pool, traffic } = state;

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
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Demo controls</h1>
          <span
            role="status"
            className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-sm font-medium", verdicts[v].className)}
          >
            <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
            {verdicts[v].label}
          </span>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Plant a fault in the live store, send it traffic, and let Triage find out what broke. Updates every second.
        </p>

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
            <Card title="Connection pool" aside={`${pool.checkedOut} of ${pool.max} checked out`}>
              <PoolCells pool={pool} />
              <dl className="mt-4 grid grid-cols-3 gap-4 text-sm">
                <Stat label="Waiting for a connection" value={pool.waiting} alert={pool.waiting > 0} />
                <Stat label={`Held over ${seconds(pool.stuckAfterMs)}`} value={pool.stuck} alert={pool.stuck > 0} />
                <Stat label="Held longest" value={pool.held.length ? seconds(pool.held[0]) : "–"} />
              </dl>
            </Card>

            <Card
              title="Synthetic traffic"
              aside={
                traffic.running
                  ? `${traffic.visits} ${traffic.visits === 1 ? "visitor" : "visitors"}${traffic.rush ? ", rush on" : ""}, ${traffic.inFlight} in flight`
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
                  About {traffic.profile.rps} req/s on average. Shape it in Traffic profile below.
                </p>
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-4 text-sm sm:grid-cols-5">
                <Stat label="Requests, last 10 s" value={traffic.last10s.requests} />
                <Stat label="Server errors" value={percent(traffic.last10s.errorRatio)} alert={(traffic.last10s.errorRatio ?? 0) > 0} />
                <Stat label="4xx" value={percent(traffic.last10s.clientErrorRatio)} />
                <Stat label="Abandoned" value={percent(traffic.last10s.abortedRatio)} />
                <Stat
                  label="p95, product API"
                  value={traffic.last10s.p95 === null ? "–" : `${traffic.last10s.p95} ms`}
                  alert={(traffic.last10s.p95 ?? 0) > 500}
                />
              </dl>
              <Timeline timeline={traffic.timeline} />
              <RouteTable routes={traffic.routes} />
            </Card>
          </div>

          <div className="space-y-6">
            <Card title="Faults" aside="One at a time">
              <ul className="space-y-4">
                {state.flags.map((flag) => (
                  <li key={flag.name} className="flex gap-4">
                    <div className="min-w-0 flex-1">
                      <label htmlFor={flag.name} className="text-sm font-medium">
                        {flag.label}
                      </label>
                      <p className="font-mono text-xs text-muted-foreground">{flag.name}</p>
                      <p className="mt-1.5 text-sm text-muted-foreground">{flag.description}</p>
                    </div>
                    <Switch.Root
                      id={flag.name}
                      checked={flag.enabled}
                      disabled={busy}
                      onCheckedChange={(enabled) => act({ action: "flag", name: flag.name, enabled })}
                      className="relative mt-0.5 inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full bg-border transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-60 data-[state=checked]:bg-destructive"
                    >
                      <Switch.Thumb className="block size-5 translate-x-0.5 rounded-full bg-card shadow-sm transition-transform data-[state=checked]:translate-x-[1.125rem]" />
                    </Switch.Root>
                  </li>
                ))}
              </ul>
            </Card>

            <Card title="Recovery">
              <p className="text-sm text-muted-foreground">
                Hands back connections held longer than {seconds(pool.stuckAfterMs)}, as restarting the service would. The
                leak comes back unless the fault is off.
              </p>
              <Button
                variant="outline"
                size="lg"
                className="mt-4 h-10 bg-card"
                disabled={busy || pool.stuck === 0}
                onClick={() =>
                  act({ action: "release" }, (next) =>
                    setNotice(`Released ${next.released} stuck ${next.released === 1 ? "connection" : "connections"}.`),
                  )
                }
              >
                <LifeBuoy />
                Release stuck connections{pool.stuck > 0 ? ` (${pool.stuck})` : ""}
              </Button>
            </Card>

            <Card title="Run the demo">
              <ol className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground marker:text-foreground">
                <li>
                  Start traffic on the Normal day profile (2 req/s) and let latency settle. For cart traffic too, run{" "}
                  <code className="font-mono text-xs text-foreground">pnpm --filter @triage/shopfront shoppers</code>.
                </li>
                <li>
                  Turn on <span className="font-medium text-foreground">Connection pool leak</span>. Each view of the Cast
                  Iron Teapot keeps one connection.
                </li>
                <li>Watch the pool fill, then requests wait 3 s and fail.</li>
                <li>Open Triage and investigate the alert.</li>
                <li>Turn the fault off and release stuck connections to recover.</li>
              </ol>
            </Card>
          </div>
        </div>
        <div className="mt-6">
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

function Stat({ label, value, alert }: { label: string; value: ReactNode; alert?: boolean }) {
  return (
    <div className="flex flex-col justify-between">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("mt-0.5 text-xl font-medium tabular-nums", alert && "text-destructive")}>{value}</dd>
    </div>
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
        <span className="max-sm:hidden">product API p95 per second, red when requests failed</span>
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
          <th scope="col" className="py-1.5 text-right font-normal">5xx</th>
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
