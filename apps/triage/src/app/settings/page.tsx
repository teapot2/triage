import type { Metadata } from "next";
import { CodeFontSizeSelect } from "@/components/code-font-size-select";
import { ColorThemeSelect } from "@/components/color-theme-select";
import { ModelSettings } from "@/components/model-settings";
import { NotificationSettings } from "@/components/notification-settings";
import { PostmortemTemplateSettings } from "@/components/postmortem-template-settings";
import { SpeechSettings } from "@/components/speech-settings";
import { ThemeSelect } from "@/components/theme-select";

export const metadata: Metadata = { title: "Settings · Triage" };

// Settings. Each section is a bordered list of rows: a label and one-line
// description on the left, the control on the right. Appearance is per
// browser, and so is Speech; the models, the notifications and the postmortem
// template are saved on the server. The watch's rules have their own page,
// /watch.
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

      <SpeechSettings />

      <ModelSettings />

      <NotificationSettings />

      <PostmortemTemplateSettings />
    </div>
  );
}
