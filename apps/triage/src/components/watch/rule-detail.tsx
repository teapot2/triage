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
              <p className="text-muted-foreground text-sm">Paused, so the watch skips it. Resume it to judge it again.</p>
            ) : watch?.enabled === false ? (
              <p className="text-muted-foreground text-sm">The watch is paused. Resume it from the sidebar.</p>
            ) : live?.summary ? (
              <p className="text-sm">
                {sentence(live.summary)}
                {live.status === "breaching" && live.checks && (
                  <span className="text-muted-foreground">
                    {" "}
                    · over its limit {plural(live.checks, "check", "checks")} in a row of {live.needed}
                  </span>
                )}
              </p>
            ) : (
              <p className="text-muted-foreground text-sm">
                {live ? "No traffic on the routes it covers in its window." : "Waiting for the watch's next check."}
              </p>
            )}
          </Section>

          <BacktestResult backtest={backtest} checksToOpen={rule.checksToOpen} />

          <Section title="Incidents it opened">
            {incidents.length === 0 ? (
              <p className="text-muted-foreground text-sm">None yet.</p>
            ) : (
              <ul className="-mx-2 flex flex-col">
                {incidents.map((i) => (
                  <li key={i.id}>
                    <Link
                      href={`/incidents/${i.id}`}
                      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted/50"
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
            <Fact label="Judged over">The last {windowLabel(rule.windowSeconds)}</Fact>
            <Fact label="Opens an incident after">
              {plural(rule.checksToOpen, "check", "checks")} in a row
              <span className="text-muted-foreground"> ({rule.checksToOpen * 10} seconds)</span>
            </Fact>
            {rule.condition.metric !== "slowCount" && (
              <Fact label="Minimum requests">{plural(rule.minRequests, "request", "requests")} per route</Fact>
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

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-medium text-sm">{title}</h2>
      {children}
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
