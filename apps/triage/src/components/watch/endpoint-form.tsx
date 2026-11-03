"use client";

import { LoaderCircleIcon } from "lucide-react";
import { notFound, useRouter } from "next/navigation";
import { type ReactNode, useEffect, useId, useState } from "react";
import { FormAdvanced, FormField, FormRow, FormRows, FormSection, NumberInput } from "@/components/form-fields";
import { SeverityBars, severityLabel } from "@/components/incident/status-badges";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  checkHost,
  checkSchema,
  DEFAULT_AUTH_HEADER,
  defaultCheck,
  describeCheck,
  MAX_CHECKS,
  originOf,
  ruleName,
  ruleSeverity,
  type UptimeCheck,
  type UptimeRule,
  urlProblem,
} from "@/lib/investigation/uptime/model";
import { updateEndpoints, useChecks } from "./endpoint-client";
import { plural, ReadBack, sentence } from "./watch-client";
import { WatchHeader } from "./watch-header";

// The form's draft: the check's fields as typed, numbers as text so a field
// can be empty while it's edited. The interval is picked, not typed. Whether
// it's paused isn't here: that's the Pause button on the endpoint's page.
// The auth header's value starts blank even when one is saved: the browser
// never gets it, and blank means keep it.
type Draft = {
  name: string;
  url: string;
  authHeader: string;
  authValue: string;
  intervalSeconds: number;
  statusMin: string;
  statusMax: string;
  slowMs: string;
  timeoutMs: string;
  slowChecksToOpen: string;
  downMinutesToOpen: string;
  healthyChecksToRecover: string;
};

const toDraft = (c: UptimeCheck): Draft => ({
  name: c.name,
  url: c.url,
  authHeader: c.auth?.header ?? "",
  authValue: "",
  intervalSeconds: c.intervalSeconds,
  statusMin: String(c.expectedStatus.min),
  statusMax: String(c.expectedStatus.max),
  slowMs: String(c.slowMs),
  timeoutMs: String(c.timeoutMs),
  slowChecksToOpen: String(c.slowChecksToOpen),
  downMinutesToOpen: String(c.downMinutesToOpen),
  healthyChecksToRecover: String(c.healthyChecksToRecover),
});

type Field = "name" | "url" | "auth" | "status" | "slowMs" | "timeoutMs" | "slowChecksToOpen" | "downMinutesToOpen" | "healthyChecksToRecover";

// The fields under Advanced, which opens when Save finds one of them wrong.
const advancedFields: Field[] = ["auth", "status", "healthyChecksToRecover"];

// Each typed number's field, range and the words for when it's out of it.
const numbers: { key: keyof Draft; field: Field; min: number; max: number; error: string }[] = [
  { key: "slowMs", field: "slowMs", min: 100, max: 30_000, error: "A whole number of milliseconds, from 100 to 30000." },
  { key: "timeoutMs", field: "timeoutMs", min: 1000, max: 30_000, error: "A whole number of milliseconds, from 1000 to 30000." },
  { key: "slowChecksToOpen", field: "slowChecksToOpen", min: 1, max: 10, error: "From 1 to 10 checks." },
  { key: "downMinutesToOpen", field: "downMinutesToOpen", min: 1, max: 30, error: "From 1 to 30 minutes." },
  { key: "healthyChecksToRecover", field: "healthyChecksToRecover", min: 2, max: 10, error: "From 2 to 10 checks." },
];

const parseNumber = (s: string, min: number, max: number) => {
  const n = Number(s);
  return s.trim() !== "" && Number.isInteger(n) && n >= min && n <= max ? n : undefined;
};

