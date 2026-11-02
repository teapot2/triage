"use client";

import { LoaderCircleIcon } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { FormField, FormRow, FormRows } from "@/components/form-fields";
import type { Provider } from "@/components/model-settings";
import { ModelPicker } from "@/components/model-picker";
import { useModelList } from "@/components/model-stage-row";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { errorMessage } from "@/lib/errors";
import { allRuns, runModelsOf, runsFix } from "@/lib/investigation/reruns";
import type { Incident, RunModels, StageChoice } from "@/lib/investigation/schema";
import type { PublicModelSettings } from "@/lib/models/settings";
import { defaultEffort, effortLabels, effortsFor, type ReasoningEffort, stageLabels } from "@/lib/models/stages";
import { cn } from "@/lib/utils";

type Choice = Required<StageChoice>;
type Draft = { investigate: Choice; fanout: boolean; lead: Choice; fix: Choice; postmortem: Choice };
type DraftStage = Exclude<keyof Draft, "fanout">;

// What the dialog opens with: the shown run's models, stage by stage, and
// Settings' for a stage it didn't run. Fan-out as the run had it.
function initialDraft(view: Incident, settings: PublicModelSettings): Draft {
  const used = runModelsOf(view);
  const pick = (stage: DraftStage): Choice => {
    const run = used[stage];
    const fallback = settings.stages[stage];
    return run ? { provider: run.provider, model: run.model, effort: run.effort ?? defaultEffort[stage] } : fallback;
  };
  return {
    investigate: pick("investigate"),
    fanout: view.run?.fanout !== undefined || (!view.run && settings.fanout),
    lead: pick("lead"),
    fix: pick("fix"),
    postmortem: pick("postmortem"),
  };
}

