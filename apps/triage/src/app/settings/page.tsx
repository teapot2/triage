import type { Metadata } from "next";
import { Suspense } from "react";
import { CodeFontSizeSelect } from "@/components/code-font-size-select";
import { ColorThemeSelect } from "@/components/color-theme-select";
import { ModelSettings } from "@/components/model-settings";
import { NotificationSettings } from "@/components/notification-settings";
import { PostmortemTemplateSettings } from "@/components/postmortem-template-settings";
import { SettingsSectionHeader } from "@/components/settings-list";
import { SettingsView } from "@/components/settings-view";
import { SpeechSettings } from "@/components/speech-settings";
import { ThemeSelect } from "@/components/theme-select";
import { Skeleton } from "@/components/ui/skeleton";

export const metadata: Metadata = { title: "Settings · Triage" };

// Settings, in four sections beside a menu, as the incident report lays out
// its own: General (Appearance and Speech, saved in this browser), then
// what's saved on the server, the models, the notifications and the
// postmortem template. Each section is a bordered list of rows: a label and
// one-line description on the left, the control on the right. The watch's
// rules have their own page, /watch.
export default function SettingsPage() {
  return (
    <div className="@container mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 pt-2 pb-8 md:pt-8 sm:px-6">
      <h1 className="font-heading font-semibold text-2xl tracking-tight">Settings</h1>
      {/* The open section is read from the URL, which the prerendered shell
          doesn't know. */}
      <Suspense fallback={<Skeleton className="h-96 w-full" />}>
        <SettingsView
          content={{
            general: (
              <div className="flex flex-col gap-6">
                <Appearance />
                <SpeechSettings />
              </div>
            ),
            models: <ModelSettings />,
            notifications: <NotificationSettings />,
            postmortems: <PostmortemTemplateSettings />,
          }}
        />
      </Suspense>
    </div>
  );
}

function Appearance() {
  return (
    <section aria-labelledby="appearance" className="flex flex-col gap-3">
      <SettingsSectionHeader id="appearance" title="Appearance" description="Saved in this browser." />
      <div className="divide-y rounded-lg border">
        <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <span id="mode-label" className="font-medium text-sm">
            Mode
          </span>
          <ThemeSelect aria-labelledby="mode-label" />
        </div>
        <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col gap-0.5">
            <span id="color-theme-label" className="font-medium text-sm">
              Theme
            </span>
          </div>
          <ColorThemeSelect aria-labelledby="color-theme-label" />
        </div>
        <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col gap-0.5">
            <span id="code-font-label" className="font-medium text-sm">
              Code font size
            </span>
            <span className="text-muted-foreground text-sm">
              Text size in code viewers: evidence source, queries and fix diffs.
            </span>
          </div>
          <CodeFontSizeSelect aria-labelledby="code-font-label" />
        </div>
      </div>
    </section>
  );
}
