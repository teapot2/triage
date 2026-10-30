"use client";

import { LoaderCircleIcon } from "lucide-react";
import { notFound, useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  checkSchema,
  defaultCheck,
  describeCheck,
  MAX_CHECKS,
  type UptimeCheck,
  urlProblem,
} from "@/lib/investigation/uptime/model";
import { updateEndpoints, useChecks } from "./endpoint-client";
import { FormField, FormSection, NumberInput } from "./form-fields";
import { sentence } from "./watch-client";
import { WatchHeader } from "./watch-header";

// The form's draft: the check's fields as typed, numbers as text so a field
// can be empty while it's edited.
type Draft = {
  name: string;
  url: string;
  enabled: boolean;
  intervalSeconds: string;
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
  enabled: c.enabled,
  intervalSeconds: String(c.intervalSeconds),
  statusMin: String(c.expectedStatus.min),
  statusMax: String(c.expectedStatus.max),
  slowMs: String(c.slowMs),
  timeoutMs: String(c.timeoutMs),
  slowChecksToOpen: String(c.slowChecksToOpen),
  downMinutesToOpen: String(c.downMinutesToOpen),
  healthyChecksToRecover: String(c.healthyChecksToRecover),
});

type Field = "name" | "url" | "intervalSeconds" | "status" | "slowMs" | "timeoutMs" | "slowChecksToOpen" | "downMinutesToOpen" | "healthyChecksToRecover";

