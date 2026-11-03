import { errorMessage } from "../errors";

// The few Slack Web API methods the Slack bot calls, over fetch with its bot
// token. Slack answers 200 with { ok: false, error } when it refuses, so
// each call returns that error as text for the delivery log, never throws.
// The token is sent to slack.com only and never logged.

const TIMEOUT_MS = 5000;

export type SlackReply = { ok: true; ts?: string; channel?: string } | { ok: false; error: string };

export type SlackFetch = typeof fetch;

export async function callSlack(
  token: string,
  method: string,
  body: Record<string, unknown>,
  fetchImpl: SlackFetch = fetch,
): Promise<SlackReply> {
  try {
    const res = await fetchImpl(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, error: `${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`.trim() };
    const reply = (await res.json()) as { ok: boolean; error?: string; ts?: string; channel?: string };
    if (!reply.ok) return { ok: false, error: `${method}: ${reply.error ?? "unknown error"}` };
    return { ok: true, ts: reply.ts, channel: reply.channel };
  } catch (err) {
    return { ok: false, error: `${method}: ${errorMessage(err)}` };
  }
}

type Message = { text: string; blocks: unknown[]; attachments?: unknown[] };

// A new message, or a reply in a thread when threadTs is given. broadcast
// also shows the reply in the channel.
export const postMessage = (
  token: string,
  channel: string,
  message: Message,
  opts: { threadTs?: string; broadcast?: boolean } = {},
  fetchImpl?: SlackFetch,
) =>
  callSlack(
    token,
    "chat.postMessage",
    {
      channel,
      ...message,
      unfurl_links: false,
      ...(opts.threadTs && { thread_ts: opts.threadTs, reply_broadcast: opts.broadcast ?? false }),
    },
    fetchImpl,
  );

// Replaces a message the bot posted, all of it: text, blocks and attachments.
export const updateMessage = (token: string, channel: string, ts: string, message: Message, fetchImpl?: SlackFetch) =>
  callSlack(token, "chat.update", { channel, ts, attachments: [], ...message }, fetchImpl);

// A message only one person sees, under the message they clicked.
export const postEphemeral = (
  token: string,
  channel: string,
  user: string,
  text: string,
  threadTs?: string,
  fetchImpl?: SlackFetch,
) => callSlack(token, "chat.postEphemeral", { channel, user, text, ...(threadTs && { thread_ts: threadTs }) }, fetchImpl);

// A read method, form-encoded as Slack's read methods expect: the reply's
// JSON, or why there is none.
async function readSlack<T>(
  token: string,
  method: string,
  params: Record<string, string>,
  fetchImpl: SlackFetch,
): Promise<{ ok: true; reply: T } | { ok: false; error: string }> {
  try {
    const res = await fetchImpl(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Bearer ${token}` },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const reply = (await res.json()) as T & { ok: boolean; error?: string };
    return reply.ok ? { ok: true, reply } : { ok: false, error: reply.error ?? "unknown error" };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

// What Settings shows instead of IDs: the bot's name and workspace, the
// channel's name and whether the bot is in it, each approver's name. A
// lookup that fails leaves its name out and says why, in words.
export type SlackNames = {
  bot?: string;
  team?: string;
  channel?: { name: string; isMember: boolean };
  approvers: Record<string, string>;
  problems: string[];
};

const scopeProblem = (scope: string, what: string) => `Add the ${scope} scope and reinstall to show ${what}.`;

export async function lookupNames(
  token: string,
  channel: string | undefined,
  users: string[],
  fetchImpl: SlackFetch = fetch,
): Promise<SlackNames> {
  const names: SlackNames = { approvers: {}, problems: [] };
  const [auth, info, ...people] = await Promise.all([
    readSlack<{ user?: string; team?: string }>(token, "auth.test", {}, fetchImpl),
    channel
      ? readSlack<{ channel: { name: string; is_member?: boolean } }>(token, "conversations.info", { channel }, fetchImpl)
      : undefined,
    ...users.map((user) =>
      readSlack<{ user: { name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } } }>(
        token,
        "users.info",
        { user },
        fetchImpl,
      ),
    ),
  ]);

  if (auth.ok) Object.assign(names, { bot: auth.reply.user, team: auth.reply.team });
  else names.problems.push(`Slack didn't accept the bot token (${auth.error}).`);

  if (info?.ok) names.channel = { name: info.reply.channel.name, isMember: info.reply.channel.is_member ?? false };
  else if (info && auth.ok) {
    if (info.error === "missing_scope") names.problems.push(scopeProblem("channels:read", "the channel's name"));
    else if (info.error === "channel_not_found") {
      names.problems.push("Slack can't find that channel. Check the ID, and invite the bot to a private one.");
    } else names.problems.push(`Couldn't read the channel (${info.error}).`);
  }

  people.forEach((person, i) => {
    if (person.ok) {
      const u = person.reply.user;
      names.approvers[users[i]] = u.profile?.display_name || u.profile?.real_name || u.real_name || u.name || users[i];
    }
  });
  const failed = people.flatMap((p) => (p.ok ? [] : [p.error]))[0];
  if (failed && auth.ok) {
    names.problems.push(failed === "missing_scope" ? scopeProblem("users:read", "approvers' names") : `Couldn't read an approver (${failed}).`);
  }
  return names;
}
