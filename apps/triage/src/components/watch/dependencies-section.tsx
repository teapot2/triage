"use client";

import { ChevronRightIcon, ExternalLinkIcon, LoaderCircleIcon, PackageSearchIcon, SettingsIcon, ShieldCheckIcon } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useId, useState } from "react";
import { toast } from "sonner";
import { ExportMenu } from "@/components/export-menu";
import { FormField } from "@/components/form-fields";
import { IncidentStatusBadge } from "@/components/incident/status-badges";
import { Timestamp } from "@/components/timestamp";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { dependencyFindings } from "@/lib/export/datasets/dependencies";
import {
  type AdvisorySeverity,
  type DependencySettings,
  intervalChoices,
  opensIncident,
  type SeverityCounts,
  severities,
  severityFloors,
  severityLabel,
  severityRank,
  type StoredFinding,
} from "@/lib/investigation/dependencies/model";
import type { IncidentStatus } from "@/lib/investigation/schema";
import { cn } from "@/lib/utils";
import {
  AdvisorySeverityBadge,
  auditNow,
  Chain,
  type DependencyData,
  type DependencyState,
  floorLabel,
  intervalLabel,
  saveDependencySettings,
  until,
  useDependencies,
} from "./dependency-client";
import { ago, useClock } from "./endpoint-client";

// The Watch page's Dependencies section: the audit of the watched service's
// dependencies (its package manager's own audit, every few hours while the
// watch is on, or now), what it found, and its settings, edited in place.
// Read top down, it answers in order of what matters: a sentence on whether
// anything needs attention, then one line per runtime advisory (an open
// incident's first), each opening to its title, how it gets in and why it
// opened nothing. Dev-only advisories and the ones fixed this week stay
// folded; the settings open from the header.
export function DependenciesSection() {
  const { data, error, refresh, replace } = useDependencies();
  return (
    <section id="dependencies" aria-labelledby="dependencies-heading" className="flex scroll-mt-16 flex-col gap-3">
      <div className="flex min-h-6 items-center justify-between gap-3">
        <h2 id="dependencies-heading" className="font-medium text-sm">
          Dependencies
        </h2>
        {data && (
          <div className="flex items-center gap-2">
            <AuditNowButton state={data.state} refresh={refresh} />
            <SettingsDialog settings={data.state.settings} replace={replace} />
            {data.findings.length > 0 && (
              <ExportMenu size="xs" exports={[{ dataset: dependencyFindings, params: { service: data.state.service } }]} />
            )}
          </div>
        )}
      </div>
      {error && !data ? (
        <Alert variant="destructive">
          <AlertTitle>Couldn&apos;t load the dependency audit</AlertTitle>
          <AlertDescription className="break-words">{error}</AlertDescription>
          <AlertAction>
            <Button variant="outline" size="xs" onClick={refresh}>
              Retry
            </Button>
          </AlertAction>
        </Alert>
      ) : !data ? (
        <DependenciesSkeleton />
      ) : (
        <DependenciesBox data={data} />
      )}
    </section>
  );
}

function DependenciesSkeleton() {
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4" aria-busy="true">
      <Skeleton className="h-4 w-64" />
      <Skeleton className="h-3 w-48" />
    </div>
  );
}

function AuditNowButton({ state, refresh }: { state: DependencyState; refresh: () => void }) {
  const [pending, setPending] = useState(false);
  const running = pending || state.auditing;
  async function run() {
    setPending(true);
    const result = await auditNow();
    setPending(false);
    refresh();
    if (result.error) toast.error("Couldn't audit the dependencies", { description: result.error });
    else if (result.audit?.error) toast.error("The audit failed", { description: result.audit.error });
  }
  return (
    <Button variant="outline" size="xs" onClick={() => void run()} disabled={running}>
      {running ? <LoaderCircleIcon className="animate-spin" /> : <PackageSearchIcon />}
      {running ? "Auditing…" : "Audit now"}
    </Button>
  );
}

