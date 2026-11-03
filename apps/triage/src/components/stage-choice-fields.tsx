"use client";

import { useId, useState } from "react";
import { FormField } from "@/components/form-fields";
import type { Provider } from "@/components/model-settings";
import { ModelPicker } from "@/components/model-picker";
import { useModelList } from "@/components/model-stage-row";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { StageChoice } from "@/lib/investigation/schema";
import { defaultEffort, effortLabels, effortsFor, type ReasoningEffort, type StageId } from "@/lib/models/stages";
import { cn } from "@/lib/utils";

// A model chosen for one run or one question rather than saved in Settings:
// the re-run dialog's stages, and the Ask composer's.
export type Choice = Required<StageChoice>;

// What's sent: the model ID trimmed, and the effort only on Meta's API, a
// level the model doesn't take dropping to the highest it does, as the
// effort field shows it.
export function trimChoice(c: Choice): StageChoice {
  const model = c.model.trim();
  const efforts = effortsFor(model);
  const effort = efforts.includes(c.effort) ? c.effort : efforts[efforts.length - 1];
  return { provider: c.provider, model, ...(c.provider === "meta" && { effort }) };
}

// One stage's provider, model and (on Meta's API) effort: side by side in
// a row, or one under another (`stacked`) in a narrow popover.
export function StageFields({
  stage,
  value,
  onChange,
  providers,
  error,
  stacked,
}: {
  stage: StageId;
  value: Choice;
  onChange: (choice: Choice) => void;
  providers: Provider[];
  error?: string;
  stacked?: boolean;
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
    <div
      className={cn(
        "grid gap-x-4 gap-y-3",
        !stacked && "sm:col-span-2 sm:grid-cols-2",
        !stacked && meta && "sm:grid-cols-[1fr_1.5fr_1fr]",
      )}
    >
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
