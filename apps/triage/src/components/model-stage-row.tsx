"use client";

import { CheckIcon, LoaderCircleIcon } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { FormField } from "@/components/form-fields";
import { FanoutExplainer } from "@/components/fanout-explainer";
import { formatDuration } from "@/components/incident/format";
import type { ModelUpdate, Provider, SaveModelSettings, StageModel } from "@/components/model-settings";
import { ModelPicker } from "@/components/model-picker";
import { DisclosureFooter, DisclosureRow } from "@/components/settings-list";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ProviderId } from "@/lib/models/providers";
import { defaultEffort, effortLabels, effortsFor, type ReasoningEffort, type StageId, stageLabels } from "@/lib/models/stages";
import { errorMessage } from "@/lib/errors";

type Check = { ok: true; text: string; ms: number } | { ok: false; error: string };

// How long a success stays before it dismisses itself.
const SUCCESS_MS = 6_000;

// One call to the model, timed. Outside the component because the React
// compiler's purity rule treats a clock read inside one as a render-time
// call, even in an event handler.
async function pingModel(params: URLSearchParams): Promise<Check> {
  const started = performance.now();
  const res = await fetch(`/api/ping-model?${params}`);
  const data = (await res.json()) as { ok: boolean; text?: string; error?: string };
  return data.ok
    ? { ok: true, text: data.text ?? "", ms: performance.now() - started }
    : { ok: false, error: data.error ?? `HTTP ${res.status}` };
}

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
      .catch((err) => (ctrl.signal.aborted ? undefined : { models: [], error: errorMessage(err) }))
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

