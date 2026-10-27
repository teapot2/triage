"use client";

import { LoaderCircleIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { formatDuration } from "@/components/incident/format";
import type { ModelUpdate, Provider, SaveModelSettings, StageModel } from "@/components/model-settings";
import { ModelPicker } from "@/components/model-picker";
import { DisclosureRow, Status } from "@/components/settings-list";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ProviderId } from "@/lib/models/providers";
import { type StageId, stageLabels } from "@/lib/models/stages";

type Check = { ok: true; text: string; ms: number } | { ok: false; error: string };

// How long a success stays before it dismisses itself.
const SUCCESS_MS = 6_000;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

// The provider's model IDs, for the input's suggestions and the provider's
// status. Refetched when its endpoint changes. A failure comes back as
// `error`, with `unreachable` when nothing answered; the input still takes a
// typed ID.
export function useModelList(provider: Provider | undefined) {
  const id = provider?.id;
  const key = `${id}|${provider?.baseUrl}|${provider?.hasKey}`;
  const [result, setResult] = useState<{ key: string; models: string[]; error?: string; unreachable?: boolean }>();

  useEffect(() => {
    if (!id) return;
    const ctrl = new AbortController();
    fetch(`/api/settings/models/list?provider=${id}`, { signal: ctrl.signal })
      .then(async (res) => {
        const data = (await res.json()) as { models?: string[]; error?: string; unreachable?: boolean };
        return res.ok
          ? { models: data.models ?? [] }
          : { models: [], error: data.error ?? `HTTP ${res.status}`, unreachable: data.unreachable };
      })
      .catch((err) => (ctrl.signal.aborted ? undefined : { models: [], error: message(err) }))
      .then((r) => {
        if (r && !ctrl.signal.aborted) setResult({ key, ...r });
      });
    return () => ctrl.abort();
  }, [id, key]);

  const current = result?.key === key ? result : undefined;
  return {
    models: current?.models ?? [],
    error: current?.error,
    unreachable: current?.unreachable,
    loading: Boolean(id) && !current,
  };
}

