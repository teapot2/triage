"use client";

import { LoaderCircleIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { StageRow } from "@/components/model-stage-row";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import type { PublicModelSettings } from "@/lib/models/settings";
import { stageIds } from "@/lib/models/stages";

export type Provider = PublicModelSettings["providers"][number];
export type StageModel = PublicModelSettings["stages"][keyof PublicModelSettings["stages"]];
export type ModelUpdate = {
  stages?: Partial<PublicModelSettings["stages"]>;
  endpoints?: Partial<Record<Provider["id"], { baseUrl?: string; apiKey?: string }>>;
};
// Saves an update and resolves to an error message, or nothing on success.
export type SaveModelSettings = (update: ModelUpdate) => Promise<string | undefined>;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

// The Models section of Settings: a provider and model per stage, presets
// that set them all at once, and the endpoints of local and custom servers.
// The server owns the settings (the stages run there), so every save returns
// the new state, which replaces ours. Keys are write-only: the server says
// only whether one is saved.
export function ModelSettings() {
  const [settings, setSettings] = useState<PublicModelSettings>();
  const [loadError, setLoadError] = useState<string>();
  const [attempt, setAttempt] = useState(0);

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

  const hosted = settings?.providers.filter((p) => p.keyEnv) ?? [];
  const configurable = settings?.providers.filter((p) => p.configurable) ?? [];

  return (
    <section aria-labelledby="models" className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 id="models" className="font-heading font-medium text-base">
          Models
        </h2>
        {settings?.openWeights && <Badge variant="info">Open weights</Badge>}
      </div>

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
              <Skeleton className="h-8 w-full" />
            </div>
          ))}
        </div>
      )}

      {settings && (
        <>
          <div className="divide-y rounded-lg border">
            <PresetRow providers={settings.providers} onSave={save} />
            {stageIds.map((stage) => (
              <StageRow
                key={`${stage}|${settings.stages[stage].provider}|${settings.stages[stage].model}`}
                stage={stage}
                saved={settings.stages[stage]}
                providers={settings.providers}
                onSave={save}
              />
            ))}
          </div>

          <h3 className="mt-3 font-heading font-medium text-sm">Endpoints</h3>
          <div className="divide-y rounded-lg border">
            {configurable.map((p) => (
              <EndpointRow key={`${p.id}|${p.baseUrl}|${p.hasKey}`} provider={p} onSave={save} />
            ))}
            {hosted.map((p) => (
              <div
                key={p.id}
                className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="font-medium text-sm">{p.label}</span>
                <span className="flex items-center gap-2 text-muted-foreground text-sm">
                  <span className="font-mono">{p.keyEnv}</span>
                  <Badge variant={p.hasKey ? "success" : "warning"}>{p.hasKey ? "set" : "not set"}</Badge>
                </span>
              </div>
            ))}
          </div>
          <p className="text-muted-foreground text-sm">
            Hosted providers read their keys from apps/triage/.env.local when the server starts.
          </p>
        </>
      )}
    </section>
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

// A local or custom server's base URL and optional key. The parent keys the
// row by what's saved, so a save clears the typed key. Clearing the URL
// resets it to the default.
function EndpointRow({ provider, onSave }: { provider: Provider; onSave: SaveModelSettings }) {
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string>();

  const urlChanged = trimSlash(baseUrl) !== provider.baseUrl;
  const dirty = urlChanged || apiKey !== "";

  async function run(endpoint: { baseUrl?: string; apiKey?: string }, busy: (v: boolean) => void) {
    busy(true);
    setError(undefined);
    setError(await onSave({ endpoints: { [provider.id]: endpoint } }));
    busy(false);
  }

  const save = () =>
    run(
      {
        ...(urlChanged && { baseUrl: baseUrl.trim() === provider.defaultBaseUrl ? "" : baseUrl.trim() }),
        ...(apiKey && { apiKey }),
      },
      setSaving,
    );

  const label = provider.label;
  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between md:gap-6">
        <div className="flex flex-col gap-0.5 md:w-56 md:shrink-0">
          <span className="font-medium text-sm">{label}</span>
          <span className="text-muted-foreground text-sm">Where Triage reaches it. Clear the URL to use the default.</span>
        </div>
        <div className="flex min-w-0 flex-col gap-2 md:flex-1">
          <Input
            aria-label={`${label} base URL`}
            placeholder={provider.defaultBaseUrl || "https://example.com/v1"}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
          />
          <Input
            type="password"
            aria-label={`${label} API key`}
            placeholder={provider.hasKey ? "Enter a new key to replace it" : "API key"}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="new-password"
          />
          <div className="flex items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-x-2 text-muted-foreground text-xs">
              <span>Optional; most local servers need none.</span>
              {provider.hasKey && (
                <span className="flex items-center gap-1">
                  A key is saved
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={clearing || saving}
                    onClick={() => run({ apiKey: "" }, setClearing)}
                  >
                    {clearing && <LoaderCircleIcon className="animate-spin" />}
                    Clear
                    <span className="sr-only"> {label} key</span>
                  </Button>
                </span>
              )}
            </div>
            <Button size="sm" onClick={save} disabled={!dirty || saving || clearing}>
              {saving && <LoaderCircleIcon className="animate-spin" />}
              Save
              <span className="sr-only"> {label} endpoint</span>
            </Button>
          </div>
        </div>
      </div>
      {error && (
        <Alert key={error} variant="destructive" dismissible dismissLabel="Dismiss error" onDismiss={() => setError(undefined)}>
          <AlertTitle>Couldn&apos;t save</AlertTitle>
          <AlertDescription className="break-words">{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
