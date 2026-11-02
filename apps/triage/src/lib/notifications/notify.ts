import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Incident } from "../investigation/schema";
import { readNotificationSettings } from "../models/settings";
import { slackMessage } from "./slack";
import { type Delivery, eventOf, type MessageKind, messageKinds, type PublicNotificationSettings } from "./types";
import { errorMessage } from "../errors";

// Sends a Slack message when something happens to an incident, once per
// event, and keeps a log of the attempts for Settings. A failed send is
// logged and goes no further: nothing that called notify() waits for it or
// sees an error from it. The webhook URL is a secret: it is read here, posted
// to, and never logged or returned.

const file = path.join(process.cwd(), ".data", "notifications.json");

const MAX_DELIVERIES = 50;
// Enough keys to cover every event still likely to be notified twice.
const MAX_SENT = 500;
const RETRY_AFTER_MS = 1000;
const TIMEOUT_MS = 5000;

const logSchema = z.object({
  // Newest first.
  deliveries: z
    .array(
      z.object({
        at: z.string(),
        kind: z.enum([...messageKinds, "test"]),
        incidentId: z.string().optional(),
        ok: z.boolean(),
        error: z.string().optional(),
      }),
    )
    .default([]),
  // Keys of the events already sent (or tried), oldest first.
  sent: z.array(z.string()).default([]),
});
type Log = z.infer<typeof logSchema>;

// A log that can't be read starts over: losing old attempts beats every
// later message failing on it.
async function readLog(): Promise<Log> {
  try {
    return logSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.error("[triage] notification log unreadable, starting over", err);
    return { deliveries: [], sent: [] };
  }
}

async function writeLog(log: Log) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(log, null, 2));
  await rename(tmp, file);
}

// Changes to the log, chained so a read and its write never interleave with
// another's: two events at once both land, and only one can claim a key. On
// globalThis: one chain across dev hot reloads.
const g = globalThis as unknown as { triageNotificationWrites?: Promise<unknown> };

function changeLog<T>(fn: (log: Log) => T): Promise<T> {
  const run = (g.triageNotificationWrites ?? Promise.resolve()).then(async () => {
    const log = await readLog();
    const result = fn(log);
    await writeLog(log);
    return result;
  });
  g.triageNotificationWrites = run.catch(() => {});
  return run;
}

// Claims an event's key before anything is sent, so a second call for the
// same event finds it taken. False when it was already claimed.
const claim = (key: string) =>
  changeLog((log) => {
    if (log.sent.includes(key)) return false;
    log.sent = [...log.sent, key].slice(-MAX_SENT);
    return true;
  });

const record = (delivery: Delivery) =>
  changeLog((log) => {
    log.deliveries = [delivery, ...log.deliveries].slice(0, MAX_DELIVERIES);
  });

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
async function send(url: string, message: { text: string; blocks: unknown[] }): Promise<string | undefined> {
  const body = JSON.stringify(message);
  let attempt = await post(url, body);
  if (attempt.error && attempt.retry) {
    await new Promise((resolve) => setTimeout(resolve, RETRY_AFTER_MS));
    attempt = await post(url, body);
  }
  return attempt.error;
}

async function deliver(kind: MessageKind, incident: Incident) {
  const key = keyOf(kind, incident);
  if (!key) return;
  const { slackWebhookUrl, events } = await readNotificationSettings();
  if (!slackWebhookUrl || !events[eventOf[kind]]) return;
  if (!(await claim(key))) return;
  const error = await send(slackWebhookUrl, slackMessage(kind, incident, baseUrl()));
  if (error) console.error("[triage] slack notification failed", kind, incident.id, error);
  await record({ at: new Date().toISOString(), kind, incidentId: incident.id, ok: !error, ...(error ? { error } : {}) });
}

// Tells Slack about an event on the incident, if a webhook is saved and the
// event is on. Call it after the incident is saved; not awaiting it is the
// point. Never throws, and an event already sent is not sent again, so it is
// safe to call wherever the state might be reached twice.
export function notify(kind: MessageKind, incident: Incident): void {
  void deliver(kind, incident).catch((err) => console.error("[triage] notification failed", kind, incident.id, err));
}

// The Settings page's test message: sent now, whatever the preferences, and
// logged like the rest.
export async function sendTest(): Promise<Delivery> {
  const { slackWebhookUrl } = await readNotificationSettings();
  if (!slackWebhookUrl) return { at: new Date().toISOString(), kind: "test", ok: false, error: "No Slack webhook is saved." };
  const error = await send(slackWebhookUrl, slackMessage("test", undefined, baseUrl()));
  if (error) console.error("[triage] slack notification failed", "test", error);
  const delivery: Delivery = { at: new Date().toISOString(), kind: "test", ok: !error, ...(error ? { error } : {}) };
  await record(delivery);
  return delivery;
}

// What the browser sees: whether a webhook is saved and its last characters,
// the events that are on, and the latest attempts.
export async function publicNotificationSettings(): Promise<PublicNotificationSettings> {
  const { slackWebhookUrl, events } = await readNotificationSettings();
  const { deliveries } = await readLog();
  return {
    slack: slackWebhookUrl ? { configured: true, hint: `…${slackWebhookUrl.slice(-4)}` } : { configured: false },
    events,
    deliveries: deliveries.slice(0, 20),
  };
}