// The draft as a check, or what's wrong with it, field by field, in words.
// A blank name becomes the URL's host. The server checks the URL again on
// save, with DNS. An auth header with no value typed keeps the saved value
// (the server puts it back) while the URL stays on the saved origin; a
// token meant for one host doesn't follow the check to another.
function fromDraft(d: Draft, base: UptimeCheck): { check?: UptimeCheck; errors: Partial<Record<Field, string>> } {
  const errors: Partial<Record<Field, string>> = {};
  const url = d.url.trim();
  const problem = url ? urlProblem(url) : "enter a URL";
  if (problem) errors.url = `${sentence(problem)}. Use a full address, like https://www.google.com.`;
  const name = d.name.trim() || (problem ? "" : checkHost({ url }));
  if (!name && !problem) errors.name = "Give the endpoint a name.";
  const header = d.authHeader.trim() || (d.authValue ? DEFAULT_AUTH_HEADER : "");
  let auth: UptimeCheck["auth"];
  if (header && d.authValue) auth = { header, value: d.authValue };
  else if (header && base.auth && (problem || originOf(url) === originOf(base.url))) auth = { header };
  else if (header) {
    errors.auth = base.auth
      ? `The saved value was for ${checkHost(base)}. Enter the one for this address, or clear the header.`
      : "Enter the header's value, or clear the header.";
  }
  const n: Partial<Record<keyof Draft, number>> = {};
  for (const { key, field, min, max, error } of numbers) {
    n[key] = parseNumber(d[key] as string, min, max);
    if (n[key] === undefined) errors[field] = error;
  }
  const min = parseNumber(d.statusMin, 100, 599);
  const max = parseNumber(d.statusMax, 100, 599);
  if (min === undefined || max === undefined) errors.status = "Status codes from 100 to 599.";
  else if (min > max) errors.status = "The lowest status can't be above the highest.";
  if (n.slowMs !== undefined && n.timeoutMs !== undefined && n.slowMs > n.timeoutMs) {
    errors.slowMs = "Can't be past No answer within, under Down.";
  }
  if (Object.keys(errors).length > 0) return { errors };

  const parsed = checkSchema.safeParse({
    ...base,
    name,
    url,
    auth,
    intervalSeconds: d.intervalSeconds,
    timeoutMs: n.timeoutMs,
    slowMs: n.slowMs,
    expectedStatus: { min, max },
    slowChecksToOpen: n.slowChecksToOpen,
    downMinutesToOpen: n.downMinutesToOpen,
    healthyChecksToRecover: n.healthyChecksToRecover,
  });
  return parsed.success ? { check: parsed.data, errors } : { errors: { name: parsed.error.issues[0]?.message } };
}

const intervalOptions = [10, 30, 60, 120, 300];

const intervalLabel = (s: number) => (s % 60 === 0 ? plural(s / 60, "minute", "minutes") : `${s} seconds`);

// The Edit and New endpoint pages: loads the saved checks, then shows the
// form. A bad id is a 404 like a rule's.
export function EndpointForm({ id }: { id?: string }) {
  const { checks, error, retry } = useChecks();
  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Couldn&apos;t load the endpoints</AlertTitle>
        <AlertDescription className="break-words">{error}</AlertDescription>
        <AlertAction>
          <Button variant="outline" size="xs" onClick={retry}>
            Retry
          </Button>
        </AlertAction>
      </Alert>
    );
  }
  if (!checks) return <Skeleton className="h-96 w-full" />;
  const check = id ? checks.find((c) => c.id === id) : undefined;
  if (id && !check) notFound();
  return <EndpointFormBody check={check} count={checks.length} />;
}

