"use client";

import { LoaderCircleIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { FormAdvanced, FormField, FormSection, NumberInput } from "@/components/form-fields";
import { SeverityBars, severityLabel } from "@/components/incident/status-badges";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  describeRule,
  metricOptions,
  ruleSchema,
  targetOptions,
  type WatchCondition,
  type WatchRule,
  type WatchTarget,
} from "@/lib/investigation/watch-rule-model";
import {
  alertText,
  allowanceText,
  burnAlerts,
  LATENCY_BUCKETS,
  type LatencyBucket,
  SLO_OBJECTIVES,
  SLO_WINDOW_DAYS,
  SLOW_BURN_SEVERITY,
  type SloWindowDays,
} from "@/lib/slo/model";
import { BacktestResult, ReadBack, sentence, updateRules, useBacktest, windowLabel } from "./watch-client";
import { WatchHeader } from "./watch-header";

// Where a new rule starts: the kind of rule that holds up at low traffic,
// more than a few requests slower than a limit, on every route.
const newRule: WatchRule = {
  id: "new",
  name: "",
  enabled: true,
  target: { kind: "all" },
  condition: { metric: "slowCount", slowerThanMs: 1000, moreThan: 5 },
  windowSeconds: 60,
  checksToOpen: 2,
  minRequests: 5,
  severity: "sev3",
};

// A rule id from its name: "Checkout errors" becomes checkout-errors, with a
// number added when that's taken. "new" is taken by the New rule page.
function newId(name: string, taken: string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 56) || "rule";
  const used = new Set([...taken, "new"]);
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  return id;
}

// The form's draft: the rule's fields as typed, numbers as text so a field
// can be empty while it's edited. Each condition's numbers keep their own
// field, so switching condition and back doesn't lose them.
type Draft = {
  name: string;
  targetKind: WatchTarget["kind"];
  route: string;
  metric: WatchCondition["metric"];
  ms: string;
  count: string;
  percent: string;
  windowSeconds: number;
  checksToOpen: string;
  minRequests: string;
  severity: WatchRule["severity"];
  // An SLO's, as its Selects hold them; good is "any" for every request
  // that succeeds, or the latency it must succeed within.
  objective: string;
  windowDays: string;
  good: string;
};

function toDraft(r: WatchRule): Draft {
  const c = r.condition;
  return {
    name: r.name,
    targetKind: r.target.kind,
    route: r.target.kind === "route" ? r.target.route : "",
    metric: c.metric,
    ms: String(c.metric === "p95" ? c.aboveMs : c.metric === "slowCount" || c.metric === "slowShare" ? c.slowerThanMs : 1000),
    count: String(c.metric === "slowCount" ? c.moreThan : 5),
    percent: String(c.metric === "slowShare" || c.metric === "errorRate" ? c.moreThanPercent : 5),
    windowSeconds: r.windowSeconds,
    checksToOpen: String(r.checksToOpen),
    minRequests: String(r.minRequests),
    severity: r.severity,
    objective: String(c.metric === "slo" ? c.objectivePercent : 99.9),
    windowDays: String(c.metric === "slo" ? c.windowDays : 30),
    good: c.metric !== "slo" ? "500" : c.latencyMs === undefined ? "any" : String(c.latencyMs),
  };
}

type Field = "name" | "route" | "ms" | "count" | "percent" | "checksToOpen" | "minRequests";

const parseNumber = (s: string, min: number, max: number, integer: boolean) => {
  const n = Number(s);
  const ok = s.trim() !== "" && Number.isFinite(n) && (!integer || Number.isInteger(n)) && n >= min && n <= max;
  return ok ? n : undefined;
};

