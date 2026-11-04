"use client";

import { LoaderCircleIcon, PauseIcon, PencilIcon, PlayIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";
import { Timestamp } from "@/components/timestamp";
import { SeverityBars, severityLabel, StatusIcon, statusLabel } from "@/components/incident/status-badges";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { IncidentStatus } from "@/lib/investigation/schema";
import { conditionText, describeRule, targetText, type WatchRule } from "@/lib/investigation/watch-rule-model";
import { SLOW_BURN_HOLD_MS } from "@/lib/slo/judge";
import { alertText, allowanceText, burnAlerts, durationText, SLOW_BURN_SEVERITY, shortMinimumsText } from "@/lib/slo/model";
import { BacktestResult, liveBadge, plural, sentence, updateRules, useBacktest, useWatchState, windowLabel } from "./watch-client";
import { WatchHeader } from "./watch-header";

export type RuleIncident = { id: string; title: string; status: IncidentStatus; detectedAt: string };

// A rule's own page, read-only: its live status, what the last 3 hours say
// about it, the incidents it opened, and its configuration beside them, as
// Sentry lays out an alert rule. Changing it is the Edit page; the one
// change made here is pausing, a deliberate button.
export function RuleDetail({ rule: initial, incidents }: { rule: WatchRule; incidents: RuleIncident[] }) {
  const router = useRouter();
  const [rule, setRule] = useState(initial);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string>();
  const watch = useWatchState();
  const live = watch?.rules.find((r) => r.id === rule.id);
  const backtest = useBacktest(rule);
  const slo = rule.condition.metric === "slo" ? rule.condition : undefined;

  async function toggle() {
    setToggling(true);
    setError(undefined);
    const result = await updateRules((rules) => rules.map((r) => (r.id === rule.id ? { ...r, enabled: !rule.enabled } : r)));
    const saved = result.rules?.find((r) => r.id === rule.id);
    if (saved) {
      setRule(saved);
      router.refresh();
    }
    setError(result.error ?? (result.rules && !saved ? "This rule no longer exists." : undefined));
    setToggling(false);
  }

  return (
    <div className="flex flex-col gap-6">
      <WatchHeader
        crumbs={[{ label: "Watch", href: "/watch" }]}
        title={rule.name}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => void toggle()} disabled={toggling}>
              {toggling ? <LoaderCircleIcon className="animate-spin" /> : rule.enabled ? <PauseIcon /> : <PlayIcon />}
              {rule.enabled ? "Pause" : "Resume"}
            </Button>
            <Button size="sm" asChild>
              <Link href={`/watch/${rule.id}/edit`}>
                <PencilIcon />
                Edit rule
              </Link>
            </Button>
          </>
        }
      >
        {liveBadge(rule, live, watch?.enabled)}
        <span className="sm:ml-1">{sentence(describeRule(rule))}</span>
      </WatchHeader>

      {error && (
        <Alert variant="destructive" dismissible dismissLabel="Dismiss error" onDismiss={() => setError(undefined)}>
          <AlertTitle>Couldn&apos;t {rule.enabled ? "pause" : "resume"} the rule</AlertTitle>
          <AlertDescription className="break-words">{error}</AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 md:grid-cols-[minmax(0,1fr)_17rem] md:gap-8">
        <div className="flex min-w-0 flex-col gap-6">
          <Section title="Last check">
            {!rule.enabled ? (
              <p className="px-3 py-2 text-muted-foreground">Paused, so the watch skips it. Resume it to judge it again.</p>
            ) : watch?.enabled === false ? (
              <p className="px-3 py-2 text-muted-foreground">The watch is paused. Resume it from the sidebar.</p>
            ) : live?.summary ? (
              <p className="px-3 py-2">
                {sentence(live.summary)}
                {live.status === "breaching" && (slo || live.checks) && (
                  <span className="text-muted-foreground">
                    {" "}
                    {/* An SLO opens on its first check over, or, for a slow
                        burn, once it has fired for the hold (no check
                        counted until then). */}
                    {slo
                      ? live.checks
                        ? "· over its limit"
                        : `· a slow burn, which opens an incident once it has lasted ${SLOW_BURN_HOLD_MS / 60_000} min`
                      : `· over its limit ${plural(live.checks ?? 0, "check", "checks")} in a row of ${live.needed}`}
                  </span>
                )}
              </p>
            ) : (
              <p className="px-3 py-2 text-muted-foreground">
                {!live ? "Waiting for the watch's next check." : live.status === "idle" ? idleText(rule) : "Nothing to judge it on yet."}
              </p>
            )}
          </Section>

          <BacktestResult backtest={backtest} rule={rule} />

          <Section title="Incidents it opened">
            {incidents.length === 0 ? (
              <p className="px-3 py-2 text-muted-foreground">None yet.</p>
            ) : (
              <ul className="divide-y">
                {incidents.map((i) => (
                  <li key={i.id}>
                    <Link
                      href={`/incidents/${i.id}`}
                      className="flex items-center gap-2 px-3 py-2 outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted/50"
                    >
                      <StatusIcon status={i.status} />
                      <span className="min-w-0 flex-1 truncate">{i.title}</span>
                      <span className="shrink-0 text-muted-foreground text-xs">
                        {statusLabel[i.status]} · <Timestamp date={i.detectedAt} />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>

        <aside aria-label="Configuration" className="flex flex-col gap-3 md:border-l md:pl-8">
          <h2 className="font-medium text-sm">Configuration</h2>
          <dl className="flex flex-col gap-3 text-sm">
            <Fact label="Routes">
              {rule.target.kind === "route" ? <span className="font-mono text-xs">{rule.target.route}</span> : sentence(targetText(rule.target))}
            </Fact>
            <Fact label="Condition">{sentence(conditionText(rule.condition))}</Fact>
            {slo ? (
              <>
                <Fact label="Error budget">{sentence(allowanceText(slo.objectivePercent, slo.windowDays))}</Fact>
                <Fact label="Opens an incident when it burns">
                  {sentence(
                    burnAlerts
                      .filter((a) => a.speed === "fast")
                      .map((a) => alertText(a, slo.windowDays))
                      .join(", or "),
                  )}
                  <span className="text-muted-foreground">
                    {" "}
                    ({SLOW_BURN_SEVERITY.toUpperCase()} at {alertText(burnAlerts[2], slo.windowDays)})
                  </span>
                </Fact>
              </>
            ) : (
              <>
                <Fact label="Judged over">The last {windowLabel(rule.windowSeconds)}</Fact>
                <Fact label="Opens an incident after">
                  {plural(rule.checksToOpen, "check", "checks")} in a row
                  <span className="text-muted-foreground"> ({rule.checksToOpen * 10} seconds)</span>
                </Fact>
              </>
            )}
            {rule.condition.metric !== "slowCount" && (
              <Fact label="Minimum requests">
                {plural(rule.minRequests, "request", "requests")} per route
                {slo ? ", in an alert's long window" : ""}
                {slo && (
                  <span className="text-muted-foreground">
                    {" "}
                    (in its short window, enough that one bad request can&apos;t fire it: {shortMinimumsText(rule.minRequests, slo)})
                  </span>
                )}
              </Fact>
            )}
            <Fact label="Severity">
              <span className="flex items-center gap-1.5">
                <SeverityBars severity={rule.severity} />
                {rule.severity.toUpperCase()} · {severityLabel[rule.severity]}
              </span>
            </Fact>
          </dl>
        </aside>
      </div>
    </div>
  );
}

// Why the watch has no verdict on a rule: no route it covers had the rule's
// minimum of requests (an SLO's, in both of an alert's windows). A count of
// slow requests has no minimum, so for it idle is no traffic at all.
function idleText(rule: WatchRule): string {
  const c = rule.condition;
  if (c.metric === "slowCount") return `No traffic on the routes it covers in the last ${windowLabel(rule.windowSeconds)}.`;
  const min = plural(rule.minRequests, "request", "requests");
  if (c.metric === "slo") {
    const longs = burnAlerts.map((a) => durationText(a.longMs));
    const windows = `${longs.slice(0, -1).join(", ")} or ${longs.at(-1)}`;
    return `Too little traffic to judge: no route it covers had ${min} in an alert's long window (${windows}) and enough in its short one (${shortMinimumsText(rule.minRequests, c)}).`;
  }
  return `Too little traffic to judge: no route it covers had ${min} in the last ${windowLabel(rule.windowSeconds)}.`;
}

// A title over a bordered box, like the Backtest beside it and the forms'
// sections; what goes in the box brings its own padding, so lists can run
// edge to edge.
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-medium text-sm">{title}</h2>
      <div className="overflow-hidden rounded-lg border text-sm">{children}</div>
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
