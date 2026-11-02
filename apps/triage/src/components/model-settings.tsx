"use client";

import { ChevronRightIcon, LoaderCircleIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { FormField } from "@/components/form-fields";
import { StageRow, useModelList } from "@/components/model-stage-row";
import { DisclosureFooter, DisclosureRow, ListGroup, SettingsSectionHeader } from "@/components/settings-list";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import type { PublicModelSettings } from "@/lib/models/settings";
import { type StageId, stageIds, stageLabels } from "@/lib/models/stages";
import { errorMessage } from "@/lib/errors";

export type Provider = PublicModelSettings["providers"][number];
export type StageModel = PublicModelSettings["stages"][keyof PublicModelSettings["stages"]];
// A stage saved without an effort (a preset) goes back to its default.
export type ModelUpdate = {
  stages?: Partial<Record<StageId, Omit<StageModel, "effort"> & Partial<Pick<StageModel, "effort">>>>;
  fanout?: boolean;
  webSearch?: boolean;
  endpoints?: Partial<Record<Provider["id"], { baseUrl?: string; apiKey?: string }>>;
};
// Saves an update and resolves to an error message, or nothing on success.
export type SaveModelSettings = (update: ModelUpdate) => Promise<string | undefined>;

// The Models and Providers sections of Settings: a provider and model per
// stage, presets that set them all at once, and the providers with their
// status, where local and custom servers' endpoints are edited. Each row
// opens in place to its editor, one at a time across both lists.
// The server owns the settings (the stages run there), so every save returns
// the new state, which replaces ours. Keys are write-only: the server says
// only whether one is saved.
export function ModelSettings() {
  const [settings, setSettings] = useState<PublicModelSettings>();
  const [loadError, setLoadError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  // The stage or provider whose editor is open.
  const [open, setOpen] = useState<string>();
  // The fold of providers no stage uses.
  const [idleOpen, setIdleOpen] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch("/api/settings/models", { signal: ctrl.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setSettings((await res.json()) as PublicModelSettings);
      })
      .catch((err) => {
        if (!ctrl.signal.aborted) setLoadError(errorMessage(err));
      });
    return () => ctrl.abort();
  }, [attempt]);

  const save: SaveModelSettings = async (update) => {
    try {
      const res = await fetch("/api/settings/models", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(update),
      });
      const data = (await res.json()) as PublicModelSettings & { error?: string };
      if (!res.ok) return data.error ?? `HTTP ${res.status}`;
      setSettings(data);
    } catch (err) {
      return errorMessage(err);
    }
  };

  const row = (id: string) => ({ open: open === id, onOpenChange: (o: boolean) => setOpen(o ? id : undefined) });
  const hosted = settings?.providers.filter((p) => p.keyEnv) ?? [];
  const configurable = settings?.providers.filter((p) => p.configurable) ?? [];
  // The stages that run on a provider, for its row: the Lead only while
  // investigations fan out.
  const usedBy = (id: Provider["id"]) =>
    settings
      ? stageIds
          .filter((s) => settings.stages[s].provider === id && (s !== "lead" || settings.fanout))
          .map((s) => stageLabels[s].label)
      : [];
  // The providers a stage runs on come first; every other one folds into a
  // single row, still split into hosted and local inside it. A provider moves
  // out of the fold as soon as a stage uses it, and a local server's status
  // is only checked once the fold opens.
  const inUse = (p: Provider) => usedBy(p.id).length > 0;
  const shown = hosted.filter((p) => !inUse(p) && featured.includes(p.id));
  const idleHosted = hosted.filter((p) => !inUse(p) && !featured.includes(p.id));
  const idleLocal = configurable.filter((p) => !inUse(p));
  const idle = [...idleHosted, ...idleLocal];
  const hostedRow = (p: Provider) => <HostedProvider key={p.id} provider={p} usedBy={usedBy(p.id)} {...row(p.id)} />;
  const endpointRow = (p: Provider) => (
    <EndpointProvider key={`${p.id}|${p.baseUrl}|${p.hasKey}`} provider={p} usedBy={usedBy(p.id)} onSave={save} {...row(p.id)} />
  );

  return (
    <>
      <section aria-labelledby="models" className="flex flex-col gap-3">
        <SettingsSectionHeader id="models" title="Models">
          {settings?.openWeights && <Badge variant="info">Open weights</Badge>}
          {settings?.builtWithSparkOpen && <Badge variant="outline">Built with Muse Spark Open</Badge>}
        </SettingsSectionHeader>

        {loadError && (
          <Alert variant="destructive">
            <AlertTitle>Couldn&apos;t load the model settings</AlertTitle>
            <AlertDescription className="break-words">{loadError}</AlertDescription>
            <AlertAction>
              <Button
                variant="outline"
                size="xs"
                onClick={() => {
                  setLoadError(undefined);
                  setAttempt((n) => n + 1);
                }}
              >
                Retry
              </Button>
            </AlertAction>
          </Alert>
        )}

        {!settings && !loadError && (
          <div className="divide-y rounded-lg border" aria-busy="true">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex flex-col gap-2 px-4 py-3">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-48" />
              </div>
            ))}
          </div>
        )}

        {settings && (
          <div className="divide-y overflow-hidden rounded-lg border">
            <PresetRow providers={settings.providers} onSave={save} />
            <ListGroup label="Stages" />
            {/* The fan-out switch is in Investigate's editor, the stage it
                changes, and the Lead only shows while it's on: off, the
                Lead never runs, so its row would only be noise. */}
            {stageIds.flatMap((stage) => {
              if (stage === "lead" && !settings.fanout) return [];
              const { provider, model, effort } = settings.stages[stage];
              const fanout = stage === "investigate" ? settings.fanout : undefined;
              const webSearch = stage === "fix" || stage === "ask" ? settings.webSearch : undefined;
              return [
                <StageRow
                  key={`${stage}|${provider}|${model}|${effort}|${fanout}|${webSearch}`}
                  stage={stage}
                  saved={settings.stages[stage]}
                  fanout={fanout}
                  webSearch={webSearch}
                  lead={stage === "investigate" ? settings.stages.lead : undefined}
                  providers={settings.providers}
                  onSave={save}
                  {...row(stage)}
                />,
              ];
            })}
          </div>
        )}
      </section>

      {settings && (
        <section aria-labelledby="providers" className="flex flex-col gap-3">
          <SettingsSectionHeader
            id="providers"
            title="Providers"
            description="Every provider speaks the OpenAI API."
          />
          <div className="divide-y overflow-hidden rounded-lg border">
            <ListGroup label="In use" />
            {hosted.filter(inUse).map(hostedRow)}
            {configurable.filter(inUse).map(endpointRow)}
            {shown.length > 0 && <ListGroup label="Also available" />}
            {shown.map(hostedRow)}
            {idle.length > 0 && (
              <Collapsible open={idleOpen} onOpenChange={setIdleOpen} className="group/idle">
                <CollapsibleTrigger className="flex w-full items-center gap-3 px-4 py-3 text-left outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset">
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="font-medium text-sm">{idle.length} not in use</span>
                    <span className="truncate text-muted-foreground text-xs">{idle.map((p) => p.label).join(", ")}</span>
                  </span>
                  <ChevronRightIcon
                    className="size-4 shrink-0 text-muted-foreground transition-[rotate] duration-200 group-data-[state=open]/idle:rotate-90 motion-reduce:transition-none"
                    aria-hidden
                  />
                </CollapsibleTrigger>
                <CollapsibleContent className="divide-y border-t">
                  {idleHosted.length > 0 && (
                    <ListGroup label="Hosted" note="Keys come from apps/triage/.env.local when the server starts" />
                  )}
                  {idleHosted.map(hostedRow)}
                  {idleLocal.length > 0 && (
                    <ListGroup label="Local and custom" note="Saved on the server; keys never reach the browser" />
                  )}
                  {idleLocal.map(endpointRow)}
                </CollapsibleContent>
              </Collapsible>
            )}
          </div>
        </section>
      )}
    </>
  );
}

