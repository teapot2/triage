import { dataChangeOf } from "../investigation/fix/data-change";
import type { Incident } from "../investigation/schema";
import { withUnit } from "../investigation/postmortem/timeline";
import type { MessageKind } from "./types";

// The Slack message for each kind of notification: a bold status line, then
// a card with a colored edge (red or amber for an incident by severity,
// violet for a fix, green once resolved) holding the incident's title, what
// matters about this event, and the details in small type. `text` is the
// plain-text fallback for the push notification. Links are <url|label> text,
// not buttons: an incoming webhook has nowhere for Slack to send a button
// press. Pure, so the tests can read every message.

export type SlackMessage = {
  text: string;
  blocks: unknown[];
  attachments: { color: string; blocks: unknown[] }[];
};

const colors = {
  urgent: "#E01E5A",
  incident: "#ECB22E",
  fix: "#7D3DF3",
  resolved: "#2EB67D",
};

// Slack reads &, < and > as its own markup, and the incident's text comes
// from a model and from the app under watch.
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// A link's URL can't hold the characters that end it.
const link = (url: string, label: string) => `<${url.replace(/[<>|]/g, encodeURIComponent)}|${esc(label)}>`;

const short = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

// Every line of the text as a Slack quote.
const quote = (s: string) => s.split("\n").map((line) => `>${line}`).join("\n");

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// "45 s", "23 min", "2 h 5 min"
function took(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return `${Math.max(1, Math.round(ms / 1000))} s`;
  if (minutes < 60) return `${minutes} min`;
  return minutes % 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes / 60} h`;
}

// In the trigger's own unit, which the rule in the title uses too: whole
// numbers from 100 up ("5063 ms"), one decimal below ("4.4%").
const rounded = (v: number) => (Math.abs(v) >= 100 ? Math.round(v) : Number(v.toFixed(1)));

// What was observed against the limit, without the rule: the title says it.
// A dependency incident's "1 advisories observed · limit 1" says nothing:
// its advisory and how many audits found it say what it is.
function measured({ trigger, dependency }: Incident): string {
  if (dependency) return `${esc(dependency.advisoryId)} · found by ${plural(dependency.audits, "audit")}`;
  return `${esc(withUnit(rounded(trigger.observed), trigger.unit))} observed · limit ${esc(withUnit(trigger.threshold, trigger.unit))}`;
}

const section = (text: string) => ({ type: "section", text: { type: "mrkdwn", text } });
const context = (parts: (string | false | undefined)[]) => ({
  type: "context",
  elements: [{ type: "mrkdwn", text: parts.filter(Boolean).join(" · ") }],
});

export function slackMessage(kind: MessageKind | "test", incident: Incident | undefined, baseUrl: string): SlackMessage {
  // The status line above the card, then the card: its lines as sections
  // (those that exist) and the details in small type last.
  const message = (
    text: string,
    status: string,
    color: string,
    lines: (string | false | undefined)[],
    details: (string | false | undefined)[],
  ): SlackMessage => ({
    text,
    blocks: [section(status)],
    attachments: [
      {
        color,
        blocks: [...lines.filter((l): l is string => !!l).map(section), context(details)],
      },
    ],
  });

  if (kind === "test" || !incident) {
    return message(
      "Test from Triage: Slack notifications are working",
      "*Test from Triage*",
      colors.fix,
      ["Slack notifications are working."],
      [link(`${baseUrl}/settings`, "Notification settings")],
    );
  }

  const url = `${baseUrl}/incidents/${incident.id}`;
  const sev = incident.severity.toUpperCase();
  const title = `*${link(url, incident.title)}*`;
  const about = [sev, esc(incident.service)];
  const alarm = incident.severity === "sev1" || incident.severity === "sev2" ? colors.urgent : colors.incident;
  const prUrl = incident.approval?.prUrl;
  const pr = (label: string) => prUrl && link(prUrl, label);

  switch (kind) {
    case "incident_opened":
      return message(
        `New ${sev} incident: ${esc(incident.title)}`,
        incident.dependency ? `*${advisoryStatus(incident)}*` : "*New incident*",
        alarm,
        [title],
        [...about, measured(incident), "Triage is investigating"],
      );
    case "incident_reopened": {
      const why = incident.reopenings?.at(-1)?.why;
      return message(
        `${sev} incident is back: ${esc(incident.title)}`,
        "*Incident is back*",
        alarm,
        [title, why && esc(why)],
        [...about, measured(incident), "Resolved earlier, so Triage reopened it"],
      );
    }
    case "mitigation_proposed": {
      const m = incident.mitigation;
      return message(
        `Mitigation proposed for ${sev} incident: ${esc(incident.title)}`,
        "*Mitigation proposed*",
        colors.fix,
        [title, m && `*${esc(m.title)}*`, m && esc(short(m.why.text, 400)), m && `Undo: ${esc(m.undo)}`],
        [...about, m && `${m.risk.replace("_", " ")} risk`, link(url, "Approve or deny it in Triage")],
      );
    }
    case "fix_ready": {
      // A fix that changes stored data says so up front, where it shows in
      // the push notification too.
      const fix = incident.fix;
      const data = fix !== undefined && dataChangeOf(fix).detected;
      const cause = incident.report?.summary;
      return message(
        `Fix ready for review${data ? " (changes stored data)" : ""} on ${sev} incident: ${esc(incident.title)}`,
        `*Fix ready for review*${data ? " · changes stored data" : ""}`,
        colors.fix,
        [
          title,
          cause && `*What happened:* ${esc(cause)}`,
          fix && quote(esc(short(fix.summary, 400))),
          data && "Triage proved the code in a sandbox. It also *changes stored data*, which the sandbox can't prove.",
        ],
        [
          ...about,
          fix && plural(fix.files.length, "file"),
          fix && `${fix.risk} risk`,
          !data && "Proven in a sandbox",
          data
            ? link(url, "Review the data change and approve it in Triage")
            : link(url, "Review and approve it in Triage"),
          pr("Draft PR"),
        ],
      );
    }
    case "pr_opened":
      return message(
        `Draft PR opened for ${sev} incident: ${esc(incident.title)}`,
        "*Draft PR opened*",
        colors.fix,
        [title, "The approved fix is up for review.", pr("Open the draft PR")],
        about,
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
        open ? `*Resolved after ${open}*` : "*Incident resolved*",
        colors.resolved,
        [title, by],
        about,
      );
    }
  }
}

// When something happened, in each reader's own time zone.
const slackTime = (iso: string) => `<!date^${Math.floor(Date.parse(iso) / 1000)}^{time}|${iso.slice(11, 16)} UTC>`;

// Who decided, as Slack shows them: a mention for a click in Slack, else
// the name the page recorded, if any.
const decided = ({ decidedBy, decidedInSlack }: { decidedBy?: string; decidedInSlack?: string }) =>
  decidedInSlack ? `by <@${decidedInSlack}>` : decidedBy ? `by ${esc(decidedBy)}` : "in Triage";

// A dependency incident's status line while it's worked on: the package,
// the version found and the advisory's severity, then the exposure once
// the run has said.
const exposureWords = { reachable: "reachable from the code", transitive_only: "not reached by the code", not_reachable: "not run in production" };
function advisoryStatus(i: Incident): string | undefined {
  const d = i.dependency;
  if (!d) return undefined;
  const exposure = i.report?.exposure?.verdict;
  return `Dependency advisory: ${esc(d.package)}@${esc(d.versions[0])} (${d.severity})${exposure ? ` · ${exposureWords[exposure]}` : ""}`;
}

// Where the incident stands, for the card's status line and color.
function cardStatus(i: Incident): { status: string; color: string } {
  const alarm = i.severity === "sev1" || i.severity === "sev2" ? colors.urgent : colors.incident;
  const m = i.mitigation?.state;
  const a = i.approval;
  if (i.status === "resolved") {
    const open = i.resolvedAt && took(Date.parse(i.resolvedAt) - Date.parse(i.detectedAt));
    return { status: open ? `Resolved after ${open}` : "Resolved", color: colors.resolved };
  }
  if (i.status === "healthy") return { status: "Nothing wrong found", color: colors.resolved };
  if (m === "proposed") return { status: "Mitigation waiting for approval", color: colors.fix };
  if (a?.state === "pending") return { status: "Fix ready for review", color: colors.fix };
  if (m === "approved" || m === "running") return { status: "Applying the mitigation", color: colors.fix };
  if (a?.prState === "opening") return { status: "Opening the draft PR", color: colors.fix };
  if (a?.prState === "opened") return { status: "Draft PR opened", color: colors.fix };
  if (m === "applied") return { status: "Mitigation applied, watching recovery", color: colors.fix };
  if (i.status === "failed") return { status: "Investigation failed", color: alarm };
  const advisory = advisoryStatus(i);
  if (i.status === "investigating") return { status: advisory ?? "Investigating", color: alarm };
  return { status: advisory ?? "Diagnosed", color: alarm };
}

function mitigationWords(m: NonNullable<Incident["mitigation"]>): string {
  switch (m.state) {
    case "proposed":
      return `waiting for approval · ${m.risk.replace("_", " ")} risk`;
    case "approved":
    case "running":
      return `approved ${decided(m)}, running`;
    case "applied":
      return `approved ${decided(m)} · applied ${slackTime(m.appliedAt ?? m.decidedAt ?? m.proposedAt)}`;
    case "denied":
      return `denied ${decided(m)}`;
    case "failed":
      return `failed: ${esc(short(m.error ?? "unknown error", 200))}`;
  }
}

function fixWords(i: Incident): string {
  const a = i.approval!;
  if (a.state === "pending") return i.fix && dataChangeOf(i.fix).detected ? "waiting for review · changes stored data" : "waiting for review";
  if (a.state === "denied") return `denied ${decided(a)}`;
  if (a.prState === "opened" && a.prUrl) return `approved ${decided(a)} · ${link(a.prUrl, "draft PR")}`;
  if (a.prState === "failed") return `approved ${decided(a)} · the PR failed: ${esc(short(a.prError ?? "unknown error", 200))}`;
  return `approved ${decided(a)} · opening the PR`;
}

const plain = (text: string) => ({ type: "plain_text", text });

// A button that asks first, saying what it will do.
const button = (text: string, actionId: string, value: string, style?: "primary" | "danger", confirm?: string) => ({
  type: "button",
  text: plain(text),
  action_id: actionId,
  value,
  ...(style && { style }),
  ...(confirm && {
    // Slack shows a confirm's text as typed, without formatting.
    confirm: { title: plain(`${text}?`), text: plain(short(confirm, 300)), confirm: plain(text), deny: plain("Cancel") },
  }),
});

// The buttons for what waits on a person. A fix that changes stored data
// has none to approve it: the page asks the approver to confirm they
// reviewed the data change, which a button can't. A mitigation is only for
// an incident still open; a fix waiting for review still waits once the
// incident is resolved, as on the page.
export function cardActions(i: Incident, url: string): unknown[] {
  const m = i.mitigation;
  const open = i.status !== "resolved" && i.status !== "healthy";
  const buttons: unknown[] = [];
  if (open && m && (m.state === "proposed" || m.state === "failed")) {
    const label = m.state === "failed" ? "Retry mitigation" : "Approve mitigation";
    buttons.push(button(label, "mitigation_approve", i.id, "primary", `${m.title}.\nUndo: ${m.undo}`));
    if (m.state === "proposed") buttons.push(button("Deny", "mitigation_deny", i.id, "danger"));
  }
  const pending = i.approval?.state === "pending" && i.fix;
  if (pending && !dataChangeOf(pending).detected) {
    buttons.push(button("Approve fix", "fix_approve", i.id, "primary", `Approving opens a draft PR:\n${pending.summary}`));
  }
  if (!buttons.length && !pending) return [];
  return [...buttons, { type: "button", text: plain(pending && !buttons.length ? "Review in Triage" : "Open in Triage"), url, action_id: "open_triage" }];
}

// The incident's first message in Slack, rebuilt from its current state each
// time something changes: the status line and color say where it stands, the
// card what was found and what waits on whom. With interactive on, the
// buttons let a person on the approver list decide from Slack.
export function incidentCard(incident: Incident, baseUrl: string, opts: { interactive?: boolean } = {}): SlackMessage {
  const url = `${baseUrl}/incidents/${incident.id}`;
  const { status, color } = cardStatus(incident);
  const m = incident.mitigation;
  const lines = [
    `*${link(url, incident.title)}*`,
    incident.report?.summary && `*What happened:* ${esc(incident.report.summary)}`,
    m && `*Mitigation:* ${esc(m.title)} · ${mitigationWords(m)}`,
    incident.fix && incident.approval && `*Fix:* ${esc(short(incident.fix.summary, 200))} · ${fixWords(incident)}`,
  ].filter((l): l is string => !!l);
  const actions = opts.interactive ? cardActions(incident, url) : [];
  return {
    text: `${status}: ${esc(incident.title)}`,
    blocks: [section(`*${status}*`)],
    attachments: [
      {
        color,
        blocks: [
          ...lines.map(section),
          ...(actions.length ? [{ type: "actions", block_id: "triage_actions", elements: actions }] : []),
          context([incident.severity.toUpperCase(), esc(incident.service), measured(incident)]),
        ],
      },
    ],
  };
}