// One stage's provider, model and (on Meta's API) reasoning effort: a row
// that shows what's saved and whether it can run, opening to an editor with
// Save and Test model. The parent keys
// the row by its saved value, so a save or preset resets the draft, and owns
// `open`. Test model calls the draft model once, saved or not, and may incur
// charges; its result shows in the editor. Investigate's row also carries
// "Check hypotheses in parallel" (`fanout`), the switch that changes how it
// runs, drafted and saved with the rest; Fix's and Ask's carry "Search the
// web" (`webSearch`) the same way, one setting for both, shown on Meta's API.
export function StageRow({
  stage,
  saved,
  fanout,
  webSearch,
  lead,
  providers,
  onSave,
  open,
  onOpenChange,
}: {
  stage: StageId;
  saved: StageModel;
  fanout?: boolean;
  webSearch?: boolean;
  // The Lead's saved model, for the fan-out explainer.
  lead?: StageModel;
  providers: Provider[];
  onSave: SaveModelSettings;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { label, description } = stageLabels[stage];
  const id = useId();
  const [draft, setDraft] = useState<StageModel>(saved);
  const [draftFanout, setDraftFanout] = useState(fanout);
  const [draftWebSearch, setDraftWebSearch] = useState(webSearch);
  // Whether the draft model was entered as a custom ID, on purpose, for a
  // model the provider leaves out of its list.
  const [custom, setCustom] = useState(false);
  const [saving, setSaving] = useState(false);
  // The model's error shows once Save or Test has been tried.
  const [tried, setTried] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<Check | null>(null);
  // A new check is a new notice, so its countdown starts over.
  const [checks, setChecks] = useState(0);

  useEffect(() => {
    if (!check?.ok) return;
    const timer = setTimeout(() => setCheck(null), SUCCESS_MS);
    return () => clearTimeout(timer);
  }, [check, checks]);

  const provider = providers.find((p) => p.id === draft.provider);
  const list = useModelList(provider);
  const model = draft.model.trim();
  // Only Meta's API takes an effort. A level the model doesn't take (Max,
  // after switching to an older Spark) drops to the highest it does.
  const meta = draft.provider === "meta";
  const efforts = effortsFor(model);
  const effort = efforts.includes(draft.effort) ? draft.effort : efforts[efforts.length - 1];
  const dirty =
    draft.provider !== saved.provider ||
    model !== saved.model ||
    (meta && effort !== saved.effort) ||
    draftFanout !== fanout ||
    draftWebSearch !== webSearch;
  const missingKey = provider?.keyEnv && !provider.hasKey ? provider.keyEnv : undefined;
  const savedLabel = providers.find((p) => p.id === saved.provider)?.label ?? saved.provider;
  // A list to pick from: loaded, and not empty. Without one, any ID goes.
  const listed = !list.loading && !list.error && list.models.length > 0;
  const known = list.models.includes(model);
  const unlisted = listed && Boolean(model) && !known;
  // Why the draft model can't be saved, or undefined when it can.
  const modelError = !model
    ? "Choose a model, or enter its ID."
    : unlisted && !custom
      ? `${provider?.label} doesn't list this model. Choose one from the list, or use a custom ID.`
      : undefined;
  // The Model field's note: its error once tried, else what it should know
  // about the list. A missing key has its own notice below.
  const modelHint =
    !list.loading && !listed && !missingKey
      ? `${list.error ?? `${provider?.label ?? "This provider"} listed no models.`} Enter the model ID.`
      : unlisted && custom
        ? `Not in ${provider?.label}'s model list. Test it before you save.`
        : unlisted
          ? modelError
          : undefined;

  // Whether the saved stage can run, from its provider's model list. The
  // list follows the draft's provider, so a draft on another one shows none.
  let status;
  if (draft.provider !== saved.provider) status = undefined;
  else if (missingKey) status = <StatusBadge tone="warning">Needs key</StatusBadge>;
  else if (list.loading) status = <StatusBadge tone="muted" loading>Checking</StatusBadge>;
  else if (list.unreachable) status = <StatusBadge tone="warning">{provider?.local ? "Not running" : "Unreachable"}</StatusBadge>;
  else if (list.error) status = <StatusBadge tone="destructive">Error</StatusBadge>;
  else if (!list.models.includes(saved.model)) status = <StatusBadge tone="warning">Not found</StatusBadge>;
  // Ready says nothing: a badge only where something needs looking at, so
  // that one stands out.
  else status = undefined;

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
    setDraft({ provider: id, model: next, effort: draft.effort });
    setCustom(false);
    setTried(false);
  }

  async function save() {
    setTried(true);
    if (modelError) return;
    setSaving(true);
    setSaveError(undefined);
    const update: ModelUpdate = {
      stages: { [stage]: { provider: draft.provider, model, effort } },
      ...(draftFanout !== undefined && { fanout: draftFanout }),
      ...(draftWebSearch !== undefined && { webSearch: draftWebSearch }),
    };
    const err = await onSave(update);
    setSaving(false);
    if (err) setSaveError(err);
    else onOpenChange(false);
  }

  function cancel() {
    setDraft(saved);
    setDraftFanout(fanout);
    setDraftWebSearch(webSearch);
    setCustom(false);
    setTried(false);
    setSaveError(undefined);
    setCheck(null);
    onOpenChange(false);
  }

  async function ping() {
    setTried(true);
    if (!model) return;
    setChecking(true);
    setCheck(null);
    try {
      setCheck(await pingModel(new URLSearchParams({ provider: draft.provider, model, ...(meta && { effort }) })));
    } catch (err) {
      setCheck({ ok: false, error: errorMessage(err) });
    } finally {
      setChecks((n) => n + 1);
      setChecking(false);
    }
  }

  return (
    <DisclosureRow
      title={label}
      tag={fanout ? "Parallel" : webSearch && saved.provider === "meta" ? "Web search" : undefined}
      subtitle={description}
      summary={
        <>
          <span className="flex w-40 min-w-0 flex-col gap-0.5">
            <span className="truncate font-mono text-xs" title={saved.model}>
              {saved.model}
            </span>
            <span className="truncate text-muted-foreground text-xs">{savedLabel}</span>
          </span>
          {/* Effort only applies on Meta's API; elsewhere the column stays
              empty, keeping its width so the rows line up. */}
          <span className="w-16 text-xs">
            {saved.provider === "meta" && (
              <Badge variant="secondary" className="font-normal">
                {effortLabels[saved.effort]}
              </Badge>
            )}
          </span>
        </>
      }
      status={status}
      unsaved={dirty}
      open={open}
      onOpenChange={onOpenChange}
    >
      <div className={cn("grid gap-x-4 gap-y-3 sm:grid-cols-2", meta && "sm:grid-cols-[1fr_1.5fr_1fr]")}>
        <FormField label="Provider" htmlFor={`${id}-provider`}>
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
        </FormField>
        <FormField label="Model" htmlFor={`${id}-model`} hint={modelHint} error={tried ? modelError : undefined}>
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
        </FormField>
        {meta && (
          <FormField label="Reasoning effort" htmlFor={`${id}-effort`}>
            <Select value={effort} onValueChange={(v) => setDraft({ ...draft, effort: v as ReasoningEffort })}>
              <SelectTrigger id={`${id}-effort`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {efforts.map((e) => (
                  <SelectItem key={e} value={e}>
                    {effortLabels[e]}
                    {e === defaultEffort[stage] && " (default)"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        )}
      </div>
      {draftFanout !== undefined && (
        <EditorSwitch id={`${id}-fanout`} label="Check hypotheses in parallel" checked={draftFanout} onChange={setDraftFanout}>
          The Lead proposes up to three causes, the Investigate model checks each at once, and the Lead writes the
          diagnosis from their findings. More model calls per run.{" "}
          {lead && <FanoutExplainer lanes={draft} lead={lead} />}
        </EditorSwitch>
      )}
      {draftWebSearch !== undefined && meta && (
        <EditorSwitch id={`${id}-web-search`} label="Search the web" checked={draftWebSearch} onChange={setDraftWebSearch}>
          Fix and Ask can look up how a library is documented to behave and cite the pages, at $2.50 per 1,000
          searches. One setting for both; Ask can also turn it off per question.
        </EditorSwitch>
      )}
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
      {check && !check.ok && (
        <Alert key={checks} variant="destructive" dismissible dismissLabel="Dismiss error" onDismiss={() => setCheck(null)}>
          <AlertTitle>The model didn&apos;t answer</AlertTitle>
          <AlertDescription className="break-words">{check.error}</AlertDescription>
        </Alert>
      )}
      <DisclosureFooter>
        {/* A success is one line beside the button, so the editor doesn't
            jump; a failure gets the alert above, with its error. */}
        <div className="flex items-center gap-3">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="sm" onClick={ping} disabled={checking}>
                {checking && <LoaderCircleIcon className="animate-spin" />}
                Test model
                <span className="sr-only"> for {label}</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Sends one short request, which may incur charges.</TooltipContent>
          </Tooltip>
          <span role="status" className="flex items-center gap-1 text-muted-foreground text-xs">
            {check?.ok && (
              <>
                <CheckIcon className="size-3.5 text-success" aria-hidden />
                Answered in {formatDuration(check.ms)}
              </>
            )}
          </span>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={cancel}>
            Cancel
          </Button>
          <Button size="sm" onClick={save} disabled={!dirty || saving || list.loading}>
            {saving && <LoaderCircleIcon className="animate-spin" />}
            Save
            <span className="sr-only"> {label}</span>
          </Button>
        </div>
      </DisclosureFooter>
    </DisclosureRow>
  );
}

// A switch in a stage's editor, drafted with the rest: a label, what it does
// beneath, the switch on the right.
function EditorSwitch({
  id,
  label,
  checked,
  onChange,
  children,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (on: boolean) => void;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6">
      <div className="flex min-w-0 flex-col gap-0.5">
        <label htmlFor={id} className="font-medium text-sm">
          {label}
        </label>
        <span id={`${id}-description`} className="max-w-xl text-muted-foreground text-xs">
          {children}
        </span>
      </div>
      <Switch id={id} aria-describedby={`${id}-description`} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
