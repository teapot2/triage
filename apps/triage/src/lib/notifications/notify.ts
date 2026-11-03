import type { Incident } from "../investigation/schema";
import { getIncident, patchIncident } from "../investigation/store";
import { readNotificationSettings, readSlackBot, type SlackBot } from "../models/settings";
import { claim, record, recentDeliveries } from "./log";
import { incidentCard, type SlackMessage, slackMessage } from "./slack";
import { lookupNames, postMessage, type SlackNames, updateMessage } from "./slack-api";
import { slackSocketStatus } from "./socket";
import { type Delivery, eventOf, type MessageKind, type PublicNotificationSettings } from "./types";
import { errorMessage } from "../errors";

// Sends a Slack message when something happens to an incident, once per
// event, and keeps a log of the attempts for Settings. A failed send is
// logged and goes no further: nothing that called notify() waits for it or
// sees an error from it. The webhook URL and the bot's token are secrets:
// read here, used, and never logged or returned.
//
// Two ways to send. With the Slack bot set up (a bot token and a channel),
// an incident's first event posts its card, every later one replies in the
// card's thread, and the card is updated to where the incident stands. With
// only a webhook, each event is a message of its own. A bot that fails
// falls back to the webhook when one is saved.

// The log of attempts and of the events already sent is in log.ts.

const RETRY_AFTER_MS = 1000;
const TIMEOUT_MS = 5000;

// What identifies one event on an incident, taken from its state: the same
// state gives the same key however many times notify() is called. Undefined
// when the state the event is about is missing.
function keyOf(kind: MessageKind, i: Incident): string | undefined {
  switch (kind) {
    case "incident_opened":
      return `${i.id}:opened`;
    case "incident_reopened": {
      const last = i.reopenings?.at(-1);
      return last && `${i.id}:reopened:${last.at}`;
    }
    case "mitigation_proposed":
      return i.mitigation && `${i.id}:mitigation:${i.mitigation.proposedAt}`;
    case "fix_ready":
      return i.approval && `${i.id}:fix_ready:${i.approval.requestedAt}`;
    case "pr_opened":
      return i.approval?.prUrl && `${i.id}:pr:${i.approval.prUrl}`;
    case "resolved":
      return i.resolvedAt && `${i.id}:resolved:${i.resolvedAt}`;
  }
}

// Where the links in a message point: this Triage, as the team reaches it.
const baseUrl = () => (process.env.TRIAGE_URL || "http://localhost:3000").replace(/\/+$/, "");

type Attempt = { error?: string; retry?: boolean };

async function post(url: string, body: string): Promise<Attempt> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) return {};
    const reply = await res.text().catch(() => "");
    // Rate limited or Slack's own trouble may pass in a second; a 404 won't.
    return { error: `${res.status} ${reply.slice(0, 200)}`.trim(), retry: res.status === 429 || res.status >= 500 };
  } catch (err) {
    return { error: errorMessage(err), retry: true };
  }
}

// Posts the message, once more after a second if the first try may have
// been a hiccup. Returns why it failed, or undefined.
async function send(url: string, message: SlackMessage): Promise<string | undefined> {
  const body = JSON.stringify(message);
  let attempt = await post(url, body);
  if (attempt.error && attempt.retry) {
    await new Promise((resolve) => setTimeout(resolve, RETRY_AFTER_MS));
    attempt = await post(url, body);
  }
  return attempt.error;
}

// Changes to one incident's card, chained so two events at once can't both
// find no card and post two. On globalThis: one chain per incident across
// dev hot reloads.
const cards = globalThis as unknown as { triageSlackCards?: Map<string, Promise<unknown>> };

function onCard<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const chains = (cards.triageSlackCards ??= new Map());
  const run = (chains.get(id) ?? Promise.resolve()).then(fn);
  const settled = run.catch(() => {});
  chains.set(id, settled);
  void settled.then(() => chains.get(id) === settled && chains.delete(id));
  return run;
}

type ReadyBot = SlackBot & { botToken: string; channel: string };
const botReady = (bot: SlackBot): bot is ReadyBot => !!(bot.botToken && bot.channel);

// Buttons only when a click can reach Triage and someone may click.
const interactive = (bot: SlackBot) => !!bot.appToken && bot.approvers.length > 0;

// Posts the event through the bot: the card first if the incident has none,
// then the event's message in its thread (an opened incident's card is its
// message), and the card brought up to date. Returns why it failed.
function viaBot(bot: ReadyBot, kind: MessageKind, id: string) {
  return onCard(id, async (): Promise<string | undefined> => {
    const incident = await getIncident(id);
    if (!incident) return `unknown incident: ${id}`;
    const card = incidentCard(incident, baseUrl(), { interactive: interactive(bot) });
    let thread = incident.slack;
    if (!thread) {
      const posted = await postMessage(bot.botToken, bot.channel, card);
      if (!posted.ok) return posted.error;
      const saved = { channel: posted.channel ?? bot.channel, ts: posted.ts! };
      await patchIncident(id, (i) => ({ ...i, slack: saved }));
      if (kind === "incident_opened") return undefined;
      thread = saved;
    } else {
      const updated = await updateMessage(bot.botToken, thread.channel, thread.ts, card);
      if (!updated.ok) console.error("[triage] slack card update failed", id, updated.error);
    }
    // A reopened or resolved incident shows in the channel too, not only in
    // its thread.
    const reply = await postMessage(bot.botToken, thread.channel, slackMessage(kind, incident, baseUrl()), {
      threadTs: thread.ts,
      broadcast: kind === "incident_reopened" || kind === "resolved",
    });
    return reply.ok ? undefined : reply.error;
  });
}