function DependenciesBox({ data }: { data: DependencyData }) {
  const { state, findings, incidents = {} } = data;
  const floor = state.settings.severityFloor;
  const open = findings.filter((f) => !f.goneAt);
  const runtime = open.filter((f) => !f.dev).toSorted(byUrgency);
  const dev = open.filter((f) => f.dev).toSorted(byUrgency);
  const gone = findings.filter((f) => f.goneAt).toSorted((a, b) => Date.parse(b.goneAt!) - Date.parse(a.goneAt!));
  return (
    <div className="divide-y overflow-hidden rounded-lg border">
      <AuditSummary state={state} findings={open} />
      {runtime.length > 0 && (
        <ul aria-label="Advisories on runtime dependencies" className="divide-y">
          {runtime.map((f) => (
            <FindingRow key={f.advisoryId} finding={f} floor={floor} incident={f.incidentId ? incidents[f.incidentId] : undefined} />
          ))}
        </ul>
      )}
      {dev.length > 0 && (
        <Folded label={`${dev.length} dev-only ${dev.length === 1 ? "advisory" : "advisories"}`} hint="never runs in production">
          <ul aria-label="Advisories on dev dependencies" className="divide-y border-t">
            {dev.map((f) => (
              <FindingRow key={f.advisoryId} finding={f} floor={floor} />
            ))}
          </ul>
        </Folded>
      )}
      {gone.length > 0 && (
        <Folded label={`${gone.length} fixed this week`}>
          <ul aria-label="Advisories fixed this week" className="flex flex-col gap-1.5 border-t px-4 py-3">
            {gone.map((f) => (
              <GoneRow key={f.advisoryId} finding={f} />
            ))}
          </ul>
        </Folded>
      )}
    </div>
  );
}

// Open incidents first, then the most severe; ties by package.
function byUrgency(a: StoredFinding, b: StoredFinding): number {
  return (
    Number(!!b.incidentId) - Number(!!a.incidentId) ||
    severityRank(b.severity) - severityRank(a.severity) ||
    a.package.localeCompare(b.package)
  );
}

// "2 moderate advisories", "1 high and 2 moderate advisories".
function describeCounts(counts: SeverityCounts): string {
  const found = severities.toReversed().filter((s) => counts[s] > 0);
  const n = found.reduce((sum, s) => sum + counts[s], 0);
  const parts = found.map((s) => `${counts[s]} ${severityLabel(s).toLowerCase()}`);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
  return `${list} ${n === 1 ? "advisory" : "advisories"}`;
}

const countBySeverity = (findings: StoredFinding[]) => {
  const counts = Object.fromEntries(severities.map((s) => [s, 0])) as SeverityCounts;
  for (const f of findings) counts[f.severity]++;
  return counts;
};

