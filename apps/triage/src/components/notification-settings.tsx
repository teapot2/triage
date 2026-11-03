"use client";

import { CircleAlertIcon, CircleCheckIcon, ChevronRightIcon, LoaderCircleIcon, SendIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { FormField } from "@/components/form-fields";
import { formatAgo } from "@/components/incident/format";
import { DisclosureFooter, DisclosureRow, ListGroup, SettingsSectionHeader } from "@/components/settings-list";
import { SlackBotGuide } from "@/components/slack-bot-guide";
import { Timestamp } from "@/components/timestamp";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { StatusBadge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useNow } from "@/hooks/use-now";
import {
  type Delivery,
  eventLabels,
  type NotificationEvent,
  notificationEvents,
  type PublicNotificationSettings,
  slackAppTokenPattern,
  slackBotTokenPattern,
  slackChannelPattern,
  slackUserPattern,
  slackWebhookPattern,
} from "@/lib/notifications/types";
import { errorMessage } from "@/lib/errors";

const API = "/api/settings/notifications";

const rowClass = "flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between";

const kindLabels: Record<Delivery["kind"], string> = {
  incident_opened: "Incident opened",
  incident_reopened: "Incident reopened",
  mitigation_proposed: "Mitigation proposed",
  fix_ready: "Fix ready for review",
  pr_opened: "Draft PR opened",
  resolved: "Incident resolved",
  test: "Test",
};

// Deliveries listed before "Show more".
const DELIVERIES_SHOWN = 5;

type Bot = PublicNotificationSettings["bot"];

// The Notifications section of Settings: one Slack row (the bot, which
// posts a thread per incident with Approve and Deny buttons, and the
// incoming webhook, its fallback or the simple way to post), a test
// message, which events send one, and the latest delivery attempts with
// Slack's answer when one failed. Saved on the server, which sends the
// messages; the webhook URL and the bot's tokens are secrets, so they are
// write-only here: the server says whether one is saved and its last four
// characters, never the value. Every save returns the new state, which
// replaces ours, except a switch, which flips at once and goes back if the
// server says no.
export function NotificationSettings() {
  const id = useId();
  const [data, setData] = useState<PublicNotificationSettings>();
  const [loadError, setLoadError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [testing, setTesting] = useState(false);
  const [slackOpen, setSlackOpen] = useState(false);
  // The rest of the delivery log, which is history rather than a setting.
  const [showAll, setShowAll] = useState(false);
  const now = useNow(0);
  // Switches flipped and not yet answered: only the last answer may replace
  // the state, or it would undo a flip made since.
  const pending = useRef(0);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch(API, { signal: ctrl.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setData((await res.json()) as PublicNotificationSettings);
      })
      .catch((err) => {
        if (!ctrl.signal.aborted) setLoadError(errorMessage(err));
      });
    return () => ctrl.abort();
  }, [attempt]);

  // A socket still connecting (just after a save) is asked again every two
  // seconds until it settles. Only the bot is replaced, so a refresh never
  // undoes a switch still being saved, and a draft in its editor stays.
  const bot = data?.bot;
  useEffect(() => {
    if (bot?.socket.state !== "connecting") return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      fetch(API, { signal: ctrl.signal })
        .then(async (res) => {
          if (!res.ok) return;
          const fresh = (await res.json()) as PublicNotificationSettings;
          setData((d) => d && { ...d, bot: fresh.bot });
        })
        .catch(() => {
          // The state shows as it was until the next save.
        });
    }, 2_000);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [bot]);

  // The log only, so a refresh never undoes a switch still being saved.
  async function refreshDeliveries() {
    try {
      const res = await fetch(API);
      if (!res.ok) return;
      const fresh = (await res.json()) as PublicNotificationSettings;
      setData((d) => d && { ...d, deliveries: fresh.deliveries });
    } catch {
      // The list stays as it was.
    }
  }

  async function sendTest() {
    setTesting(true);
    try {
      const res = await fetch(`${API}/test`, { method: "POST" });
      const body = (await res.json()) as { error?: string };
      if (res.ok) toast.success("Test message sent");
      else toast.error(`Slack didn't take the test message: ${body.error ?? `HTTP ${res.status}`}`);
    } catch (err) {
      toast.error(`Couldn't send the test message: ${errorMessage(err)}`);
    } finally {
      setTesting(false);
      void refreshDeliveries();
    }
  }

  async function toggle(event: NotificationEvent, checked: boolean) {
    const set = (on: boolean) => setData((d) => d && { ...d, events: { ...d.events, [event]: on } });
    set(checked);
    pending.current += 1;
    try {
      const res = await fetch(API, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events: { [event]: checked } }),
      });
      const body = (await res.json()) as PublicNotificationSettings & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      if (pending.current === 1) setData(body);
    } catch (err) {
      set(!checked);
      toast.error(`Couldn't save: ${errorMessage(err)}`);
    } finally {
      pending.current -= 1;
    }
  }

  const webhook = data?.slack.configured ?? false;
  // Alerts go out through the bot, or the webhook without one.
  const sends = webhook || (bot?.configured ?? false);

  return (
    <section aria-labelledby="notifications" className="flex flex-col gap-3">
      <SettingsSectionHeader id="notifications" title="Notifications" />

      {loadError && (
        <Alert variant="destructive">
          <AlertTitle>Couldn&apos;t load the notification settings</AlertTitle>
          <AlertDescription className="break-words">{loadError}</AlertDescription>
          <AlertAction>
            <Button
              variant="outline"
              size="xs"
              onClick={() => {
                setLoadError(undefined);
                setAttempt((n) => n + 1);
              }}
            >
              Retry
            </Button>
          </AlertAction>
        </Alert>
      )}

      {!data && !loadError && (
        <div className="divide-y rounded-lg border" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex flex-col gap-2 px-4 py-3">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-48" />
            </div>
          ))}
        </div>
      )}

      {data && (
        <div className="divide-y overflow-hidden rounded-lg border">
          <SlackRow
            // Keyed by what's saved, so a save resets the draft; the socket's
            // state and the names change on their own and leave it.
            key={[data.bot.botHint, data.bot.appHint, data.bot.channel, data.bot.approvers.join(" ")].join("|")}
            data={data}
            onSaved={setData}
            open={slackOpen}
            onOpenChange={setSlackOpen}
          />

          <div className={rowClass}>
            <div className="flex flex-col gap-0.5">
              <span id={`${id}-test`} className="font-medium text-sm">
                Test message
              </span>
              <span className="max-w-xl text-muted-foreground text-sm">
                {bot?.configured
                  ? `Posts a card through the bot${data.bot.appHint ? ", with a button to try" : ""}.`
                  : webhook
                    ? "Posts a short message through the webhook."
                    : "Set up Slack first."}
              </span>
            </div>
            <Button variant="outline" size="sm" onClick={sendTest} disabled={!sends || testing}>
              {testing ? <LoaderCircleIcon className="animate-spin" /> : <SendIcon />}
              Send test
              <span className="sr-only"> message to Slack</span>
            </Button>
          </div>

          <ListGroup label="Alerts" note={sends ? undefined : "Connect Slack to turn these on"} />
          {notificationEvents.map((event) => (
            <div key={event} className={rowClass}>
              <label htmlFor={`${id}-${event}`} className="font-medium text-sm">
                {eventLabels[event].label}
              </label>
              <Switch
                id={`${id}-${event}`}
                disabled={!sends}
                // Off until Slack is connected, as nothing is sent; the
                // saved choice shows (and applies) once it is.
                checked={sends && data.events[event]}
                onCheckedChange={(on) => void toggle(event, on)}
              />
            </div>
          ))}

          {(sends || data.deliveries.length > 0) && (
            <>
              <ListGroup label="Recent deliveries" />
              {data.deliveries.length === 0 ? (
                <p className="px-4 py-3 text-muted-foreground text-sm">Nothing sent yet.</p>
              ) : (
                <ul className="divide-y">
                  {(showAll ? data.deliveries : data.deliveries.slice(0, DELIVERIES_SHOWN)).map((d) => (
                    <DeliveryRow key={`${d.at}|${d.kind}|${d.incidentId ?? ""}`} delivery={d} now={now} />
                  ))}
                  {!showAll && data.deliveries.length > DELIVERIES_SHOWN && (
                    <li>
                      <button
                        type="button"
                        onClick={() => setShowAll(true)}
                        className="w-full px-4 py-2.5 text-left text-muted-foreground text-sm outline-none transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:bg-muted/50 focus-visible:text-foreground"
                      >
                        Show {data.deliveries.length - DELIVERIES_SHOWN} more
                      </button>
                    </li>
                  )}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

type BotField = "botToken" | "appToken" | "channel" | "approvers";
const botFields: BotField[] = ["botToken", "appToken", "channel", "approvers"];

// Member IDs as typed or pasted: separated by commas or spaces.
function parseIds(text: string) {
  return text.split(/[\s,]+/).filter(Boolean);
}

// "#alerts" for a channel Slack named, else its ID.
const channelName = (bot: Bot) => (bot.names?.channel ? `#${bot.names.channel.name}` : bot.channel);
const approverName = (bot: Bot, id: string) => bot.names?.approvers[id] ?? id;

// Slack, in one row. Closed, it reads as a sentence: where it posts, as
// whom, who can approve, and a badge for whether the buttons work. Open,
// it edits the bot in two parts, what posting needs (bot token, channel)
// and what the buttons need (app token, approvers), with the webhook folded
// under them: the bot's fallback, or the simple way to post without one.
// The tokens are write-only, so their fields start empty and blank keeps
// the saved one. The parent keys the row by what's saved, so a save resets
// the draft, and owns `open`. Bad values are caught here first, then by the
// server, and either shows in the field's place.
function SlackRow({
  data,
  onSaved,
  open,
  onOpenChange,
}: {
  data: PublicNotificationSettings;
  onSaved: (data: PublicNotificationSettings) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const bot = data.bot;
  const id = useId();
  const [botToken, setBotToken] = useState("");
  const [appToken, setAppToken] = useState("");
  const [channel, setChannel] = useState(bot.channel ?? "");
  const [approvers, setApprovers] = useState(bot.approvers);
  const [errors, setErrors] = useState<Partial<Record<BotField, string>>>({});
  // A failure that isn't about one field (the network, the server).
  const [saveError, setSaveError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  // The webhook folds away once the bot posts.
  const [webhookOpen, setWebhookOpen] = useState(!bot.configured);

  const approversChanged = approvers.join(" ") !== bot.approvers.join(" ");
  const channelChanged = channel.trim() !== (bot.channel ?? "");
  const dirty = Boolean(botToken.trim() || appToken.trim()) || channelChanged || approversChanged;
  const saved = Boolean(bot.botHint || bot.appHint || bot.channel || bot.approvers.length);
  const busy = saving || removing;

  // Posting needs a bot token and a channel; the app token and approvers
  // are for the buttons.
  function check() {
    const found: Partial<Record<BotField, string>> = {};
    const b = botToken.trim();
    const a = appToken.trim();
    if (b ? !slackBotTokenPattern.test(b) : !bot.botHint) found.botToken = "Paste the Bot User OAuth Token (xoxb-…)";
    if (a && !slackAppTokenPattern.test(a)) {
      found.appToken = "Paste an app-level token (xapp-…) with the connections:write scope";
    }
    if (!slackChannelPattern.test(channel.trim())) {
      found.channel = "Paste the channel ID (C0…), found at the bottom of the channel's details";
    }
    return found;
  }

  function showErrors(found: Partial<Record<BotField, string>>) {
    setErrors(found);
    const first = botFields.find((f) => found[f]);
    if (first) document.getElementById(`${id}-${first}`)?.focus();
  }

  // Sends the bot's part of the settings; an error comes back, with the
  // field it's about when the server named one.
  async function put(slackBot: Partial<Record<BotField, string | string[]>>) {
    try {
      const res = await fetch(API, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slackBot }),
      });
      const body = (await res.json()) as PublicNotificationSettings & { error?: string; field?: string };
      if (!res.ok) return { error: body.error ?? `HTTP ${res.status}`, field: body.field };
      onSaved(body);
    } catch (err) {
      return { error: errorMessage(err), field: undefined };
    }
  }

  function failed({ error, field }: { error: string; field?: string }) {
    if (field && (botFields as string[]).includes(field)) showErrors({ [field]: error });
    else setSaveError(error);
  }

  // From the form (Enter in a field) or the footer's Save, which sits
  // outside it under the webhook.
  async function save(e: { preventDefault(): void }) {
    e.preventDefault();
    setSaveError(undefined);
    const found = check();
    if (Object.keys(found).length > 0) return showErrors(found);
    setErrors({});
    setSaving(true);
    const err = await put({
      ...(botToken.trim() && { botToken: botToken.trim() }),
      ...(appToken.trim() && { appToken: appToken.trim() }),
      ...(channelChanged && { channel: channel.trim() }),
      ...(approversChanged && { approvers }),
    });
    setSaving(false);
    if (err) return failed(err);
    toast.success(bot.configured ? "Slack bot saved" : "Slack bot set up");
    setBotToken("");
    setAppToken("");
    onOpenChange(false);
  }

  async function remove() {
    setSaveError(undefined);
    setRemoving(true);
    const err = await put({ botToken: "", appToken: "", channel: "", approvers: [] });
    setRemoving(false);
    if (err) return failed(err);
    toast.success("Slack bot disconnected");
    onOpenChange(false);
  }

  function cancel() {
    setBotToken("");
    setAppToken("");
    setChannel(bot.channel ?? "");
    setApprovers(bot.approvers);
    setErrors({});
    setSaveError(undefined);
    onOpenChange(false);
  }

  // A field's props: its id, the error's id to describe it, and clearing
  // its error as it's edited.
  function inputProps(name: BotField, value: string, set: (v: string) => void) {
    return {
      id: `${id}-${name}`,
      value,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
        set(e.target.value);
        setErrors((errs) => ({ ...errs, [name]: undefined }));
      },
      autoComplete: "off",
      spellCheck: false,
      className: "font-mono",
      "aria-invalid": Boolean(errors[name]),
      "aria-describedby": `${id}-${name}-message`,
    };
  }

  // Whether the bot is in the channel, once Slack has named it; only for
  // the saved channel.
  const named = !channelChanged && bot.names?.channel;
  const channelHint = named ? (
    named.isMember ? (
      <span className="inline-flex items-center gap-1" title="The bot is a member">
        <CircleCheckIcon className="size-3.5 text-success" aria-label="The bot is a member" />#{named.name}
      </span>
    ) : (
      <span className="inline-flex items-center gap-1">
        <CircleAlertIcon className="size-3.5 text-warning" aria-hidden />
        /invite @{bot.names?.bot ?? "your bot"} to #{named.name} first
      </span>
    )
  ) : undefined;

  return (
    <DisclosureRow
      title="Slack"
      subtitle={slackSentence(data)}
      status={<SlackStatus data={data} />}
      unsaved={dirty}
      open={open}
      onOpenChange={onOpenChange}
    >
      {bot.names && bot.names.problems.length > 0 && (
        <ul className="flex flex-col gap-1 text-warning text-xs">
          {bot.names.problems.map((p) => (
            <li key={p} className="flex items-start gap-1.5">
              <CircleAlertIcon className="mt-px size-3.5 shrink-0" aria-hidden />
              {p}
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={save} noValidate className="flex flex-col gap-2">
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 flex w-full items-center justify-between font-medium text-muted-foreground text-xs">
            Posting
            <SlackBotGuide />
          </legend>
          <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
            <FormField label="Bot token" htmlFor={`${id}-botToken`} error={errors.botToken}>
              <Input
                {...inputProps("botToken", botToken, setBotToken)}
                type="password"
                autoComplete="new-password"
                placeholder={`xoxb-${bot.botHint ?? "…"}`}
              />
            </FormField>
            <FormField label="Channel ID" htmlFor={`${id}-channel`} hint={channelHint} error={errors.channel}>
              <Input {...inputProps("channel", channel, setChannel)} placeholder="C0123456789" />
            </FormField>
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 font-medium text-muted-foreground text-xs">Buttons</legend>
          <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
            <FormField label="App token" htmlFor={`${id}-appToken`} error={errors.appToken}>
              <Input
                {...inputProps("appToken", appToken, setAppToken)}
                type="password"
                autoComplete="new-password"
                placeholder={`xapp-${bot.appHint ?? "…"}`}
              />
            </FormField>
            <FormField label="Approvers" htmlFor={`${id}-approvers`} error={errors.approvers}>
              <ApproverInput
                id={`${id}-approvers`}
                ids={approvers}
                nameOf={(u) => approverName(bot, u)}
                invalid={Boolean(errors.approvers)}
                onChange={(next) => {
                  setApprovers(next);
                  setErrors((errs) => ({ ...errs, approvers: undefined }));
                }}
                onError={(error) => setErrors((errs) => ({ ...errs, approvers: error }))}
              />
            </FormField>
          </div>
        </fieldset>

        {saveError && (
          <Alert key={saveError} variant="destructive" dismissible dismissLabel="Dismiss error" onDismiss={() => setSaveError(undefined)}>
            <AlertTitle>Couldn&apos;t save</AlertTitle>
            <AlertDescription className="break-words">{saveError}</AlertDescription>
          </Alert>
        )}
      </form>

      <WebhookSection
        slack={data.slack}
        fallback={bot.configured}
        open={webhookOpen}
        onOpenChange={setWebhookOpen}
        onSaved={onSaved}
      />

      <DisclosureFooter>
        <div>
          {saved && (
            <Button type="button" variant="ghost" size="sm" className="text-destructive" onClick={remove} disabled={busy}>
              {removing && <LoaderCircleIcon className="animate-spin" />}
              Disconnect bot
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={cancel} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={(e) => void save(e)} disabled={!dirty || busy}>
            {saving && <LoaderCircleIcon className="animate-spin" />}
            Save
            <span className="sr-only"> Slack bot</span>
          </Button>
        </div>
      </DisclosureFooter>
    </DisclosureRow>
  );
}

// The closed row's line: where it posts, and as whom.
function slackSentence({ bot, slack }: PublicNotificationSettings): string {
  if (bot.configured) return `Posts to ${channelName(bot)}${bot.names?.bot ? ` as ${bot.names.bot}` : ""}`;
  if (slack.configured) return "Posts through a webhook";
  return "One thread per incident, with Approve and Deny";
}

// One badge for how Slack stands: the bot with or without its buttons, the
// webhook alone, or what's missing.
function SlackStatus({ data: { bot, slack } }: { data: PublicNotificationSettings }) {
  if (!bot.configured) {
    if (bot.botHint || bot.channel) return <StatusBadge tone="warning">{bot.botHint ? "Needs channel" : "Needs bot token"}</StatusBadge>;
    if (slack.configured) return <StatusBadge tone="muted">Webhook</StatusBadge>;
    return <span className={buttonVariants({ variant: "outline", size: "xs" })}>Set up</span>;
  }
  switch (bot.socket.state) {
    case "connected":
      return bot.approvers.length > 0 ? (
        <StatusBadge tone="success">Connected</StatusBadge>
      ) : (
        <StatusBadge tone="muted">No approvers</StatusBadge>
      );
    case "connecting":
      return (
        <StatusBadge tone="muted" loading>
          Connecting…
        </StatusBadge>
      );
    case "off":
      return <StatusBadge tone="muted">No buttons</StatusBadge>;
    case "failed":
      return (
        <StatusBadge tone="destructive" className="max-w-64" title={bot.socket.error}>
          <span className="truncate">Buttons failed{bot.socket.error && `: ${bot.socket.error}`}</span>
        </StatusBadge>
      );
  }
}

// Approvers as chips: a pasted or typed member ID turns into a chip on
// Enter, a comma or a space, and on leaving the field; Backspace in the
// empty field takes the last one off. An ID that isn't one stays in the
// field with the error under it.
function ApproverInput({
  id,
  ids,
  nameOf,
  invalid,
  onChange,
  onError,
}: {
  id: string;
  ids: string[];
  nameOf: (id: string) => string;
  invalid: boolean;
  onChange: (ids: string[]) => void;
  onError: (error: string) => void;
}) {
  const [text, setText] = useState("");

  function add(raw: string) {
    const typed = parseIds(raw);
    const bad = typed.find((u) => !slackUserPattern.test(u));
    if (bad) {
      setText(raw.trim());
      onError(`Approvers are member IDs (U0…), and "${bad}" isn't one`);
      return;
    }
    setText("");
    if (typed.length > 0) onChange([...new Set([...ids, ...typed])]);
  }

  return (
    <div
      className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border border-input px-2 py-1 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 aria-invalid:border-destructive"
      aria-invalid={invalid || undefined}
    >
      {ids.map((u) => (
        <span key={u} className="inline-flex items-center gap-1 rounded-sm border bg-muted/50 py-0.5 pr-0.5 pl-2 text-xs" title={u}>
          {nameOf(u) === u ? <span className="font-mono">{u}</span> : `@${nameOf(u)}`}
          <button
            type="button"
            onClick={() => onChange(ids.filter((x) => x !== u))}
            className="rounded-sm p-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`Remove ${nameOf(u)}`}
          >
            <XIcon className="size-3" aria-hidden />
          </button>
        </span>
      ))}
      <input
        id={id}
        value={text}
        onChange={(e) => {
          const v = e.target.value;
          // A separator typed or pasted ends an ID.
          if (/[\s,]/.test(v)) add(v);
          else setText(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add(text);
          } else if (e.key === "Backspace" && !text && ids.length > 0) {
            onChange(ids.slice(0, -1));
          }
        }}
        onBlur={() => text && add(text)}
        placeholder={ids.length === 0 ? "U0123456789" : "Add another"}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={invalid || undefined}
        aria-describedby={`${id}-message`}
        className="h-7 min-w-24 flex-1 bg-transparent font-mono text-sm outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}

// The incoming webhook, folded: the bot's fallback when the bot posts, the
// way to post without one when it doesn't. Its URL saves and removes on
// its own, apart from the bot's Save.
function WebhookSection({
  slack,
  fallback,
  open,
  onOpenChange,
  onSaved,
}: {
  slack: PublicNotificationSettings["slack"];
  fallback: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (data: PublicNotificationSettings) => void;
}) {
  const id = useId();
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string>();
  const [replacing, setReplacing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const showForm = !slack.configured || replacing;

  async function put(slackWebhookUrl: string) {
    const res = await fetch(API, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slackWebhookUrl }),
    });
    const body = (await res.json()) as PublicNotificationSettings & { error?: string };
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    onSaved(body);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const value = url.trim();
    if (!slackWebhookPattern.test(value)) {
      setError("That isn't a Slack incoming webhook URL. It starts with https://hooks.slack.com/services/.");
      input.current?.focus();
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      await put(value);
      toast.success(slack.configured ? "Webhook replaced" : "Webhook saved");
      setUrl("");
      setReplacing(false);
    } catch (err) {
      setError(errorMessage(err));
      input.current?.focus();
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    setRemoving(true);
    try {
      await put("");
      setUrl("");
      setError(undefined);
      setReplacing(false);
      toast.success("Webhook removed");
    } catch (err) {
      toast.error(`Couldn't remove the webhook: ${errorMessage(err)}`);
    } finally {
      setRemoving(false);
    }
  }

  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className="group/webhook rounded-lg border">
      <CollapsibleTrigger className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset">
        <ChevronRightIcon
          className="size-4 shrink-0 text-muted-foreground transition-[rotate] duration-200 group-data-[state=open]/webhook:rotate-90 motion-reduce:transition-none"
          aria-hidden
        />
        <span className="font-medium text-sm">{fallback ? "Webhook fallback" : "Webhook"}</span>
        <span className="min-w-0 truncate text-muted-foreground text-xs">
          {slack.configured ? <span className="font-mono">{slack.hint}</span> : "Not set"}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="px-3 pt-1 pb-3">
          {showForm ? (
            <form onSubmit={save} noValidate className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-url`} className="text-muted-foreground text-xs">
                {slack.configured
                  ? "Paste a new incoming webhook URL to replace the saved one."
                  : "An incoming webhook URL for the channel. It stays on the server and is never shown again."}
              </label>
              <div className="flex gap-2">
                <Input
                  ref={input}
                  id={`${id}-url`}
                  type="password"
                  value={url}
                  onChange={(e) => {
                    setUrl(e.target.value);
                    setError(undefined);
                  }}
                  placeholder="https://hooks.slack.com/services/…"
                  autoComplete="new-password"
                  spellCheck={false}
                  className="font-mono"
                  aria-invalid={Boolean(error)}
                  aria-describedby={error ? `${id}-error` : undefined}
                />
                {replacing && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setReplacing(false)} disabled={saving}>
                    Cancel
                  </Button>
                )}
                <Button type="submit" variant="outline" size="sm" disabled={saving || !url.trim()}>
                  {saving && <LoaderCircleIcon className="animate-spin" />}
                  Save
                  <span className="sr-only"> webhook</span>
                </Button>
              </div>
              {error && (
                <p id={`${id}-error`} role="alert" className="break-words text-destructive text-xs">
                  {error}
                </p>
              )}
            </form>
          ) : (
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setReplacing(true)} disabled={removing}>
                Replace
                <span className="sr-only"> webhook</span>
              </Button>
              <Button variant="ghost" size="sm" onClick={remove} disabled={removing}>
                {removing && <LoaderCircleIcon className="animate-spin" />}
                Remove
                <span className="sr-only"> webhook</span>
              </Button>
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// One attempt: what was sent, for which incident, when, and whether Slack
// took it. A failure shows Slack's answer, to troubleshoot from.
function DeliveryRow({ delivery: d, now }: { delivery: Delivery; now: number }) {
  return (
    <li className="flex flex-col gap-1 px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium text-sm">{kindLabels[d.kind]}</span>
        {d.incidentId && (
          <Link
            href={`/incidents/${d.incidentId}`}
            className="min-w-0 truncate font-mono text-muted-foreground text-xs underline-offset-4 hover:underline"
          >
            {d.incidentId}
          </Link>
        )}
        <span className="ml-auto flex items-center gap-3 text-muted-foreground text-xs">
          <Timestamp date={d.at}>{formatAgo(d.at, now)}</Timestamp>
          {/* Sent is the usual case, so only a failure gets a badge. */}
          {!d.ok && <StatusBadge tone="destructive">Failed</StatusBadge>}
        </span>
      </div>
      {!d.ok && d.error && <p className="break-words font-mono text-destructive text-xs">{d.error}</p>}
    </li>
  );
}