// One stage's provider and model: a row that shows what's saved and whether
// it can run, opening to an editor with Save and Test model. The parent keys
// the row by its saved value, so a save or preset resets the draft, and owns
// `open`. Test model calls the draft model once, saved or not, and may incur
// charges; its result shows in the editor.
export function StageRow({
  stage,
  saved,
  providers,
  onSave,
  open,
  onOpenChange,
}: {
  stage: StageId;
  saved: StageModel;
  providers: Provider[];
  onSave: SaveModelSettings;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { label, description } = stageLabels[stage];
  const id = useId();
  const [draft, setDraft] = useState<StageModel>(saved);
  // Whether the draft model was entered as a custom ID, on purpose, for a
  // model the provider leaves out of its list.
  const [custom, setCustom] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<Check | null>(null);
  // A new check is a new notice, so its countdown starts over.
  const [checks, setChecks] = useState(0);

  const provider = providers.find((p) => p.id === draft.provider);
  const list = useModelList(provider);
  const model = draft.model.trim();
  const dirty = draft.provider !== saved.provider || model !== saved.model;
  const missingKey = provider?.keyEnv && !provider.hasKey ? provider.keyEnv : undefined;
  const savedLabel = providers.find((p) => p.id === saved.provider)?.label ?? saved.provider;
  // A list to pick from: loaded, and not empty. Without one, any ID goes.
  const listed = !list.loading && !list.error && list.models.length > 0;
  const known = list.models.includes(model);
  const unlisted = listed && Boolean(model) && !known;

  // Whether the saved stage can run, from its provider's model list. The
  // list follows the draft's provider, so a draft on another one shows none.
  let status;
  if (draft.provider !== saved.provider) status = undefined;
  else if (missingKey) status = <Status tone="warning">Needs key</Status>;
  else if (list.loading) status = <Status tone="muted" loading>Checking</Status>;
  else if (list.unreachable) status = <Status tone="muted">{provider?.local ? "Not running" : "Unreachable"}</Status>;
  else if (list.error) status = <Status tone="destructive">Error</Status>;
  else if (!list.models.includes(saved.model)) status = <Status tone="warning">Not found</Status>;
  else status = <Status tone="success">Ready</Status>;

  // A model ID rarely carries over to another provider, so start the new one
  // empty. The exceptions: going back to the saved provider restores its
  // model, and a Glimmer or Spark ID maps to the new provider's own.
  function changeProvider(id: ProviderId) {
    const from = providers.find((p) => p.id === draft.provider);
    const to = providers.find((p) => p.id === id);
    let next = "";
    if (id === saved.provider) next = saved.model;
    else if (from?.glimmer && draft.model === from.glimmer) next = to?.glimmer ?? "";
    else if (from?.spark && draft.model === from.spark) next = to?.spark ?? "";
    setDraft({ provider: id, model: next });
    setCustom(false);
  }

  async function save() {
    setSaving(true);
    setSaveError(undefined);
    const update: ModelUpdate = { stages: { [stage]: { provider: draft.provider, model } } };
    const err = await onSave(update);
    setSaving(false);
    if (err) setSaveError(err);
    else onOpenChange(false);
  }

  function cancel() {
    setDraft(saved);
    setCustom(false);
    setSaveError(undefined);
    setCheck(null);
    onOpenChange(false);
  }

  async function ping() {
    setChecking(true);
    setCheck(null);
    const started = performance.now();
    try {
      const params = new URLSearchParams({ provider: draft.provider, model });
      const res = await fetch(`/api/ping-model?${params}`);
      const data = (await res.json()) as { ok: boolean; text?: string; error?: string };
      setCheck(
        data.ok
          ? { ok: true, text: data.text ?? "", ms: performance.now() - started }
          : { ok: false, error: data.error ?? `HTTP ${res.status}` },
      );
    } catch (err) {
      setCheck({ ok: false, error: message(err) });
    } finally {
      setChecks((n) => n + 1);
      setChecking(false);
    }
  }

  return (
    <DisclosureRow
      title={label}
      subtitle={
        <>
          <span className="font-mono">{saved.model}</span> via {savedLabel}
        </>
      }
      status={status}
      unsaved={dirty}
      open={open}
      onOpenChange={onOpenChange}
    >
      <p className="text-muted-foreground text-xs">{description}</p>
      <div className="grid gap-3 sm:grid-cols-[13rem_1fr]">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-provider`} className="font-medium text-xs">
            Provider
          </label>
          <Select value={draft.provider} onValueChange={(v) => changeProvider(v as ProviderId)}>
            <SelectTrigger id={`${id}-provider`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {providers.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor={`${id}-model`} className="font-medium text-xs">
            Model
          </label>
          <ModelPicker
            id={`${id}-model`}
            models={list.models}
            loading={list.loading}
            listed={listed}
            value={draft.model}
            custom={custom}
            onChange={(m, c) => {
              setDraft({ ...draft, model: m });
              setCustom(c);
            }}
          />
          {/* A missing key has its own notice below. */}
          {!list.loading && !listed && !missingKey && (
            <span className="break-words text-muted-foreground text-xs">
              {list.error ?? `${provider?.label ?? "This provider"} listed no models.`} Enter the model ID.
            </span>
          )}
          {unlisted && custom && (
            <span className="text-muted-foreground text-xs">
              Not in {provider?.label}&apos;s model list. Test it before you save.
            </span>
          )}
          {unlisted && !custom && (
            <span className="text-[color-mix(in_oklab,var(--warning)_55%,black)] text-xs dark:text-warning">
              {provider?.label} doesn&apos;t list this model. Choose one from the list, or use a custom ID.
            </span>
          )}
        </div>
      </div>
      {missingKey && (
        <Alert variant="warning">
          <AlertDescription>
            <span className="font-mono">{missingKey}</span> is not set. Add it to apps/triage/.env.local and restart the
            server.
          </AlertDescription>
        </Alert>
      )}
      {saveError && (
        <Alert key={saveError} variant="destructive" dismissible dismissLabel="Dismiss error" onDismiss={() => setSaveError(undefined)}>
          <AlertTitle>Couldn&apos;t save</AlertTitle>
          <AlertDescription className="break-words">{saveError}</AlertDescription>
        </Alert>
      )}
      {check?.ok && (
        <Alert key={checks} variant="success" dismissible dismissLabel="Dismiss result" autoDismiss={SUCCESS_MS} onDismiss={() => setCheck(null)}>
          <AlertTitle>The model answered</AlertTitle>
          <AlertDescription className="break-words">
            Replied &ldquo;{check.text}&rdquo; in {formatDuration(check.ms)}.
          </AlertDescription>
        </Alert>
      )}
      {check && !check.ok && (
        <Alert key={checks} variant="destructive" dismissible dismissLabel="Dismiss error" onDismiss={() => setCheck(null)}>
          <AlertTitle>The model didn&apos;t answer</AlertTitle>
          <AlertDescription className="break-words">{check.error}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" size="sm" onClick={ping} disabled={!model || checking}>
              {checking && <LoaderCircleIcon className="animate-spin" />}
              Test model
              <span className="sr-only"> for {label}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Sends one short request, which may incur charges.</TooltipContent>
        </Tooltip>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={cancel}>
            Cancel
          </Button>
          <Button size="sm" onClick={save} disabled={!dirty || !model || saving || list.loading || (unlisted && !custom)}>
            {saving && <LoaderCircleIcon className="animate-spin" />}
            Save
            <span className="sr-only"> {label}</span>
          </Button>
        </div>
      </div>
    </DisclosureRow>
  );
}
