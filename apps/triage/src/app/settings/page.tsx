import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { type ArchivedIncident, ArchivedIncidentSettings } from "@/components/archived-incident-settings";
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
import { isExample, listIncidents } from "@/lib/investigation/store";

export const metadata: Metadata = { title: "Settings · Triage" };

// Settings, in five sections beside a menu, as the incident report lays out
// its own: General (Appearance and Speech, saved in this browser), then
// what's saved on the server, the models, the notifications, the
// postmortem template and the archived incidents. Each section is a bordered list of rows: a label and
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
            archived: (
              <Suspense fallback={<Skeleton className="h-48 w-full" />}>
                <ArchivedIncidents />
              </Suspense>
            ),
          }}
        />
      </Suspense>
    </div>
  );
}

// The archived incidents, newest archived first, read per request. Whole
// records, for what deleting one takes with it (its postmortem, Ask
// questions, re-runs), but only what the list and the delete dialog show
// goes to the browser.
async function ArchivedIncidents() {
  await connection();
  const incidents: ArchivedIncident[] = (await listIncidents({ archived: "only" }))
    .flatMap((i) =>
      i.archivedAt
        ? [
            {
              id: i.id,
              title: i.title,
              service: i.service,
              severity: i.severity,
              status: i.status,
              resolvedAt: i.resolvedAt,
              archivedAt: i.archivedAt,
              example: isExample(i.id),
              attached: {
                postmortem: i.postmortem !== undefined,
                questions: i.questions?.length ?? 0,
                reruns: i.reruns?.length ?? 0,
              },
            },
          ]
        : [],
    )
    .sort((a, b) => Date.parse(b.archivedAt) - Date.parse(a.archivedAt));
  return <ArchivedIncidentSettings incidents={incidents} />;
}

function Appearance() {
  return (
    <section aria-labelledby="appearance" className="flex flex-col gap-3">
      <SettingsSectionHeader id="appearance" title="Appearance" />
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
          <span id="code-font-label" className="font-medium text-sm">
            Code font size
          </span>
          <CodeFontSizeSelect aria-labelledby="code-font-label" />
        </div>
      </div>
    </section>
  );
}
