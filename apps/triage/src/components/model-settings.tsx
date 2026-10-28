"use client";

import { LoaderCircleIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { StageRow, useModelList } from "@/components/model-stage-row";
import { DisclosureRow, ListGroup, SettingsSectionHeader } from "@/components/settings-list";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import type { PublicModelSettings } from "@/lib/models/settings";
import { stageIds, stageLabels } from "@/lib/models/stages";

export type Provider = PublicModelSettings["providers"][number];
export type StageModel = PublicModelSettings["stages"][keyof PublicModelSettings["stages"]];
export type ModelUpdate = {
  stages?: Partial<PublicModelSettings["stages"]>;
  endpoints?: Partial<Record<Provider["id"], { baseUrl?: string; apiKey?: string }>>;
};
// Saves an update and resolves to an error message, or nothing on success.
export type SaveModelSettings = (update: ModelUpdate) => Promise<string | undefined>;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

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

  useEffect(() => {
    const ctrl = new AbortController();
    fetch("/api/settings/models", { signal: ctrl.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setSettings((await res.json()) as PublicModelSettings);
      })
      .catch((err) => {
        if (!ctrl.signal.aborted) setLoadError(message(err));
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
      return message(err);
    }
  };

  const row = (id: string) => ({ open: open === id, onOpenChange: (o: boolean) => setOpen(o ? id : undefined) });
  const hosted = settings?.providers.filter((p) => p.keyEnv) ?? [];
  const configurable = settings?.providers.filter((p) => p.configurable) ?? [];
  // The stages that run on a provider, for its row.
  const usedBy = (id: Provider["id"]) =>
    settings ? stageIds.filter((s) => settings.stages[s].provider === id).map((s) => stageLabels[s].label) : [];

  return (
    <>
      <section aria-labelledby="models" className="flex flex-col gap-3">
        <SettingsSectionHeader id="models" title="Models">
          {settings?.openWeights && <Badge variant="info">Open weights</Badge>}
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
            {stageIds.map((stage) => (
              <StageRow
                key={`${stage}|${settings.stages[stage].provider}|${settings.stages[stage].model}`}
                stage={stage}
                saved={settings.stages[stage]}
                providers={settings.providers}
                onSave={save}
                {...row(stage)}
              />
            ))}
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
            <ListGroup label="Hosted" note="Keys come from apps/triage/.env.local when the server starts" />
            {hosted.map((p) => (
              <HostedProvider key={p.id} provider={p} usedBy={usedBy(p.id)} {...row(p.id)} />
            ))}
            <ListGroup label="Local and custom" note="Saved on the server; keys never reach the browser" />
            {configurable.map((p) => (
              <EndpointProvider
                key={`${p.id}|${p.baseUrl}|${p.hasKey}`}
                provider={p}
                usedBy={usedBy(p.id)}
                onSave={save}
                {...row(p.id)}
              />
            ))}
          </div>
        </section>
      )}
    </>
  );
}