async function deliver(kind: MessageKind, incident: Incident) {
  const key = keyOf(kind, incident);
  if (!key) return;
  const { slackWebhookUrl, events } = await readNotificationSettings();
  const bot = await readSlackBot();
  if ((!slackWebhookUrl && !botReady(bot)) || !events[eventOf[kind]]) return;
  if (!claim(key)) return;
  let error: string | undefined;
  if (botReady(bot)) {
    error = await viaBot(bot, kind, incident.id);
    if (error && slackWebhookUrl) {
      console.error("[triage] slack bot failed, sending through the webhook", kind, incident.id, error);
      const fallback = await send(slackWebhookUrl, slackMessage(kind, incident, baseUrl()));
      error = fallback && `${error}; webhook: ${fallback}`;
    }
  } else {
    error = await send(slackWebhookUrl!, slackMessage(kind, incident, baseUrl()));
  }
  if (error) console.error("[triage] slack notification failed", kind, incident.id, error);
  record({ at: new Date().toISOString(), kind, incidentId: incident.id, ok: !error, ...(error ? { error } : {}) });
}

// Brings the incident's Slack card up to where it stands, after a change no
// message is sent for (a decision, a mitigation applied). Nothing to do
// without the bot or a card. Never throws.
export async function refreshSlackCard(id: string): Promise<void> {
  try {
    const bot = await readSlackBot();
    if (!botReady(bot)) return;
    await onCard(id, async () => {
      const incident = await getIncident(id);
      if (!incident?.slack) return;
      const card = incidentCard(incident, baseUrl(), { interactive: interactive(bot) });
      const updated = await updateMessage(bot.botToken, incident.slack.channel, incident.slack.ts, card);
      if (!updated.ok) console.error("[triage] slack card update failed", id, updated.error);
    });
  } catch (err) {
    console.error("[triage] slack card update failed", id, err);
  }
}

// Tells Slack about an event on the incident, if the bot or a webhook is
// set up and the event is on. Call it after the incident is saved; not awaiting it is the
// point. Never throws, and an event already sent is not sent again, so it is
// safe to call wherever the state might be reached twice.
export function notify(kind: MessageKind, incident: Incident): void {
  void deliver(kind, incident).catch((err) => console.error("[triage] notification failed", kind, incident.id, err));
}

const testButton = {
  type: "actions",
  block_id: "triage_actions",
  elements: [{ type: "button", text: { type: "plain_text", text: "Try a button" }, action_id: "test_button", value: "test" }],
};

// The Settings page's test message: sent now, whatever the preferences, and
// logged like the rest. Through the bot when it is set up, with a button to
// try when clicks can come back; else through the webhook.
export async function sendTest(): Promise<Delivery> {
  const { slackWebhookUrl } = await readNotificationSettings();
  const bot = await readSlackBot();
  if (!slackWebhookUrl && !botReady(bot)) {
    return { at: new Date().toISOString(), kind: "test", ok: false, error: "No Slack bot or webhook is saved." };
  }
  const message = slackMessage("test", undefined, baseUrl());
  let error: string | undefined;
  if (botReady(bot)) {
    if (bot.appToken) message.attachments[0].blocks.splice(-1, 0, testButton);
    const posted = await postMessage(bot.botToken, bot.channel, message);
    error = posted.ok ? undefined : posted.error;
  } else {
    error = await send(slackWebhookUrl!, message);
  }
  if (error) console.error("[triage] slack notification failed", "test", error);
  const delivery: Delivery = { at: new Date().toISOString(), kind: "test", ok: !error, ...(error ? { error } : {}) };
  record(delivery);
  return delivery;
}

// The bot's names, for Settings: asked of Slack at most once a minute for
// the same token, channel and approvers. On globalThis, across dev hot
// reloads.
const NAMES_TTL_MS = 60_000;
const namesCache = globalThis as unknown as { triageSlackNames?: { key: string; at: number; names: Promise<SlackNames> } };

function slackNames(bot: SlackBot): Promise<SlackNames> | undefined {
  if (!bot.botToken) return undefined;
  const key = [bot.botToken, bot.channel ?? "", ...bot.approvers].join("|");
  const cached = namesCache.triageSlackNames;
  if (cached?.key === key && Date.now() - cached.at < NAMES_TTL_MS) return cached.names;
  const names = lookupNames(bot.botToken, bot.channel, bot.approvers);
  namesCache.triageSlackNames = { key, at: Date.now(), names };
  return names;
}

// What the browser sees: whether a webhook and the bot's tokens are saved
// and their last characters, the bot's channel and approvers, the events
// that are on, and the latest attempts.
export async function publicNotificationSettings(): Promise<PublicNotificationSettings> {
  const { slackWebhookUrl, events } = await readNotificationSettings();
  const bot = await readSlackBot();
  const hint = (secret?: string) => secret && `…${secret.slice(-4)}`;
  return {
    slack: slackWebhookUrl ? { configured: true, hint: hint(slackWebhookUrl) } : { configured: false },
    bot: {
      configured: !!(bot.botToken && bot.channel),
      botHint: hint(bot.botToken),
      appHint: hint(bot.appToken),
      channel: bot.channel,
      approvers: bot.approvers,
      socket: slackSocketStatus(),
      names: await slackNames(bot),
    },
    events,
    deliveries: recentDeliveries(20),
  };
}