// What it checks, the two rules that open incidents, and the rest folded
// under Advanced, then Save. A check changes only here, on purpose. Cancel
// with changes asks first, and so does leaving the page.
function EndpointFormBody({ check, count }: { check?: UptimeCheck; count: number }) {
  const isNew = !check;
  const id = useId();
  const router = useRouter();
  // A new check's id is minted here, so it exists before the server sees it.
  const [base] = useState(() => check ?? defaultCheck());
  const [draft, setDraft] = useState(() => toDraft(base));
  // Field errors show once Save has been tried, not while the first field
  // is still being typed.
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  // The server's reason for refusing the URL, until the URL changes.
  const [refused, setRefused] = useState<{ url: string; reason: string }>();
  const [advanced, setAdvanced] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  // Set once saved, so leaving for the next page doesn't warn.
  const [done, setDone] = useState(false);

  const { check: candidate, errors } = fromDraft(draft, base);
  const url = draft.url.trim();
  const urlOk = Boolean(url) && !urlProblem(url);
  // The draft as a check before it has a name or a URL, for the sentence in
  // the header, which says "the URL" until one is typed.
  const unnamed = fromDraft({ ...draft, name: "Untitled", url: urlOk ? url : "https://example.com" }, base).check;
  const shown = tried ? errors : {};
  const changed = JSON.stringify(draft) !== JSON.stringify(toDraft(base));
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const back = isNew ? "/watch" : `/watch/endpoints/${base.id}`;
  const full = isNew && count >= MAX_CHECKS;
  const urlError = shown.url ?? (refused?.url === url ? refused.reason : undefined);
  const intervals = intervalOptions.includes(draft.intervalSeconds)
    ? intervalOptions
    : [...intervalOptions, draft.intervalSeconds].sort((a, b) => a - b);
  const statusText = draft.statusMin === draft.statusMax ? draft.statusMin : `${draft.statusMin}–${draft.statusMax}`;
  const authHeader = draft.authHeader.trim() || (draft.authValue ? DEFAULT_AUTH_HEADER : "");
  const authText = authHeader ? ` · sends ${authHeader}` : "";

  useEffect(() => {
    if (!changed || done) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [changed, done]);

  async function save() {
    setTried(true);
    if (advancedFields.some((f) => errors[f])) setAdvanced(true);
    if (!candidate) return;
    setSaving(true);
    setError(undefined);
    // Paused or not is the server's, so a pause made meanwhile stays.
    const result = await updateEndpoints((checks) =>
      isNew ? [...checks, candidate] : checks.map((c) => (c.id === base.id ? { ...candidate, enabled: c.enabled } : c)),
    );
    setSaving(false);
    if (result.refused) return setRefused({ url: candidate.url, reason: result.error ?? "The server refused this URL." });
    if (result.error) return setError(result.error);
    if (!result.checks?.some((c) => c.id === base.id)) {
      return setError("This endpoint was deleted while you were editing it. Go back to Watch to add it again.");
    }
    setDone(true);
    router.push(`/watch/endpoints/${base.id}`);
    router.refresh();
  }

  function cancel() {
    if (changed) setDiscarding(true);
    else router.push(back);
  }

  return (
    <div className="flex flex-col gap-6">
      <WatchHeader
        crumbs={isNew ? [{ label: "Watch", href: "/watch" }] : [{ label: "Watch", href: "/watch" }, { label: base.name, href: back }]}
        current={isNew ? "New endpoint" : "Edit"}
        title={isNew ? "New endpoint" : `Edit ${base.name}`}
        divider={false}
      >
        <ReadBack text={unnamed && describeCheck(urlOk ? unnamed : { ...unnamed, url: "the URL" })} />
      </WatchHeader>

      {full && (
        <Alert>
          <AlertTitle>Up to {MAX_CHECKS} endpoints</AlertTitle>
          <AlertDescription>Delete one to add another.</AlertDescription>
        </Alert>
      )}

      <form
        className="flex flex-col gap-6"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <FormSection title="Endpoint">
          <FormField
            label="URL"
            htmlFor={`${id}-url`}
            error={urlError}
            hint="A public address. Triage sends it a GET request."
            wide
          >
            <Input
              id={`${id}-url`}
              type="url"
              value={draft.url}
              onChange={(e) => set("url", e.target.value)}
              placeholder="https://www.google.com"
              aria-invalid={Boolean(urlError)}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
            />
          </FormField>
          {/* Left blank, the name is the URL's host, which the placeholder
              shows once the URL reads as one. */}
          <FormField label="Name" htmlFor={`${id}-name`} error={shown.name}>
            <Input
              id={`${id}-name`}
              value={draft.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder={urlOk ? checkHost({ url }) : "Google"}
              aria-invalid={Boolean(shown.name)}
              autoComplete="off"
            />
          </FormField>
          <FormField label="Check every" htmlFor={`${id}-interval`}>
            <Select value={String(draft.intervalSeconds)} onValueChange={(v) => set("intervalSeconds", Number(v))}>
              <SelectTrigger id={`${id}-interval`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {intervals.map((s) => (
                  <SelectItem key={s} value={String(s)}>
                    {intervalLabel(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        </FormSection>

        {/* One row per rule, both on the same two columns: what counts on
            the left, how long it lasts on the right. */}
        <FormRows title="Opens an incident">
          <RuleRow rule="down">
            <FormField label="No answer within" htmlFor={`${id}-timeout`} error={shown.timeoutMs}>
              <NumberInput
                id={`${id}-timeout`}
                unit="ms"
                value={draft.timeoutMs}
                onChange={(v) => set("timeoutMs", v)}
                invalid={Boolean(shown.timeoutMs)}
              />
            </FormField>
            <FormField
              label="For"
              htmlFor={`${id}-down`}
              error={shown.downMinutesToOpen}
              hint="With no good answer: a timeout, an error or an unexpected status."
            >
              <NumberInput
                id={`${id}-down`}
                unit="minutes"
                value={draft.downMinutesToOpen}
                onChange={(v) => set("downMinutesToOpen", v)}
                invalid={Boolean(shown.downMinutesToOpen)}
              />
            </FormField>
          </RuleRow>
          <RuleRow rule="slow">
            <FormField label="Slower than" htmlFor={`${id}-slow`} error={shown.slowMs}>
              <NumberInput
                id={`${id}-slow`}
                unit="ms"
                value={draft.slowMs}
                onChange={(v) => set("slowMs", v)}
                invalid={Boolean(shown.slowMs)}
              />
            </FormField>
            <FormField label="For" htmlFor={`${id}-slow-checks`} error={shown.slowChecksToOpen}>
              <NumberInput
                id={`${id}-slow-checks`}
                unit="checks in a row"
                value={draft.slowChecksToOpen}
                onChange={(v) => set("slowChecksToOpen", v)}
                invalid={Boolean(shown.slowChecksToOpen)}
              />
            </FormField>
          </RuleRow>
        </FormRows>

        <FormAdvanced
          open={advanced}
          onOpenChange={setAdvanced}
          summary={`Expects ${statusText} · recovers after ${draft.healthyChecksToRecover === "1" ? "1 good check" : `${draft.healthyChecksToRecover} good checks`}${authText}`}
        >
          {/* For an endpoint behind a token. The value is typed blind and
              kept on the server: when one is saved, the field stays blank
              and says so, and typing replaces it. */}
          <FormField
            label="Credentials"
            htmlFor={`${id}-auth-value`}
            error={shown.auth}
            hint={
              base.auth
                ? "A header sent with every request. The saved value stays on the server; type one to replace it."
                : "A header sent with every request, like Authorization: Bearer …. The value stays on the server."
            }
            wide
          >
            <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-2">
              <Input
                id={`${id}-auth-header`}
                aria-label="Header name"
                value={draft.authHeader}
                onChange={(e) => set("authHeader", e.target.value)}
                placeholder={DEFAULT_AUTH_HEADER}
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
              />
              <Input
                id={`${id}-auth-value`}
                type="password"
                aria-label="Header value"
                value={draft.authValue}
                onChange={(e) => set("authValue", e.target.value)}
                placeholder={base.auth ? "Saved" : "Bearer …"}
                aria-invalid={Boolean(shown.auth)}
                autoComplete="new-password"
                spellCheck={false}
                className="font-mono"
              />
            </div>
          </FormField>
          <FormField label="Expected status" htmlFor={`${id}-status-min`} error={shown.status}>
            <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
              <NumberInput
                id={`${id}-status-min`}
                aria-label="Lowest expected status"
                value={draft.statusMin}
                onChange={(v) => set("statusMin", v)}
                invalid={Boolean(shown.status)}
              />
              <span className="text-muted-foreground text-sm">to</span>
              <NumberInput
                id={`${id}-status-max`}
                aria-label="Highest expected status"
                value={draft.statusMax}
                onChange={(v) => set("statusMax", v)}
                invalid={Boolean(shown.status)}
              />
            </div>
          </FormField>
          <FormField label="Recovered after" htmlFor={`${id}-healthy`} error={shown.healthyChecksToRecover}>
            <NumberInput
              id={`${id}-healthy`}
              unit="good checks in a row"
              value={draft.healthyChecksToRecover}
              onChange={(v) => set("healthyChecksToRecover", v)}
              invalid={Boolean(shown.healthyChecksToRecover)}
            />
          </FormField>
        </FormAdvanced>

        {error && (
          <Alert key={error} variant="destructive" dismissible dismissLabel="Dismiss error" onDismiss={() => setError(undefined)}>
            <AlertTitle>Couldn&apos;t save</AlertTitle>
            <AlertDescription className="break-words">{error}</AlertDescription>
          </Alert>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button type="button" variant="ghost" onClick={cancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving || full || (!isNew && !changed)}>
            {saving && <LoaderCircleIcon className="animate-spin" />}
            {isNew ? "Create endpoint" : "Save changes"}
          </Button>
        </div>
      </form>

      <AlertDialog open={discarding} onOpenChange={setDiscarding}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard your changes?</AlertDialogTitle>
            <AlertDialogDescription>
              {isNew ? "The new endpoint won't be created." : `${base.name} stays as it was.`}
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

// A rule's row: its name and the severity it opens at, over its two fields.
function RuleRow({ rule, children }: { rule: UptimeRule; children: ReactNode }) {
  const severity = ruleSeverity(rule);
  return (
    <FormRow
      title={ruleName(rule)}
      aside={
        <>
          <SeverityBars severity={severity} />
          {severity.toUpperCase()} · {severityLabel[severity]}
        </>
      }
    >
      {children}
    </FormRow>
  );
}