// The draft as a rule, or what's wrong with it, field by field, in words.
// The server checks the rule again on save.
function fromDraft(d: Draft, base: WatchRule): { rule?: WatchRule; errors: Partial<Record<Field, string>> } {
  const errors: Partial<Record<Field, string>> = {};
  const name = d.name.trim();
  if (!name) errors.name = "Give the rule a name.";
  const route = d.route.trim();
  if (d.targetKind === "route" && !route.startsWith("/")) errors.route = "A route starts with /, like /api/products/[id] or /api/*.";
  const ms = parseNumber(d.ms, 1, 600_000, true);
  const count = parseNumber(d.count, 0, 100_000, true);
  const percent = parseNumber(d.percent, 0, 100, false);
  if (d.metric !== "errorRate" && d.metric !== "slo" && ms === undefined) errors.ms = "A whole number of milliseconds, from 1 to 600000.";
  if (d.metric === "slowCount" && count === undefined) errors.count = "A whole number of requests.";
  if ((d.metric === "slowShare" || d.metric === "errorRate") && percent === undefined) errors.percent = "A percentage from 0 to 100.";
  const checksToOpen = parseNumber(d.checksToOpen, 1, 10, true);
  if (checksToOpen === undefined) errors.checksToOpen = "From 1 to 10 checks.";
  const minRequests = parseNumber(d.minRequests, 1, 1000, true);
  if (d.metric !== "slowCount" && minRequests === undefined) errors.minRequests = "From 1 to 1000 requests.";
  if (Object.keys(errors).length > 0) return { errors };

  const target: WatchTarget = d.targetKind === "route" ? { kind: "route", route } : { kind: d.targetKind };
  const condition: WatchCondition =
    d.metric === "p95"
      ? { metric: "p95", aboveMs: ms! }
      : d.metric === "slowCount"
        ? { metric: "slowCount", slowerThanMs: ms!, moreThan: count! }
        : d.metric === "slowShare"
          ? { metric: "slowShare", slowerThanMs: ms!, moreThanPercent: percent! }
          : d.metric === "errorRate"
            ? { metric: "errorRate", moreThanPercent: percent! }
            : {
                metric: "slo",
                objectivePercent: Number(d.objective),
                windowDays: Number(d.windowDays) as SloWindowDays,
                ...(d.good === "any" ? {} : { latencyMs: Number(d.good) as LatencyBucket }),
              };
  const parsed = ruleSchema.safeParse({
    ...base,
    name,
    target,
    condition,
    windowSeconds: d.windowSeconds,
    checksToOpen,
    // A counting rule ignores it; keep what was there.
    minRequests: minRequests ?? base.minRequests,
    severity: d.severity,
  });
  return parsed.success ? { rule: parsed.data, errors } : { errors: { name: parsed.error.issues[0]?.message } };
}

const windowOptions = [30, 60, 120, 300, 600, 900];

const severities: WatchRule["severity"][] = ["sev1", "sev2", "sev3", "sev4"];

