// What the server and the Settings page agree on about notifications. A
// person picks which of three events send a message; each event has one or
// two kinds of message (a new incident or the same one back; a fix ready,
// then its draft PR).

export const notificationEvents = ["incident_opened", "fix_ready", "resolved"] as const;
export type NotificationEvent = (typeof notificationEvents)[number];

export const eventLabels: Record<NotificationEvent, { label: string; description: string }> = {
  incident_opened: { label: "Incident opened", description: "Watch opens an incident, or reopens one that came back." },
  fix_ready: { label: "Fix ready for review", description: "A proven fix awaits approval, and its draft PR once opened." },
  resolved: { label: "Incident resolved", description: "The quiet window confirms the fix, or a person resolves it." },
};

export const messageKinds = ["incident_opened", "incident_reopened", "fix_ready", "pr_opened", "resolved"] as const;
export type MessageKind = (typeof messageKinds)[number];

// The preference that turns each kind of message on or off.
export const eventOf: Record<MessageKind, NotificationEvent> = {
  incident_opened: "incident_opened",
  incident_reopened: "incident_opened",
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

// What the browser sees. Never the webhook URL: only whether one is saved
// and its last few characters, to tell two apart.
export type PublicNotificationSettings = {
  slack: { configured: boolean; hint?: string };
  events: Record<NotificationEvent, boolean>;
  // The latest attempts, newest first, at most 20.
  deliveries: Delivery[];
};

// Only Slack incoming webhooks: the URL is a secret, and the server posts
// to nothing else.
export const slackWebhookPattern = /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_/-]+$/;
