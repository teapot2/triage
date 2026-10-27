"use client";

import { LoaderCircleIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { formatDuration } from "@/components/incident/format";
import type { ModelUpdate, Provider, SaveModelSettings, StageModel } from "@/components/model-settings";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ProviderId } from "@/lib/models/providers";
import { type StageId, stageLabels } from "@/lib/models/stages";

type Check = { ok: true; text: string; ms: number } | { ok: false; error: string };

// How long a success stays before it dismisses itself.
const SUCCESS_MS = 6_000;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

// The provider's model IDs, for the input's suggestions. Refetched when its
// endpoint changes. A failure comes back as `error`; the input still takes
// a typed ID.
function useModelList(provider: Provider | undefined) {
  const id = provider?.id;
  const key = `${id}|${provider?.baseUrl}|${provider?.hasKey}`;
  const [result, setResult] = useState<{ key: string; models: string[]; error?: string }>();

  useEffect(() => {
    if (!id) return;
    const ctrl = new AbortController();
    fetch(`/api/settings/models/list?provider=${id}`, { signal: ctrl.signal })
      .then(async (res) => {
        const data = (await res.json()) as { models?: string[]; error?: string };
        return res.ok ? { models: data.models ?? [] } : { models: [], error: data.error ?? `HTTP ${res.status}` };
      })
      .catch((err) => (ctrl.signal.aborted ? undefined : { models: [], error: message(err) }))
      .then((r) => {
        if (r && !ctrl.signal.aborted) setResult({ key, ...r });
      });
    return () => ctrl.abort();
  }, [id, key]);

  const current = result?.key === key ? result : undefined;
  return { models: current?.models ?? [], error: current?.error, loading: Boolean(id) && !current };
}

// One stage's provider and model, with Save and a one-click Check. The
// parent keys the row by its saved value, so a save or preset resets the
// draft. Check calls the draft model once, saved or not, and may incur
// charges; its result shows under the row.
export function StageRow({
  stage,
  saved,
  providers,
  onSave,
}: {
  stage: StageId;
  saved: StageModel;
  providers: Provider[];
  onSave: SaveModelSettings;
}) {
  const { label, description } = stageLabels[stage];
  const listId = useId();
  const [draft, setDraft] = useState<StageModel>(saved);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<Check | null>(null);
  // A new check is a new notice, so its countdown starts over.
  const [checks, setChecks] = useState(0);

  const provider = providers.find((p) => p.id === draft.provider);
  const { models, error: listError, loading: listLoading } = useModelList(provider);
  const model = draft.model.trim();
  const dirty = draft.provider !== saved.provider || model !== saved.model;
  const missingKey = provider?.keyEnv && !provider.hasKey ? provider.keyEnv : undefined;

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
  }

  async function save() {
    setSaving(true);
    setSaveError(undefined);
    const update: ModelUpdate = { stages: { [stage]: { provider: draft.provider, model } } };
    setSaveError(await onSave(update));
    setSaving(false);
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
    <div className="flex flex-col gap-3 px-4 py-3">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between md:gap-6">
        <div className="flex flex-col gap-0.5 md:w-56 md:shrink-0">
          <span className="font-medium text-sm">{label}</span>
          <span className="text-muted-foreground text-sm">{description}</span>
        </div>
        <div className="flex min-w-0 flex-col gap-1.5 md:flex-1">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Select value={draft.provider} onValueChange={(v) => changeProvider(v as ProviderId)}>
              <SelectTrigger aria-label={`${label} provider`} className="w-full sm:w-52 sm:shrink-0">
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
            <Input
              aria-label={`${label} model`}
              placeholder="Model ID"
              list={listId}
              value={draft.model}
              onChange={(e) => setDraft({ ...draft, model: e.target.value })}
              autoComplete="off"
              spellCheck={false}
              className="font-mono sm:flex-1"
            />
            <datalist id={listId}>
              {models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </div>
          {listLoading && <span className="text-muted-foreground text-xs">Loading model suggestions…</span>}
          {listError && <span className="break-words text-muted-foreground text-xs">{listError}</span>}
          <div className="flex gap-2">
            <Button size="sm" onClick={save} disabled={!dirty || !model || saving}>
              {saving && <LoaderCircleIcon className="animate-spin" />}
              Save
            </Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="sm" onClick={ping} disabled={!model || checking}>
                  {checking && <LoaderCircleIcon className="animate-spin" />}
                  Check
                </Button>
              </TooltipTrigger>
              <TooltipContent>Sends one short request, which may incur charges.</TooltipContent>
            </Tooltip>
          </div>
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
    </div>
  );
}