// Picks the models for a re-run of the incident, then starts it and opens
// it. Every stage the run goes through can change: Investigate (and its
// Lead, when it checks hypotheses in parallel), Fix on a live incident, and
// the Postmortem, used once the run is the incident's.
export function RerunDialog({
  incident,
  view,
  open,
  onOpenChange,
}: {
  incident: Incident;
  // The run on screen: its models are the starting point.
  view: Incident;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [settings, setSettings] = useState<PublicModelSettings>();
  const [loadError, setLoadError] = useState<string>();
  useEffect(() => {
    if (!open || settings) return;
    const ctrl = new AbortController();
    fetch("/api/settings/models", { signal: ctrl.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setSettings((await res.json()) as PublicModelSettings);
      })
      .catch((err) => !ctrl.signal.aborted && setLoadError(errorMessage(err)));
    return () => ctrl.abort();
  }, [open, settings]);

  const next = Math.max(...allRuns(incident).map((r) => r.number)) + 1;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Re-run the investigation</DialogTitle>
          <DialogDescription>
            Investigates the incident again on the telemetry it fired on, with the models below. It&apos;s kept as run {next}{" "}
            beside the others, and acts on nothing until you use it.
          </DialogDescription>
        </DialogHeader>
        {loadError ? (
          <Alert variant="destructive">
            <AlertDescription>Couldn&apos;t load the models: {loadError}</AlertDescription>
          </Alert>
        ) : settings ? (
          // Keyed by the run shown, so opening it from another run starts over.
          <RerunForm key={view.runNumber ?? 1} incident={incident} view={view} settings={settings} next={next} onDone={() => onOpenChange(false)} />
        ) : (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RerunForm({
  incident,
  view,
  settings,
  next,
  onDone,
}: {
  incident: Incident;
  view: Incident;
  settings: PublicModelSettings;
  next: number;
  onDone: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [draft, setDraft] = useState(() => initialDraft(view, settings));
  const [tried, setTried] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const fixes = runsFix(incident);
  const stages: DraftStage[] = ["investigate", ...(draft.fanout ? ["lead" as const] : []), ...(fixes ? ["fix" as const] : []), "postmortem"];
  const missing = stages.filter((s) => !draft[s].model.trim());
  const set = (stage: DraftStage) => (choice: Choice) => setDraft((d) => ({ ...d, [stage]: choice }));

  async function start() {
    setTried(true);
    if (missing.length) return;
    setPending(true);
    setError(undefined);
    // A level the model doesn't take drops to the highest it does, as the
    // effort field shows it.
    const trim = (c: Choice): StageChoice => {
      const model = c.model.trim();
      const efforts = effortsFor(model);
      const effort = efforts.includes(c.effort) ? c.effort : efforts[efforts.length - 1];
      return { provider: c.provider, model, ...(c.provider === "meta" && { effort }) };
    };
    const models: RunModels = {
      investigate: trim(draft.investigate),
      ...(draft.fanout && { lead: trim(draft.lead) }),
      ...(fixes && { fix: trim(draft.fix) }),
      postmortem: trim(draft.postmortem),
    };
    try {
      const res = await fetch(`/api/incidents/${incident.id}/reruns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ models }),
      });
      const data = (await res.json().catch(() => ({}))) as { number?: number; error?: string };
      if (!res.ok || !data.number) throw new Error(data.error ?? `HTTP ${res.status}`);
      toast.success(`Run ${data.number} started`, { description: `Investigating with ${models.investigate.model}.` });
      onDone();
      router.push(`${pathname}?run=${data.number}`);
    } catch (err) {
      setError(errorMessage(err));
      setPending(false);
    }
  }

  const row = (stage: DraftStage, aside?: string) => (
    <FormRow title={stageLabels[stage].label} aside={aside}>
      <StageFields
        stage={stage}
        value={draft[stage]}
        onChange={set(stage)}
        providers={settings.providers}
        error={tried && !draft[stage].model.trim() ? "Choose a model, or enter its ID." : undefined}
      />
    </FormRow>
  );

  return (
    <>
      <div className="-mx-1 flex max-h-[60vh] flex-col gap-4 overflow-y-auto px-1">
        <FormRows title="Models">
          {row("investigate")}
          <div className="flex items-center justify-between gap-6 p-4">
            <div className="flex min-w-0 flex-col gap-0.5">
              <label htmlFor="rerun-fanout" className="font-medium text-sm">
                Check hypotheses in parallel
              </label>
              <span className="text-muted-foreground text-xs">
                The Lead proposes up to three causes and Investigate checks each at once.
              </span>
            </div>
            <Switch id="rerun-fanout" checked={draft.fanout} onCheckedChange={(fanout) => setDraft((d) => ({ ...d, fanout }))} />
          </div>
          {draft.fanout && row("lead")}
          {fixes && row("fix", "Proven in the sandbox, not opened as a PR")}
          {row("postmortem", "Once you use this run")}
        </FormRows>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription className="break-words">{error}</AlertDescription>
        </Alert>
      )}
      <DialogFooter>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button onClick={() => void start()} disabled={pending}>
          {pending && <LoaderCircleIcon className="animate-spin" />}
          Start run {next}
        </Button>
      </DialogFooter>
    </>
  );
}

// One stage's provider, model and (on Meta's API) effort, in a row.
function StageFields({
  stage,
  value,
  onChange,
  providers,
  error,
}: {
  stage: DraftStage;
  value: Choice;
  onChange: (choice: Choice) => void;
  providers: Provider[];
  error?: string;
}) {
  const id = useId();
  const provider = providers.find((p) => p.id === value.provider);
  const list = useModelList(provider);
  const [custom, setCustom] = useState(false);
  const listed = !list.loading && !list.error && list.models.length > 0;
  const meta = value.provider === "meta";
  const efforts = effortsFor(value.model);
  const effort = efforts.includes(value.effort) ? value.effort : efforts[efforts.length - 1];
  const missingKey = provider?.keyEnv && !provider.hasKey ? `${provider.keyEnv} is not set.` : undefined;

  return (
    <div className={cn("grid gap-x-4 gap-y-3 sm:col-span-2 sm:grid-cols-2", meta && "sm:grid-cols-[1fr_1.5fr_1fr]")}>
      <FormField label="Provider" htmlFor={`${id}-provider`} error={missingKey}>
        <Select
          value={value.provider}
          onValueChange={(p) => {
            // A model ID rarely carries over to another provider.
            onChange({ ...value, provider: p, model: "" });
            setCustom(false);
          }}
        >
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
      <FormField label="Model" htmlFor={`${id}-model`} error={error}>
        <ModelPicker
          id={`${id}-model`}
          models={list.models}
          loading={list.loading}
          listed={listed}
          value={value.model}
          custom={custom}
          onChange={(model, c) => {
            onChange({ ...value, model });
            setCustom(c);
          }}
        />
      </FormField>
      {meta && (
        <FormField label="Reasoning effort" htmlFor={`${id}-effort`}>
          <Select value={effort} onValueChange={(e) => onChange({ ...value, effort: e as ReasoningEffort })}>
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
  );
}
