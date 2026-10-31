"use client";

import { useEffect, useRef, useState } from "react";
import { presets, profileFields, type Profile, type ProfileField, type ProfileKey } from "@/lib/traffic-profile";
import { cn } from "@/lib/utils";

const SEND_AFTER_MS = 300;
// After an edit, polls leave the sliders alone for this long, so a poll
// that left before the edit landed doesn't snap them back.
const HOLD_MS = 2000;

const groups = ["Rate", "Visitors", "Shoppers", "Bad requests"] as const;
const mixKeys: ProfileKey[] = ["shoppers", "readers", "app", "crawlers"];

const sameProfile = (a: Profile, b: Profile) => profileFields.every((f) => a[f.key] === b[f.key]);

// Edits the running traffic's profile: a preset in one click, or any value
// on its own. Changes go to the server as they're made and apply to the
// next visitor, running or not.
export function ProfileEditor({
  profile,
  onChange,
}: {
  profile: Profile;
  onChange: (profile: Partial<Profile>) => Promise<void>;
}) {
  const [draft, setDraft] = useState(profile);
  const pending = useRef<Partial<Profile>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRef(false);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!held.current) setDraft(profile);
  }, [profile]);

  const send = (change: Partial<Profile>, now = false) => {
    held.current = true;
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = setTimeout(() => (held.current = false), HOLD_MS);
    setDraft((d) => ({ ...d, ...change }));
    pending.current = { ...pending.current, ...change };
    if (timer.current) clearTimeout(timer.current);
    const flush = () => {
      const batch = pending.current;
      pending.current = {};
      void onChange(batch);
    };
    if (now) flush();
    else timer.current = setTimeout(flush, SEND_AFTER_MS);
  };

  const mixTotal = mixKeys.reduce((n, k) => n + draft[k], 0) || 1;

  return (
    <div>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Presets">
        {presets.map((p) => {
          const current = sameProfile(draft, p.profile);
          return (
            <button
              key={p.name}
              type="button"
              title={p.description}
              aria-pressed={current}
              onClick={() => send(p.profile, true)}
              className={cn(
                "rounded-lg border px-3 py-1.5 text-left text-sm transition-colors",
                current ? "border-primary bg-primary/10 font-medium" : "bg-card hover:bg-secondary",
              )}
            >
              {p.name}
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {presets.find((p) => sameProfile(draft, p.profile))?.description ?? "Custom profile."}
      </p>

      <div className="mt-5 grid gap-x-8 gap-y-6 md:grid-cols-2 xl:grid-cols-4">
        {groups.map((g) => (
          <fieldset key={g}>
            <legend className="text-sm font-medium">{g}</legend>
            <div className="mt-3 space-y-4">
              {profileFields
                .filter((f) => f.group === g)
                .map((f) => (
                  <Slider
                    key={f.key}
                    field={f}
                    value={draft[f.key]}
                    shown={mixKeys.includes(f.key) ? `${Math.round((draft[f.key] / mixTotal) * 100)}%` : undefined}
                    onChange={(v) => send({ [f.key]: v })}
                  />
                ))}
            </div>
          </fieldset>
        ))}
      </div>
    </div>
  );
}

function Slider({
  field,
  value,
  shown,
  onChange,
}: {
  field: ProfileField;
  value: number;
  // What to show instead of the raw value, such as a share of the mix.
  shown?: string;
  onChange: (value: number) => void;
}) {
  const id = `profile-${field.key}`;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <label htmlFor={id} title={field.help} className="text-muted-foreground">
          {field.label}
        </label>
        <output htmlFor={id} className="font-medium tabular-nums">
          {shown ?? `${value}${field.unit ? (field.unit === "%" || field.unit === "×" ? field.unit : ` ${field.unit}`) : ""}`}
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={field.min}
        max={field.max}
        step={field.step}
        value={value}
        aria-describedby={`${id}-help`}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 w-full accent-primary"
      />
      <p id={`${id}-help`} className="text-xs text-muted-foreground">
        {field.help}
      </p>
    </div>
  );
}
