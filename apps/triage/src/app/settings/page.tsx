import type { Metadata } from "next";
import { ModelSettings } from "@/components/model-settings";
import { ThemeSelect } from "@/components/theme-select";

export const metadata: Metadata = { title: "Settings · Triage" };

// Settings. Each section is a bordered list of rows: a label and one-line
// description on the left, the control on the right. Appearance is per
// browser; the models are saved on the server.
export default function SettingsPage() {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 pt-2 pb-8 md:pt-8 sm:px-6">
      <h1 className="font-heading font-semibold text-2xl tracking-tight">Settings</h1>

      <section aria-labelledby="appearance" className="flex flex-col gap-3">
        <h2 id="appearance" className="font-heading font-medium text-base">
          Appearance
        </h2>
        <div className="divide-y rounded-lg border">
          <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-col gap-0.5">
              <span id="theme-label" className="font-medium text-sm">
                Theme
              </span>
              <span className="text-muted-foreground text-sm">
                System follows your device&apos;s light or dark setting.
              </span>
            </div>
            <ThemeSelect aria-labelledby="theme-label" />
          </div>
        </div>
      </section>

      <ModelSettings />
    </div>
  );
}