// The Edit and New rule pages: the rule's fields in three sections, the
// minimum traffic folded under Advanced, the backtest of the draft under
// them, and Save. A rule changes only here, on
// purpose. Cancel with changes asks first, and so does leaving the page
// (reload, close); the sidebar's links don't ask.
export function RuleForm({ rule }: { rule?: WatchRule }) {
  const isNew = !rule;
  const base = rule ?? newRule;
  const id = useId();
  const router = useRouter();
  const [draft, setDraft] = useState(() => toDraft(base));
  // Field errors show once Save has been tried, not while the first field
  // is still being typed.
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [advanced, setAdvanced] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  // Set once saved or deleted, so leaving for the next page doesn't warn.
  const [done, setDone] = useState(false);

  const { rule: candidate, errors } = fromDraft(draft, base);
  // The draft as a rule whatever its name, which neither the sentence in the
  // header nor the backtest uses, so a new rule shows both from the start.
  const unnamed = fromDraft({ ...draft, name: draft.name.trim() || "Untitled" }, base).rule;
  const shown = tried ? errors : {};
  const changed = JSON.stringify(draft) !== JSON.stringify(toDraft(base));
  const backtest = useBacktest(unnamed);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const back = isNew ? "/watch" : `/watch/${base.id}`;

  useEffect(() => {
    if (!changed || done) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [changed, done]);

  async function save() {
    setTried(true);
    if (errors.minRequests) setAdvanced(true);
    if (!candidate) return;
    setSaving(true);
    setError(undefined);
    let savedId = base.id;
    const result = await updateRules((rules) => {
      if (!isNew) return rules.map((r) => (r.id === base.id ? candidate : r));
      savedId = newId(candidate.name, rules.map((r) => r.id));
      return [...rules, { ...candidate, id: savedId }];
    });
    setSaving(false);
    if (result.error) return setError(result.error);
    if (!result.rules?.some((r) => r.id === savedId)) {
      return setError("This rule was deleted while you were editing it. Go back to Watch to add it again.");
    }
    setDone(true);
    router.push(`/watch/${savedId}`);
    router.refresh();
  }

  async function remove() {
    setError(undefined);
    const result = await updateRules((rules) => rules.filter((r) => r.id !== base.id));
    if (result.error) return setError(result.error);
    setDone(true);
    router.push("/watch");
    router.refresh();
  }

  function cancel() {
    if (changed) setDiscarding(true);
    else router.push(back);
  }

  const windows = windowOptions.includes(draft.windowSeconds)
    ? windowOptions
    : [...windowOptions, draft.windowSeconds].sort((a, b) => a - b);
  // A rule saved by hand can hold an objective the list doesn't.
  const objectives: number[] = (SLO_OBJECTIVES as readonly number[]).includes(Number(draft.objective))
    ? [...SLO_OBJECTIVES]
    : [...SLO_OBJECTIVES, Number(draft.objective)].sort((a, b) => a - b);
  const isSlo = draft.metric === "slo";

  return (
    <div className="flex flex-col gap-6">
      <WatchHeader
        crumbs={isNew ? [{ label: "Watch", href: "/watch" }] : [{ label: "Watch", href: "/watch" }, { label: base.name, href: back }]}
        current={isNew ? "New rule" : "Edit"}
        title={isNew ? "New rule" : `Edit ${base.name}`}
        divider={false}
      >
        <ReadBack text={unnamed && sentence(describeRule(unnamed))} />
      </WatchHeader>

      <form
        className="flex flex-col gap-6"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {/* Every section is the same two-column grid, every control fills
            its cell, and numbers carry their unit inside the field, so the
            edges line up from top to bottom. The header reads the rule back
            as a sentence while it's edited. */}
        <FormSection title="Rule">
          <FormField label="Name" htmlFor={`${id}-name`} error={shown.name}>
            <Input
              id={`${id}-name`}
              value={draft.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="Checkout errors"
              aria-invalid={Boolean(shown.name)}
              autoComplete="off"
            />
          </FormField>
          <FormField label="Routes" htmlFor={`${id}-target`}>
            <Select value={draft.targetKind} onValueChange={(v) => set("targetKind", v as WatchTarget["kind"])}>
              <SelectTrigger id={`${id}-target`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {targetOptions.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          {draft.targetKind === "route" && (
            <FormField
              label="Route or pattern"
              htmlFor={`${id}-route`}
              error={shown.route}
              hint="A trailing * matches the rest."
              wide
            >
              <Input
                id={`${id}-route`}
                value={draft.route}
                onChange={(e) => set("route", e.target.value)}
                placeholder="/api/products/[id] or /api/*"
                aria-invalid={Boolean(shown.route)}
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
              />
            </FormField>
          )}
        </FormSection>

        <FormSection title="Condition">
          <FormField label="Measure" htmlFor={`${id}-metric`}>
            <Select value={draft.metric} onValueChange={(v) => set("metric", v as WatchCondition["metric"])}>
              <SelectTrigger id={`${id}-metric`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {metricOptions.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          {/* The condition's numbers, each in its own cell beside it. */}
          {draft.metric === "p95" && (
            <FormField label="p95 above" htmlFor={`${id}-ms`} error={shown.ms}>
              <NumberInput id={`${id}-ms`} unit="ms" value={draft.ms} onChange={(v) => set("ms", v)} invalid={Boolean(shown.ms)} />
            </FormField>
          )}
          {(draft.metric === "slowCount" || draft.metric === "slowShare") && (
            <FormField label="Slower than" htmlFor={`${id}-ms`} error={shown.ms}>
              <NumberInput id={`${id}-ms`} unit="ms" value={draft.ms} onChange={(v) => set("ms", v)} invalid={Boolean(shown.ms)} />
            </FormField>
          )}
          {draft.metric === "slowCount" && (
            <FormField label="More than" htmlFor={`${id}-count`} error={shown.count}>
              <NumberInput
                id={`${id}-count`}
                unit="slow requests"
                value={draft.count}
                onChange={(v) => set("count", v)}
                invalid={Boolean(shown.count)}
              />
            </FormField>
          )}
          {draft.metric === "slowShare" && (
            <FormField label="More than" htmlFor={`${id}-percent`} error={shown.percent}>
              <NumberInput
                id={`${id}-percent`}
                unit="% of requests"
                value={draft.percent}
                onChange={(v) => set("percent", v)}
                invalid={Boolean(shown.percent)}
              />
            </FormField>
          )}
          {isSlo && (
            <FormField label="Good when" htmlFor={`${id}-good`}>
              <Select value={draft.good} onValueChange={(v) => set("good", v)}>
                <SelectTrigger id={`${id}-good`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">It succeeds</SelectItem>
                  {LATENCY_BUCKETS.map((ms) => (
                    <SelectItem key={ms} value={String(ms)}>
                      It succeeds within {ms} ms
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          )}
          {/* An objective and its window read as a pair: "99.9% over 30
              days". What that leaves to spend is the hint, since it's the
              number people weigh an objective by. */}
          {isSlo && (
            <FormField
              label="Objective"
              htmlFor={`${id}-objective`}
              hint={`Leaves ${allowanceText(Number(draft.objective), Number(draft.windowDays))}.`}
            >
              <Select value={draft.objective} onValueChange={(v) => set("objective", v)}>
                <SelectTrigger id={`${id}-objective`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {objectives.map((o) => (
                    <SelectItem key={o} value={String(o)}>
                      {o}% of requests good
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          )}
          {isSlo && (
            <FormField label="Over" htmlFor={`${id}-days`}>
              <Select value={draft.windowDays} onValueChange={(v) => set("windowDays", v)}>
                <SelectTrigger id={`${id}-days`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SLO_WINDOW_DAYS.map((days) => (
                    <SelectItem key={days} value={String(days)}>
                      The last {days} days
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          )}
          {draft.metric === "errorRate" && (
            <FormField label="Error rate above" htmlFor={`${id}-percent`} error={shown.percent}>
              <NumberInput
                id={`${id}-percent`}
                unit="%"
                value={draft.percent}
                onChange={(v) => set("percent", v)}
                invalid={Boolean(shown.percent)}
              />
            </FormField>
          )}
          {/* An SLO is judged over its alerts' windows, not one of these. */}
          {!isSlo && (
            <FormField label="Judged over" htmlFor={`${id}-window`}>
              <Select value={String(draft.windowSeconds)} onValueChange={(v) => set("windowSeconds", Number(v))}>
                <SelectTrigger id={`${id}-window`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {windows.map((s) => (
                    <SelectItem key={s} value={String(s)}>
                      The last {windowLabel(s)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          )}
        </FormSection>

        <FormSection title="Opens an incident">
          {/* An SLO's alerts are the SRE Workbook's, fixed: read back, not
              edited. Each needs both its windows burning past the rate. */}
          {isSlo ? (
            <FormField label="When its budget burns" info="Over both windows, so an alert stops soon after the burn does. 1× spends exactly the budget over the objective's window.">
              <p className="py-1.5 text-sm">
                {burnAlerts
                  .filter((a) => a.speed === "fast")
                  .map((a) => alertText(a, Number(draft.windowDays)))
                  .join(", or ")}
              </p>
            </FormField>
          ) : (
            <FormField label="After" htmlFor={`${id}-checks`} error={shown.checksToOpen} hint="The watch checks every 10 seconds.">
              <NumberInput
                id={`${id}-checks`}
                unit="checks in a row"
                value={draft.checksToOpen}
                onChange={(v) => set("checksToOpen", v)}
                invalid={Boolean(shown.checksToOpen)}
              />
            </FormField>
          )}
          <FormField
            label="Severity"
            htmlFor={`${id}-severity`}
            hint={
              isSlo
                ? `A slow burn (${alertText(burnAlerts[2], Number(draft.windowDays))}) opens a ${SLOW_BURN_SEVERITY.toUpperCase()}.`
                : undefined
            }
          >
            <Select value={draft.severity} onValueChange={(v) => set("severity", v as WatchRule["severity"])}>
              <SelectTrigger id={`${id}-severity`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {severities.map((s) => (
                  <SelectItem key={s} value={s}>
                    <SeverityBars severity={s} />
                    {s.toUpperCase()} · {severityLabel[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        </FormSection>

        {/* A counting rule judges any traffic, so it has nothing here. */}
        {draft.metric !== "slowCount" && (
          <FormAdvanced
            open={advanced}
            onOpenChange={setAdvanced}
            summary={`Judges a route with at least ${draft.minRequests === "1" ? "1 request" : `${draft.minRequests} requests`} in ${isSlo ? "an alert's long window" : "the window"}`}
          >
            <FormField
              label="Minimum requests"
              htmlFor={`${id}-min`}
              error={shown.minRequests}
              hint={isSlo ? "An alert doesn't judge a route with fewer in its long window." : "A route with fewer in the window isn't judged."}
            >
              <NumberInput
                id={`${id}-min`}
                unit="requests"
                value={draft.minRequests}
                onChange={(v) => set("minRequests", v)}
                invalid={Boolean(shown.minRequests)}
              />
            </FormField>
          </FormAdvanced>
        )}

        {unnamed && <BacktestResult backtest={backtest} rule={unnamed} />}

        {error && (
          <Alert key={error} variant="destructive" dismissible dismissLabel="Dismiss error" onDismiss={() => setError(undefined)}>
            <AlertTitle>Couldn&apos;t save</AlertTitle>
            <AlertDescription className="break-words">{error}</AlertDescription>
          </Alert>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2">
          {isNew ? <span /> : <DeleteRule name={base.name} onConfirm={() => void remove()} disabled={saving} />}
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={cancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || (!isNew && !changed)}>
              {saving && <LoaderCircleIcon className="animate-spin" />}
              {isNew ? "Create rule" : "Save changes"}
            </Button>
          </div>
        </div>
      </form>

      <AlertDialog open={discarding} onOpenChange={setDiscarding}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard your changes?</AlertDialogTitle>
            <AlertDialogDescription>
              {isNew ? "The new rule won't be created." : `${base.name} stays as it was.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setDone(true);
                router.push(back);
              }}
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// Deletes the rule after a confirm. An incident it already opened stays.
function DeleteRule({ name, onConfirm, disabled }: { name: string; onConfirm: () => void; disabled?: boolean }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button type="button" variant="ghost" disabled={disabled}>
          Delete rule
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
          <AlertDialogDescription>
            The watch stops checking it, and an incident it already opened stays. To stop it for a while instead, pause it.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            Delete rule
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
