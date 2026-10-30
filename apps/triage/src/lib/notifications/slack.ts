import { metricLabel } from "@/components/incident/metric-labels";
import type { Incident } from "../investigation/schema";
import { withUnit } from "../investigation/postmortem/timeline";
import type { MessageKind } from "./types";

// The Slack message for each kind of notification: Slack's mrkdwn in one
// section block, plus a plain-text fallback for the push notification. Links
// are <url|label> text, not buttons: an incoming webhook has nowhere for
// Slack to send a button press. Pure, so the tests can read every message.

// Slack reads &, < and > as its own markup, and the incident's text comes
// from a model and from the app under watch.
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// A link's URL can't hold the characters that end it.
const link = (url: string, label: string) => `<${url.replace(/[<>|]/g, encodeURIComponent)}|${esc(label)}>`;

const short = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

// "45 s", "23 min", "2 h 5 min"
function took(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return `${Math.max(1, Math.round(ms / 1000))} s`;
  if (minutes < 60) return `${minutes} min`;
  return minutes % 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes / 60} h`;
}

// What tripped, in words: the watch rule when there is one, with what was
// observed against its limit.
function whatTripped({ trigger }: Incident): string {
  const observed = withUnit(Number(trigger.observed.toFixed(1)), trigger.unit);
  const limit = withUnit(trigger.threshold, trigger.unit);
  const what = trigger.rule?.description ?? metricLabel(trigger.metric);
  return `${esc(what)}: ${esc(observed)} observed, limit ${esc(limit)}`;
}

export function slackMessage(
  kind: MessageKind | "test",
  incident: Incident | undefined,
  baseUrl: string,
): { text: string; blocks: unknown[] } {
  // `text` is the fallback; the lines (those that exist) are the block.
  const message = (text: string, ...lines: (string | false | undefined)[]) => ({
    text,
    blocks: [{ type: "section", text: { type: "mrkdwn", text: lines.filter(Boolean).join("\n") } }],
  });

  if (kind === "test" || !incident) {
    return message(
      "Test from Triage: Slack notifications are working",
      "*Test from Triage:* Slack notifications are working.",
      link(`${baseUrl}/settings`, "Notification settings"),
    );
  }

  const url = `${baseUrl}/incidents/${incident.id}`;
  const sev = incident.severity.toUpperCase();
  const title = link(url, incident.title);
  const head = `${sev} · ${esc(incident.service)}`;
  const prUrl = incident.approval?.prUrl;
  const pr = (label: string) => prUrl && link(prUrl, label);

  switch (kind) {
    case "incident_opened":
      return message(
        `New ${sev} incident: ${esc(incident.title)}`,
        `*New incident* · ${head}`,
        title,
        whatTripped(incident),
        "Triage is investigating.",
      );
    case "incident_reopened": {
      const why = incident.reopenings?.at(-1)?.why;
      return message(
        `${sev} incident is back: ${esc(incident.title)}`,
        `*Incident is back* · ${head}`,
        title,
        why && esc(why),
        "It was resolved and has come back, so Triage reopened it.",
      );
    }
    case "fix_ready":
      return message(
        `Fix ready for review on ${sev} incident: ${esc(incident.title)}`,
        `*Fix ready for review* · ${head}`,
        title,
        incident.fix && esc(short(incident.fix.summary, 400)),
        "Triage proved it in a sandbox. " + link(url, "Review and approve it in Triage"),
        pr("Draft PR"),
      );
    case "pr_opened":
      return message(
        `Draft PR opened for ${sev} incident: ${esc(incident.title)}`,
        `*Draft PR opened* · ${head}`,
        title,
        "The approved fix is up for review.",
        pr("Open the draft PR"),
      );
    case "resolved": {
      const open =
        incident.resolvedAt && took(Date.parse(incident.resolvedAt) - Date.parse(incident.detectedAt));
      const v = incident.verification;
      const by =
        v?.after === "uptime"
          ? `Triage confirmed it: ${v.series.length} checks in a row answered in time.`
          : v?.status === "resolved"
            ? "Triage confirmed it: the metric stayed under its limit for the whole quiet window."
            : "A person marked it resolved.";
      return message(
        `Resolved: ${esc(incident.title)}`,
        `*Incident resolved* · ${head}`,
        title,
        open && `Open for ${open}. ${by}`,
        !open && by,
      );
    }
  }
}