// Applies one model to every stage: Muse Spark on Meta's API, Spark Open on
// a host that serves it (Baseten, OpenRouter), or Glimmer on any provider
// that has it (Modal, Fireworks, a local server...). Switching hosts for the
// same open weights is one pick. Each stage's effort goes back to its
// default. The selection is an action, not a value,
// so the select stays empty.
function PresetRow({ providers, onSave }: { providers: Provider[]; onSave: SaveModelSettings }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const spark = providers.find((p) => p.id === "meta");
  const groups = [
    spark?.spark ? [{ value: "spark", label: "Muse Spark · Meta API", provider: spark.id, model: spark.spark }] : [],
    providers.flatMap((p) =>
      p.sparkOpen
        ? [{ value: `spark-open:${p.id}`, label: `Spark Open · ${p.label}`, provider: p.id, model: p.sparkOpen }]
        : [],
    ),
    providers.flatMap((p) =>
      p.glimmer ? [{ value: `glimmer:${p.id}`, label: `Glimmer · ${p.label}`, provider: p.id, model: p.glimmer }] : [],
    ),
  ].filter((g) => g.length > 0);
  const presets = groups.flat();

  async function apply(value: string) {
    const preset = presets.find((p) => p.value === value);
    if (!preset) return;
    setSaving(true);
    setError(undefined);
    const stage = { provider: preset.provider, model: preset.model };
    setError(await onSave({ stages: Object.fromEntries(stageIds.map((id) => [id, stage])) }));
    setSaving(false);
  }

  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between md:gap-6">
        <div className="flex flex-col gap-0.5">
          <span className="font-medium text-sm">Presets</span>
        </div>
        <div className="flex items-center gap-2">
          {saving && <LoaderCircleIcon className="size-4 animate-spin text-muted-foreground" aria-hidden />}
          <Select value="" onValueChange={apply} disabled={saving}>
            <SelectTrigger aria-label="Apply a preset" className="w-full md:w-64">
              <SelectValue placeholder="Apply a preset" />
            </SelectTrigger>
            <SelectContent>
              {groups.map((group, g) => (
                <div key={group[0].value}>
                  {g > 0 && <SelectSeparator />}
                  {group.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </div>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {error && (
        <Alert variant="destructive" dismissible dismissLabel="Dismiss error" onDismiss={() => setError(undefined)}>
          <AlertTitle>Couldn&apos;t apply the preset</AlertTitle>
          <AlertDescription className="break-words">{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

const trimSlash = (url: string) => url.trim().replace(/\/+$/, "");

const modelCount = (n: number) => `${n} ${n === 1 ? "model" : "models"}`;

// Hosted providers kept out of the "not in use" fold even when no stage runs
// on them: Baseten and Modal, the hackathon's sponsors.
const featured: Provider["id"][] = ["baseten", "modal"];

// A provider row's line: the stages it runs, which matter more on the list
// than its URL (that's in the editor). One no stage runs says which of the
// presets' open models it serves, or, in the "not in use" fold, which
// already says so, nothing.
function usedByProps(stages: string[], provider: Provider) {
  if (stages.length > 0) return { subtitle: `Used by ${stages.join(", ")}` };
  const serves = [provider.sparkOpen && "Spark Open", provider.glimmer && "Glimmer"].filter(Boolean);
  return featured.includes(provider.id) && serves.length > 0 ? { subtitle: `Serves ${serves.join(" and ")}` } : {};
}

type Verify = { ok: true; models: string[] } | { ok: false; error: string };

// Lists the models at a provider's endpoint, as drafted or as saved, without
// saving anything. Free: no model is called.
async function verify(body: { provider: Provider["id"]; baseUrl?: string; apiKey?: string }): Promise<Verify> {
  try {
    const res = await fetch("/api/settings/models/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { models?: string[]; error?: string };
    return res.ok ? { ok: true, models: data.models ?? [] } : { ok: false, error: data.error ?? `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

// What Test connection found, under the editor.
function TestResult({ result, onDismiss }: { result: Verify | undefined; onDismiss: () => void }) {
  if (!result) return null;
  if (!result.ok) {
    return (
      <Alert variant="destructive" dismissible dismissLabel="Dismiss error" onDismiss={onDismiss}>
        <AlertTitle>Couldn&apos;t connect</AlertTitle>
        <AlertDescription className="break-words">{result.error}</AlertDescription>
      </Alert>
    );
  }
  const shown = result.models.slice(0, 5);
  const more = result.models.length - shown.length;
  return (
    <Alert variant="success" dismissible dismissLabel="Dismiss result" onDismiss={onDismiss}>
      <AlertTitle>Reachable · {modelCount(result.models.length)}</AlertTitle>
      {shown.length > 0 && (
        <AlertDescription className="break-words font-mono text-xs">
          {shown.join(", ")}
          {more > 0 && `, and ${more} more`}
        </AlertDescription>
      )}
    </Alert>
  );
}

type RowProps = {
  provider: Provider;
  usedBy: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

// A hosted provider. Its key (and for your own deployment, its URL) comes
// from the server's env, so the editor only says where, and tests the
// provider once both are set.
function HostedProvider({ provider, usedBy, ...row }: RowProps) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<Verify>();
  const [copied, setCopied] = useState(false);
  const needsUrl = Boolean(provider.baseUrlEnv) && !provider.baseUrl;
  const line = [needsUrl && `${provider.baseUrlEnv}=`, !provider.hasKey && `${provider.keyEnv}=`]
    .filter(Boolean)
    .join("\n");
  const ready = provider.hasKey && !needsUrl;

  async function test() {
    setTesting(true);
    setResult(undefined);
    setResult(await verify({ provider: provider.id }));
    setTesting(false);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(line);
      setCopied(true);
    } catch {
      // The line is on screen to copy by hand.
    }
  }

  return (
    <DisclosureRow
      title={provider.label}
      {...usedByProps(usedBy, provider)}
      status={ready ? undefined : <StatusBadge tone="warning">{needsUrl ? "Needs URL" : "Needs key"}</StatusBadge>}
      {...row}
    >
      {provider.baseUrl && (
        <FormField label="Base URL">
          <span className="break-all font-mono text-sm">{provider.baseUrl}</span>
        </FormField>
      )}
      <FormField
        label={provider.baseUrlEnv ? "URL and API key" : "API key"}
        hint={
          ready
            ? "Read from the server's environment. Change it in apps/triage/.env.local and restart."
            : needsUrl
              ? "Deploy infra/modal/glimmer.py, then add its URL (ending in /v1) and the key it checks to apps/triage/.env.local and restart the server."
              : "Add this line to apps/triage/.env.local with your key, then restart the server."
        }
      >
        <div className="flex min-h-9 items-center gap-2 rounded-lg bg-muted px-3 py-1.5">
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-sm">
            {ready ? [provider.baseUrlEnv, provider.keyEnv].filter(Boolean).join(", ") : line}
          </span>
          {ready ? (
            <Badge variant="success">set</Badge>
          ) : (
            <Button variant="ghost" size="xs" onClick={copy}>
              {copied ? "Copied" : "Copy"}
            </Button>
          )}
        </div>
      </FormField>
      <TestResult result={result} onDismiss={() => setResult(undefined)} />
      {ready && (
        <div className="flex flex-col items-start gap-1.5">
          <Button variant="outline" size="sm" onClick={test} disabled={testing}>
            {testing && <LoaderCircleIcon className="animate-spin" />}
            Test connection
            <span className="sr-only"> to {provider.label}</span>
          </Button>
          {/* A scaled-to-zero deployment answers slowly the first time;
              the test waits for it, and so starts it. */}
          {provider.coldStart && (
            <span className="text-muted-foreground text-xs">
              {testing
                ? "Waking the deployment. After it scales to zero, its first start takes a few minutes."
                : "Scales to zero when idle. Testing starts it, and investigations wait for it to start."}
            </span>
          )}
        </div>
      )}
    </DisclosureRow>
  );
}

// A local or custom server: its status from listing its models, and an
// editor for the base URL and optional key. The parent keys the row by
// what's saved, so a save resets the draft. A closed row keeps its draft.
function EndpointProvider({ provider, usedBy, onSave, ...row }: RowProps & { onSave: SaveModelSettings }) {
  const id = useId();
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const [apiKey, setApiKey] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string>();
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<Verify>();
  // Set when Test is tried with no URL to test.
  const [noUrl, setNoUrl] = useState(false);

  const configured = Boolean(provider.baseUrl);
  const list = useModelList(configured ? provider : undefined);
  const url = trimSlash(baseUrl);
  const urlChanged = url !== provider.baseUrl;
  const dirty = urlChanged || apiKey !== "";
  const label = provider.label;

  let status;
  if (!configured) status = <span className={buttonVariants({ variant: "outline", size: "xs" })}>Set up</span>;
  else if (list.loading) status = <StatusBadge tone="muted" loading>Checking</StatusBadge>;
  else if (list.unreachable) status = <StatusBadge tone="muted">{provider.local ? "Not running" : "Unreachable"}</StatusBadge>;
  else if (list.error) status = <StatusBadge tone="destructive">Error</StatusBadge>;
  // Running: how many models it serves, as plain text rather than a badge.
  else status = <span className="text-muted-foreground text-xs">{modelCount(list.models.length)}</span>;

  async function save() {
    setSaving(true);
    setError(undefined);
    const err = await onSave({
      endpoints: {
        [provider.id]: {
          ...(urlChanged && { baseUrl: url === provider.defaultBaseUrl ? "" : url }),
          ...(apiKey && { apiKey }),
        },
      },
    });
    setSaving(false);
    if (err) setError(err);
    else row.onOpenChange(false);
  }

  async function removeKey() {
    setRemoving(true);
    setError(undefined);
    setError(await onSave({ endpoints: { [provider.id]: { apiKey: "" } } }));
    setRemoving(false);
  }

  async function test() {
    if (!url && !provider.defaultBaseUrl) return setNoUrl(true);
    setTesting(true);
    setResult(undefined);
    setResult(await verify({ provider: provider.id, baseUrl: url, ...(apiKey && { apiKey }) }));
    setTesting(false);
  }

  function cancel() {
    setBaseUrl(provider.baseUrl);
    setApiKey("");
    setReplacing(false);
    setNoUrl(false);
    setError(undefined);
    setResult(undefined);
    row.onOpenChange(false);
  }

  return (
    <DisclosureRow
      title={label}
      {...(configured || usedBy.length > 0 ? usedByProps(usedBy, provider) : { subtitle: "Any OpenAI-compatible server" })}
      status={status}
      unsaved={dirty}
      {...row}
    >
      {/* Why the models couldn't be listed sits under the URL, until a
          test says more. */}
      <FormField
        label="Base URL"
        htmlFor={`${id}-url`}
        hint={!result && list.error}
        error={noUrl && !url ? "Enter the server's base URL to test it." : undefined}
      >
        <div className="flex gap-2">
          <Input
            id={`${id}-url`}
            placeholder={provider.defaultBaseUrl || "https://example.com/v1"}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={noUrl && !url}
            className="font-mono"
          />
          {provider.defaultBaseUrl && url !== provider.defaultBaseUrl && (
            <Button variant="ghost" onClick={() => setBaseUrl(provider.defaultBaseUrl)}>
              Reset
              <span className="sr-only"> {label} base URL to the default</span>
            </Button>
          )}
        </div>
      </FormField>
      <FormField label="API key" htmlFor={provider.hasKey && !replacing ? undefined : `${id}-key`} optional>
        {provider.hasKey && !replacing ? (
          <div className="flex min-h-9 items-center gap-1 rounded-lg border border-dashed py-1 pr-1 pl-3">
            <span className="flex-1 text-muted-foreground text-sm">A key is saved</span>
            <Button variant="ghost" size="xs" onClick={() => setReplacing(true)}>
              Replace
            </Button>
            <Button variant="ghost" size="xs" onClick={removeKey} disabled={removing || saving}>
              {removing && <LoaderCircleIcon className="animate-spin" />}
              Remove
              <span className="sr-only"> {label} key</span>
            </Button>
          </div>
        ) : (
          <Input
            id={`${id}-key`}
            type="password"
            placeholder={provider.local ? "Only if the server was started with one" : "Bearer token"}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="new-password"
          />
        )}
      </FormField>
      <TestResult result={result} onDismiss={() => setResult(undefined)} />
      {error && (
        <Alert key={error} variant="destructive" dismissible dismissLabel="Dismiss error" onDismiss={() => setError(undefined)}>
          <AlertTitle>Couldn&apos;t save</AlertTitle>
          <AlertDescription className="break-words">{error}</AlertDescription>
        </Alert>
      )}
      <DisclosureFooter>
        <Button variant="outline" size="sm" onClick={test} disabled={testing}>
          {testing && <LoaderCircleIcon className="animate-spin" />}
          Test connection
          <span className="sr-only"> to {label}</span>
        </Button>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={cancel}>
            Cancel
          </Button>
          <Button size="sm" onClick={save} disabled={!dirty || saving || removing}>
            {saving && <LoaderCircleIcon className="animate-spin" />}
            Save
            <span className="sr-only"> {label} endpoint</span>
          </Button>
        </div>
      </DisclosureFooter>
    </DisclosureRow>
  );
}