// Each number's field, range and the words for when it's out of it.
const numbers: { key: keyof Draft; field: Field; min: number; max: number; error: string }[] = [
  { key: "intervalSeconds", field: "intervalSeconds", min: 10, max: 300, error: "A whole number of seconds, from 10 to 300." },
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
// The server checks the URL again on save, with DNS.
function fromDraft(d: Draft, base: UptimeCheck): { check?: UptimeCheck; errors: Partial<Record<Field, string>> } {
  const errors: Partial<Record<Field, string>> = {};
  if (!d.name.trim()) errors.name = "Give the endpoint a name.";
  const url = d.url.trim();
  const problem = url ? urlProblem(url) : "enter a URL";
  if (problem) errors.url = `${sentence(problem)}. Use a full address, like https://www.google.com.`;
  const n: Partial<Record<keyof Draft, number>> = {};
  for (const { key, field, min, max, error } of numbers) {
    n[key] = parseNumber(d[key] as string, min, max);
    if (n[key] === undefined) errors[field] = error;
  }
  const min = parseNumber(d.statusMin, 100, 599);
  const max = parseNumber(d.statusMax, 100, 599);
  if (min === undefined || max === undefined) errors.status = "Status codes from 100 to 599.";
  else if (min > max) errors.status = "The lowest status can't be above the highest.";
  if (n.slowMs !== undefined && n.timeoutMs !== undefined && n.slowMs > n.timeoutMs) errors.slowMs = "The slow limit can't be past the point it gives up.";
  if (Object.keys(errors).length > 0) return { errors };

  const parsed = checkSchema.safeParse({
    ...base,
    name: d.name.trim(),
    url,
    enabled: d.enabled,
    intervalSeconds: n.intervalSeconds,
    timeoutMs: n.timeoutMs,
    slowMs: n.slowMs,
    expectedStatus: { min, max },
    slowChecksToOpen: n.slowChecksToOpen,
    downMinutesToOpen: n.downMinutesToOpen,
    healthyChecksToRecover: n.healthyChecksToRecover,
  });
  return parsed.success ? { check: parsed.data, errors } : { errors: { name: parsed.error.issues[0]?.message } };
}

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

// The check's fields in three sections and Save. A check changes only here,
// on purpose. Cancel with changes asks first, and so does leaving the page.
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
  const [discarding, setDiscarding] = useState(false);
  // Set once saved, so leaving for the next page doesn't warn.
  const [done, setDone] = useState(false);

  const { check: candidate, errors } = fromDraft(draft, base);
  // The draft as a check whatever its name, for the sentence in the header.
  const unnamed = fromDraft({ ...draft, name: draft.name.trim() || "Untitled" }, base).check;
  const shown = tried ? errors : {};
  const changed = JSON.stringify(draft) !== JSON.stringify(toDraft(base));
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const back = isNew ? "/watch" : `/watch/endpoints/${base.id}`;
  const full = isNew && count >= MAX_CHECKS;
  const urlError = shown.url ?? (refused?.url === draft.url.trim() ? refused.reason : undefined);

  useEffect(() => {
    if (!changed || done) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [changed, done]);

  async function save() {
    setTried(true);
    if (!candidate) return;
    setSaving(true);
    setError(undefined);
    const result = await updateEndpoints((checks) =>
      isNew ? [...checks, candidate] : checks.map((c) => (c.id === base.id ? candidate : c)),
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
      >
        {/* The check read back as it's edited; blank while a field is
            invalid (it says why), keeping its line so nothing jumps. */}
        <span className="min-h-5">{unnamed && describeCheck(unnamed)}</span>
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
        <FormSection title="What it checks">
          <FormField label="Name" htmlFor={`${id}-name`} error={shown.name}>
            <Input
              id={`${id}-name`}
              value={draft.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="Google"
              aria-invalid={Boolean(shown.name)}
              autoComplete="off"
            />
          </FormField>
          <FormField label="Checking" htmlFor={`${id}-enabled`}>
            <label className="flex h-8 items-center gap-2 text-sm">
              <Switch id={`${id}-enabled`} checked={draft.enabled} onCheckedChange={(v) => set("enabled", v)} />
              {draft.enabled ? "On" : "Paused"}
            </label>
          </FormField>
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
          <FormField label="Check every" htmlFor={`${id}-interval`} error={shown.intervalSeconds}>
            <NumberInput
              id={`${id}-interval`}
              unit="seconds"
              value={draft.intervalSeconds}
              onChange={(v) => set("intervalSeconds", v)}
              invalid={Boolean(shown.intervalSeconds)}
            />
          </FormField>
          <FormField label="Expected status" htmlFor={`${id}-status-min`} error={shown.status} hint="Any status in this range is a good answer.">
            <div className="flex items-center gap-2">
              <NumberInput
                id={`${id}-status-min`}
                unit="from"
                value={draft.statusMin}
                onChange={(v) => set("statusMin", v)}
                invalid={Boolean(shown.status)}
              />
              <NumberInput
                id={`${id}-status-max`}
                unit="to"
                value={draft.statusMax}
                onChange={(v) => set("statusMax", v)}
                invalid={Boolean(shown.status)}
              />
            </div>
          </FormField>
        </FormSection>

        <FormSection title="When it's slow">
          <FormField label="Slower than" htmlFor={`${id}-slow`} error={shown.slowMs} hint="A good answer past this is slow.">
            <NumberInput
              id={`${id}-slow`}
              unit="ms"
              value={draft.slowMs}
              onChange={(v) => set("slowMs", v)}
              invalid={Boolean(shown.slowMs)}
            />
          </FormField>
          <FormField label="Gives up after" htmlFor={`${id}-timeout`} error={shown.timeoutMs} hint="No answer by then is down.">
            <NumberInput
              id={`${id}-timeout`}
              unit="ms"
              value={draft.timeoutMs}
              onChange={(v) => set("timeoutMs", v)}
              invalid={Boolean(shown.timeoutMs)}
            />
          </FormField>
          <FormField
            label="Opens an incident after"
            htmlFor={`${id}-slow-checks`}
            error={shown.slowChecksToOpen}
            hint="Slow checks in a row. Severity SEV3."
          >
            <NumberInput
              id={`${id}-slow-checks`}
              unit="checks"
              value={draft.slowChecksToOpen}
              onChange={(v) => set("slowChecksToOpen", v)}
              invalid={Boolean(shown.slowChecksToOpen)}
            />
          </FormField>
        </FormSection>

        <FormSection title="When it's down">
          <FormField
            label="Opens an incident after"
            htmlFor={`${id}-down`}
            error={shown.downMinutesToOpen}
            hint="With no good answer. Severity SEV2."
          >
            <NumberInput
              id={`${id}-down`}
              unit="minutes"
              value={draft.downMinutesToOpen}
              onChange={(v) => set("downMinutesToOpen", v)}
              invalid={Boolean(shown.downMinutesToOpen)}
            />
          </FormField>
          <FormField
            label="Recovered after"
            htmlFor={`${id}-healthy`}
            error={shown.healthyChecksToRecover}
            hint="Good, fast checks in a row. One could be luck."
          >
            <NumberInput
              id={`${id}-healthy`}
              unit="checks"
              value={draft.healthyChecksToRecover}
              onChange={(v) => set("healthyChecksToRecover", v)}
              invalid={Boolean(shown.healthyChecksToRecover)}
            />
          </FormField>
        </FormSection>

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