// Applies one model to every stage: Muse Spark on Meta's API, or Glimmer on
// any provider that has it. The selection is an action, not a value, so the
// select stays empty.
function PresetRow({ providers, onSave }: { providers: Provider[]; onSave: SaveModelSettings }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const spark = providers.find((p) => p.id === "meta");
  const presets = [
    ...(spark?.spark ? [{ value: "spark", label: "Muse Spark · Meta API", provider: spark.id, model: spark.spark }] : []),
    ...providers.flatMap((p) =>
      p.glimmer ? [{ value: `glimmer:${p.id}`, label: `Glimmer · ${p.label}`, provider: p.id, model: p.glimmer }] : [],
    ),
  ];

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
          <span className="text-muted-foreground text-sm">
            Set every stage to one model. Open weights stages run on a model you can host yourself.
          </span>
        </div>
        <div className="flex items-center gap-2">
          {saving && <LoaderCircleIcon className="size-4 animate-spin text-muted-foreground" aria-hidden />}
          <Select value="" onValueChange={apply} disabled={saving}>
            <SelectTrigger aria-label="Apply a preset" className="w-full md:w-64">
              <SelectValue placeholder="Apply a preset" />
            </SelectTrigger>
            <SelectContent>
              {presets.map((p, i) => (
                <div key={p.value}>
                  {i === 1 && <SelectSeparator />}
                  <SelectItem value={p.value}>{p.label}</SelectItem>
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
    return { ok: false, error: message(err) };
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

// A hosted provider. Its key comes from the server's env, so the editor only
// says where, and tests the provider once the key is set.
function HostedProvider({ provider, usedBy, ...row }: RowProps) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<Verify>();
  const [copied, setCopied] = useState(false);
  const line = `${provider.keyEnv}=`;

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
      tag={usedBy.join(" · ") || undefined}
      subtitle={<span className="font-mono">{provider.baseUrl}</span>}
      status={provider.hasKey ? <StatusBadge tone="success">Ready</StatusBadge> : <StatusBadge tone="warning">Needs key</StatusBadge>}
      {...row}
    >
      <div className="flex flex-col gap-1.5">
        <span className="font-medium text-xs">API key</span>
        <div className="flex min-h-9 items-center gap-2 rounded-lg bg-muted px-3 py-1.5">
          <span className="min-w-0 flex-1 truncate font-mono text-sm">{provider.hasKey ? provider.keyEnv : line}</span>
          {provider.hasKey ? (
            <Badge variant="success">set</Badge>
          ) : (
            <Button variant="ghost" size="xs" onClick={copy}>
              {copied ? "Copied" : "Copy"}
            </Button>
          )}
        </div>
        <span className="text-muted-foreground text-xs">
          {provider.hasKey
            ? "Read from the server's environment. Change it in apps/triage/.env.local and restart."
            : "Add this line to apps/triage/.env.local with your key, then restart the server."}
        </span>
      </div>
      <TestResult result={result} onDismiss={() => setResult(undefined)} />
      {provider.hasKey && (
        <div>
          <Button variant="outline" size="sm" onClick={test} disabled={testing}>
            {testing && <LoaderCircleIcon className="animate-spin" />}
            Test connection
            <span className="sr-only"> to {provider.label}</span>
          </Button>
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
  else status = <StatusBadge tone="success">{modelCount(list.models.length)}</StatusBadge>;

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
    setTesting(true);
    setResult(undefined);
    setResult(await verify({ provider: provider.id, baseUrl: url, ...(apiKey && { apiKey }) }));
    setTesting(false);
  }

  function cancel() {
    setBaseUrl(provider.baseUrl);
    setApiKey("");
    setReplacing(false);
    setError(undefined);
    setResult(undefined);
    row.onOpenChange(false);
  }

  return (
    <DisclosureRow
      title={label}
      tag={usedBy.join(" · ") || undefined}
      subtitle={configured ? <span className="font-mono">{provider.baseUrl}</span> : "Any OpenAI-compatible server"}
      status={status}
      unsaved={dirty}
      {...row}
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-url`} className="font-medium text-xs">
          Base URL
        </label>
        <div className="flex gap-2">
          <Input
            id={`${id}-url`}
            placeholder={provider.defaultBaseUrl || "https://example.com/v1"}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
          />
          {provider.defaultBaseUrl && url !== provider.defaultBaseUrl && (
            <Button variant="ghost" onClick={() => setBaseUrl(provider.defaultBaseUrl)}>
              Reset
              <span className="sr-only"> {label} base URL to the default</span>
            </Button>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={provider.hasKey && !replacing ? undefined : `${id}-key`} className="font-medium text-xs">
          API key <span className="font-normal text-muted-foreground">(optional)</span>
        </label>
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
      </div>
      {list.error && !result && <p className="break-words text-muted-foreground text-xs">{list.error}</p>}
      <TestResult result={result} onDismiss={() => setResult(undefined)} />
      {error && (
        <Alert key={error} variant="destructive" dismissible dismissLabel="Dismiss error" onDismiss={() => setError(undefined)}>
          <AlertTitle>Couldn&apos;t save</AlertTitle>
          <AlertDescription className="break-words">{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="outline" size="sm" onClick={test} disabled={testing || (!url && !provider.defaultBaseUrl)}>
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
      </div>
    </DisclosureRow>
  );
}