// The audit in two lines: whether anything needs attention, in a sentence,
// then the service, its package manager, and when it last and next runs.
function AuditSummary({ state, findings }: { state: DependencyState; findings: StoredFinding[] }) {
  const now = useClock();
  const last = state.lastAudit;
  const floor = state.settings.severityFloor;
  const runtime = findings.filter((f) => !f.dev);
  const withIncident = runtime.filter((f) => f.incidentId).length;
  const overFloor = runtime.filter((f) => !f.incidentId && opensIncident(f, floor)).length;

  let verdict: ReactNode;
  if (!last) {
    verdict = (
      <span className="text-muted-foreground">
        Not audited yet. Triage runs {state.service}&apos;s package manager audit{" "}
        {intervalLabel(state.settings.intervalHours).toLowerCase()} while the watch is on, and opens an incident for a
        runtime dependency&apos;s advisory at {floorLabel(floor).toLowerCase()}.
      </span>
    );
  } else if (last.error) {
    verdict = (
      <span className="text-[color-mix(in_oklab,var(--destructive)_80%,black)] dark:text-destructive">
        The last audit failed: {last.error}
      </span>
    );
  } else if (findings.length === 0) {
    verdict = (
      <span className="flex items-center gap-2">
        <ShieldCheckIcon className="size-4 shrink-0 text-success" aria-hidden />
        No known advisories in {state.service}&apos;s dependencies.
      </span>
    );
  } else {
    // "high or above", "critical".
    const bar = floor === "critical" ? "critical" : `${severityLabel(floor).toLowerCase()} or above`;
    const lead =
      withIncident > 0
        ? `${withIncident} ${withIncident === 1 ? "advisory has" : "advisories have"} an open incident.`
        : overFloor > 0
          ? `${overFloor} at ${bar}, no incident yet.`
          : `Nothing at ${bar}.`;
    verdict = (
      <>
        {lead}{" "}
        {runtime.length > 0 && (
          <span className="text-muted-foreground">{describeCounts(countBySeverity(runtime))} on runtime dependencies.</span>
        )}
      </>
    );
  }

  // The schedule as it's set, so the settings read without opening them:
  // "every 6 h · next in 5 h 30 min".
  const next =
    state.status === "paused"
      ? "no scheduled audits while the watch is paused"
      : !state.settings.enabled
        ? "scheduled audits off"
        : [intervalLabel(state.settings.intervalHours).toLowerCase(), state.nextAt && `next ${until(state.nextAt, now)}`]
            .filter(Boolean)
            .join(" · ");
  return (
    <div className="flex flex-col gap-1 px-4 py-3">
      <p className="text-sm">{verdict}</p>
      <p className="text-muted-foreground text-xs">
        {[state.service, last?.packageManager].filter(Boolean).join(" · ")}
        {last && (
          <>
            {" · audited "}
            <Timestamp date={last.at}>{ago(last.at, now)}</Timestamp>
          </>
        )}
        {next && ` · ${next}`}
      </p>
      {state.error && (
        <Alert variant="warning" className="mt-2">
          <AlertTitle>The last audit&apos;s findings opened nothing</AlertTitle>
          <AlertDescription className="break-words">{state.error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

// "glob 10.5.0", "minimatch 10.2.6 +2 versions".
function PackageVersions({ finding: f, struck = false }: { finding: StoredFinding; struck?: boolean }) {
  const [first, ...more] = f.versions;
  return (
    <span className={cn("font-mono text-[13px]", struck && "text-muted-foreground line-through")}>
      {f.package} {first}
      {more.length > 0 && (
        <span className="font-sans text-muted-foreground text-xs">
          {" "}
          +{more.length} {more.length === 1 ? "version" : "versions"}
        </span>
      )}
    </span>
  );
}

// How the advisory gets into the service: "the service's own dependency",
// "through @opentelemetry/auto-instrumentations-node, 6 hops".
function reach(f: StoredFinding): string {
  if (f.paths.some((p) => !p.includes(">"))) return "the service's own dependency";
  const [via, ...more] = f.direct;
  const hops = f.paths[0] ? f.paths[0].split(">").length - 1 : 0;
  const others = more.length ? ` and ${more.length} other ${more.length === 1 ? "dependency" : "dependencies"}` : "";
  return `through ${via}${others}, ${hops} ${hops === 1 ? "hop" : "hops"}`;
}

// One advisory in a line: its severity, the package and versions, a short
// title, and on the right its incident's status, or the range that fixes
// it. Opening it shows the full title, how the package gets in (the
// chains), why it opened no incident, when it was first found, and the
// advisory itself.
function FindingRow({
  finding: f,
  floor,
  incident,
}: {
  finding: StoredFinding;
  floor: DependencySettings["severityFloor"];
  incident?: IncidentStatus;
}) {
  const why = f.dev ? "dev only" : `below ${severityLabel(floor).toLowerCase()}`;
  return (
    <li>
      <Collapsible className="group/finding">
        <CollapsibleTrigger className="grid w-full grid-cols-[5.5rem_minmax(0,1fr)_auto_1rem] items-center gap-3 px-4 py-2.5 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset">
          <AdvisorySeverityBadge severity={f.severity} />
          <span className="min-w-0 truncate text-sm">
            <PackageVersions finding={f} />
            {f.title && <span className="text-muted-foreground"> · {f.title}</span>}
          </span>
          {incident ? (
            <IncidentStatusBadge status={incident} />
          ) : (
            <span className="text-muted-foreground text-xs">
              {f.patched ? (
                <>
                  fix <span className="font-mono">{f.patched}</span>
                </>
              ) : (
                "no fix published"
              )}
            </span>
          )}
          <ChevronRightIcon
            aria-hidden
            className="size-4 text-muted-foreground transition-[rotate] duration-200 group-data-[state=open]/finding:rotate-90 motion-reduce:transition-none"
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="flex flex-col gap-1.5 pr-4 pb-3 pl-4 text-xs sm:pl-[calc(5.5rem+1.75rem)]">
            {f.title && <p className="text-sm">{f.title}</p>}
            <p className="text-muted-foreground">
              {f.dev ? "Dev only" : "Runtime"}, {reach(f)}
            </p>
            {f.paths.length > 0 && !f.paths.some((p) => !p.includes(">")) && <ChainList paths={f.paths} />}
            <p className="flex flex-wrap items-center gap-x-1.5 text-muted-foreground">
              {f.incidentId ? (
                <Link href={`/incidents/${f.incidentId}`} className="font-mono text-foreground hover:underline">
                  {f.incidentId}
                </Link>
              ) : (
                <span>{opensIncident(f, floor) ? "No incident yet" : `No incident: ${why}`}</span>
              )}
              <span aria-hidden>·</span>
              <span>
                first found <Timestamp date={f.firstSeen} />
              </span>
              <span aria-hidden>·</span>
              <a
                href={f.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded-sm font-mono outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                {f.advisoryId}
                <ExternalLinkIcon className="size-3" aria-hidden />
                <span className="sr-only">(opens the advisory)</span>
              </a>
            </p>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

// Every chain that pulls the package in, closed until asked for: the line
// above already names the service's own dependency it comes through.
function ChainList({ paths }: { paths: string[] }) {
  return (
    <Collapsible className="group/chains flex flex-col gap-1">
      <CollapsibleTrigger className="flex items-center gap-0.5 self-start rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">
        <ChevronRightIcon
          aria-hidden
          className="size-3.5 transition-[rotate] duration-200 group-data-[state=open]/chains:rotate-90 motion-reduce:transition-none"
        />
        {paths.length === 1 ? "Show the chain" : `Show ${paths.length} chains`}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="flex flex-col gap-1 pt-0.5">
          {paths.map((p) => (
            <li key={p}>
              <Chain chain={p} />
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

// One an audit stopped finding, in a line: the package struck through, its
// severity, when it went, and the incident it had opened.
function GoneRow({ finding: f }: { finding: StoredFinding }) {
  return (
    <li className="flex flex-wrap items-center gap-x-1.5 text-muted-foreground text-xs">
      <PackageVersions finding={f} struck />
      <span>
        · {severityLabel(f.severity).toLowerCase()} · gone <Timestamp date={f.goneAt!} />
      </span>
      {f.incidentId && (
        <>
          <span aria-hidden>·</span>
          <Link href={`/incidents/${f.incidentId}`} className="font-mono text-foreground hover:underline">
            {f.incidentId}
          </Link>
        </>
      )}
    </li>
  );
}

// A group kept closed until asked for: dev-only advisories, fixed ones.
function Folded({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <Collapsible className="group/folded">
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 px-4 py-2.5 text-left text-muted-foreground text-sm outline-none transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset">
        <ChevronRightIcon
          aria-hidden
          className="size-4 transition-[rotate] duration-200 group-data-[state=open]/folded:rotate-90 motion-reduce:transition-none"
        />
        {label}
        {hint && <span className="text-xs">· {hint}</span>}
      </CollapsibleTrigger>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}

// The audit's settings, in a dialog from the section's header (see the
// Forms notes in AGENTS.md: a settings row in the list read as one of its
// advisories). Two pickers and a line: the schedule (off, or how often),
// the severity that opens an incident, and the checkout it audits, edited
// only when asked. No hints: its readers know what an audit and a severity
// floor are. Saved together. What they're set to reads in the summary line
// and the verdict, so the dialog is only for changing them.
function SettingsDialog({ settings, replace }: { settings: DependencySettings; replace: (state: DependencyState) => void }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(settings);
  const [editingDir, setEditingDir] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const dir = (s: DependencySettings) => s.serviceDir?.trim() ?? "";
  const dirty =
    draft.enabled !== settings.enabled ||
    draft.intervalHours !== settings.intervalHours ||
    draft.severityFloor !== settings.severityFloor ||
    dir(draft) !== dir(settings);

  // Opening starts from what's saved; closing drops the draft.
  const openChange = (next: boolean) => {
    if (next) {
      setDraft(settings);
      setEditingDir(false);
    }
    setError(undefined);
    setOpen(next);
  };
  async function save() {
    setSaving(true);
    setError(undefined);
    const result = await saveDependencySettings({
      enabled: draft.enabled,
      intervalHours: draft.intervalHours,
      severityFloor: draft.severityFloor,
      serviceDir: dir(draft),
    });
    setSaving(false);
    if (result.error || !result.state) {
      setError(result.error ?? "The server didn't answer with the saved settings.");
      return;
    }
    replace(result.state);
    setDraft(result.state.settings);
    setOpen(false);
    toast.success("Audit settings saved");
  }

  // Off keeps the interval, so turning the schedule back on restores it.
  const schedule = draft.enabled ? String(draft.intervalHours) : "off";
  const setSchedule = (v: string) =>
    setDraft(v === "off" ? { ...draft, enabled: false } : { ...draft, enabled: true, intervalHours: Number(v) });
  return (
    <Dialog open={open} onOpenChange={openChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="xs">
          <SettingsIcon />
          Settings
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Audit settings</DialogTitle>
        </DialogHeader>
        <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
          <FormField label="Schedule" htmlFor={`${id}-schedule`}>
            <Select value={schedule} onValueChange={setSchedule}>
              <SelectTrigger id={`${id}-schedule`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="off">Off</SelectItem>
                {intervalChoicesWith(draft.intervalHours).map((h) => (
                  <SelectItem key={h} value={String(h)}>
                    {intervalLabel(h)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <FormField label="Opens an incident at" htmlFor={`${id}-floor`}>
            <Select
              value={draft.severityFloor}
              onValueChange={(v) => setDraft({ ...draft, severityFloor: v as DependencySettings["severityFloor"] })}
            >
              <SelectTrigger id={`${id}-floor`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {severityFloors.map((s) => (
                  <SelectItem key={s} value={s}>
                    {floorLabel(s as AdvisorySeverity)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        </div>
        {editingDir ? (
          <FormField
            label="Service directory"
            htmlFor={`${id}-dir`}
            optional
            info="The folder with the service's package.json, where the audit runs. Empty audits Shopfront's checkout (SHOPFRONT_DIR). Findings are filed under the folder's name."
          >
            <Input
              id={`${id}-dir`}
              value={draft.serviceDir ?? ""}
              onChange={(e) => setDraft({ ...draft, serviceDir: e.target.value })}
              placeholder="Shopfront's checkout (SHOPFRONT_DIR)"
              className="font-mono"
              maxLength={1000}
              spellCheck={false}
              autoFocus
            />
          </FormField>
        ) : (
          <p className="text-muted-foreground text-xs">
            Audits <span className={cn(dir(draft) && "font-mono")}>{dir(draft) || "Shopfront's checkout"}</span>
            {" · "}
            <button type="button" onClick={() => setEditingDir(true)} className="rounded-sm underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50">
              Change
            </button>
          </p>
        )}
        {error && (
          <p role="alert" className="break-words text-[color-mix(in_oklab,var(--destructive)_80%,black)] text-sm dark:text-destructive">
            Couldn&apos;t save: {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => openChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={!dirty || saving}>
            {saving && <LoaderCircleIcon className="animate-spin" />}
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// The picker's hours, with a saved value outside them (set through the API)
// kept so the Select can show it.
const choices: readonly number[] = intervalChoices;
const intervalChoicesWith = (hours: number) => (choices.includes(hours) ? choices : [...choices, hours].toSorted((a, b) => a - b));
