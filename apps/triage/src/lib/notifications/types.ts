import type { SlackNames } from "./slack-api";

// What the server and the Settings page agree on about notifications. A
// person picks which of four events send a message; each event has one or
// two kinds of message (a new incident or the same one back; a fix ready,
// then its draft PR).

export const notificationEvents = ["incident_opened", "mitigation_proposed", "fix_ready", "resolved"] as const;
export type NotificationEvent = (typeof notificationEvents)[number];

export const eventLabels: Record<NotificationEvent, { label: string }> = {
  incident_opened: { label: "Incident opened" },
  mitigation_proposed: { label: "Mitigation proposed" },
  fix_ready: { label: "Fix ready for review" },
  resolved: { label: "Incident resolved" },
};

export const messageKinds = [
  "incident_opened",
  "incident_reopened",
  "mitigation_proposed",
  "fix_ready",
  "pr_opened",
  "resolved",
] as const;
export type MessageKind = (typeof messageKinds)[number];

// The preference that turns each kind of message on or off.
export const eventOf: Record<MessageKind, NotificationEvent> = {
  incident_opened: "incident_opened",
  incident_reopened: "incident_opened",
  mitigation_proposed: "mitigation_proposed",
  fix_ready: "fix_ready",
  pr_opened: "fix_ready",
  resolved: "resolved",
};

// One attempt to send a message, newest first in the log.
export type Delivery = {
  at: string;
  kind: MessageKind | "test";
  incidentId?: string;
  ok: boolean;
  // Why it failed: Slack's status and reply ("404 no_service"), or the
  // network error.
  error?: string;
};

// Whether the Slack bot's socket is up: "off" without an app token,
// "failed" with the reason after Slack refused it or it dropped for good.
export type SlackSocketState = { state: "off" | "connecting" | "connected" | "failed"; error?: string };

// What the browser sees. Never the webhook URL or a token: only whether one
// is saved and its last few characters, to tell two apart.
export type PublicNotificationSettings = {
  slack: { configured: boolean; hint?: string };
  // The Slack bot: posts through the Web API, one thread per incident, and
  // takes button clicks over Socket Mode. Channel and approver IDs are not
  // secrets, so they come back whole.
  bot: {
    configured: boolean;
    botHint?: string;
    appHint?: string;
    channel?: string;
    approvers: string[];
    socket: SlackSocketState;
    // Names for the IDs above, from Slack; missing while no bot token is
    // saved.
    names?: SlackNames;
  };
  events: Record<NotificationEvent, boolean>;
  // The latest attempts, newest first, at most 20.
  deliveries: Delivery[];
};

// Only Slack incoming webhooks: the URL is a secret, and the server posts
// to nothing else.
export const slackWebhookPattern = /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_/-]+$/;

// The Slack bot's settings: a bot token (xoxb-, chat:write), an app-level
// token (xapp-, connections:write) for Socket Mode, the channel to post in,
// and the member IDs of the people who may approve from Slack.
export const slackBotTokenPattern = /^xoxb-[A-Za-z0-9-]+$/;
export const slackAppTokenPattern = /^xapp-[A-Za-z0-9-]+$/;
export const slackChannelPattern = /^[CG][A-Z0-9]{6,}$/;
export const slackUserPattern = /^[UW][A-Z0-9]{6,}$/;
