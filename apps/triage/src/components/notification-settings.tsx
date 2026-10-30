"use client";

import { LoaderCircleIcon, SendIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { formatAgo } from "@/components/incident/format";
import { ListGroup, SettingsSectionHeader } from "@/components/settings-list";
import { Timestamp } from "@/components/timestamp";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  slackWebhookPattern,
} from "@/lib/notifications/types";

const API = "/api/settings/notifications";

const rowClass = "flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between";

const kindLabels: Record<Delivery["kind"], string> = {
  incident_opened: "Incident opened",
  incident_reopened: "Incident reopened",
  fix_ready: "Fix ready for review",
  pr_opened: "Draft PR opened",
  resolved: "Incident resolved",
  test: "Test",
};

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

// The Notifications section of Settings: one Slack incoming webhook, a test
// message, which of three events send one, and the latest delivery attempts
// with Slack's answer when one failed. Saved on the server, which sends the
// messages; the webhook URL is a secret, so it is write-only here: the server
// says whether one is saved and its last four characters, never the URL.
// Every save returns the new state, which replaces ours, except a switch,
// which flips at once and goes back if the server says no.
export function NotificationSettings() {
  const id = useId();
  const [data, setData] = useState<PublicNotificationSettings>();
  const [loadError, setLoadError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  // The pasted URL, and why it was turned down.
  const [url, setUrl] = useState("");
  const [urlError, setUrlError] = useState<string>();
  const [replacing, setReplacing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [testing, setTesting] = useState(false);
  const now = useNow(0);
  const input = useRef<HTMLInputElement>(null);
  const replaceButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
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
        if (!ctrl.signal.aborted) setLoadError(message(err));
      });
    return () => ctrl.abort();
  }, [attempt]);

  // Focus follows the replace form: into its field when it opens, back to
  // the button when it closes.
  useEffect(() => {
    if (replacing) input.current?.focus();
    else if (restoreFocus.current) replaceButton.current?.focus();
    restoreFocus.current = false;
  }, [replacing]);

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

  async function saveWebhook(e: React.FormEvent) {
    e.preventDefault();
    const value = url.trim();
    if (!slackWebhookPattern.test(value)) {
      setUrlError("That isn't a Slack incoming webhook URL. It starts with https://hooks.slack.com/services/.");
      input.current?.focus();
      return;
    }
    setSaving(true);
    setUrlError(undefined);
    try {
      const res = await fetch(API, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slackWebhookUrl: value }),
      });
      const body = (await res.json()) as PublicNotificationSettings & { error?: string };
      if (!res.ok) {
        setUrlError(body.error ?? `HTTP ${res.status}`);
        input.current?.focus();
        return;
      }
      toast.success(data?.slack.configured ? "Webhook replaced" : "Slack connected");
      setData(body);
      setUrl("");
      restoreFocus.current = true;
      setReplacing(false);
    } catch (err) {
      setUrlError(message(err));
      input.current?.focus();
    } finally {
      setSaving(false);
    }
  }

  async function removeWebhook() {
    setRemoving(true);
    try {
      const res = await fetch(API, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slackWebhookUrl: "" }),
      });
      const body = (await res.json()) as PublicNotificationSettings & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setData(body);
      setUrl("");
      setUrlError(undefined);
      setReplacing(false);
      toast.success("Webhook removed");
    } catch (err) {
      toast.error(`Couldn't remove the webhook: ${message(err)}`);
    } finally {
      setRemoving(false);
    }
  }

  function cancelReplace() {
    setUrl("");
    setUrlError(undefined);
    restoreFocus.current = true;
    setReplacing(false);
  }

  async function sendTest() {
    setTesting(true);
    try {
      const res = await fetch(`${API}/test`, { method: "POST" });
      const body = (await res.json()) as { error?: string };
      if (res.ok) toast.success("Test message sent");
      else toast.error(`Slack didn't take the test message: ${body.error ?? `HTTP ${res.status}`}`);
    } catch (err) {
      toast.error(`Couldn't send the test message: ${message(err)}`);
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
      toast.error(`Couldn't save: ${message(err)}`);
    } finally {
      pending.current -= 1;
    }
  }

  const configured = data?.slack.configured ?? false;
  const showForm = !configured || replacing;
  const busy = saving || removing;
  const urlLabel = `${id}-url`;
  const urlHelp = `${id}-url-help`;
  const urlErrorId = `${id}-url-error`;

  return (
    <section aria-labelledby="notifications" className="flex flex-col gap-3">
      <SettingsSectionHeader
        id="notifications"
        title="Notifications"
        description="Slack alerts when Triage needs someone. Saved on the server."
      />

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
          <div className={rowClass}>
            <div className="flex flex-col gap-0.5">
              {showForm ? (
                <label htmlFor={urlLabel} className="font-medium text-sm">
                  Slack webhook
                </label>
              ) : (
                <span id={urlLabel} className="font-medium text-sm">
                  Slack webhook
                </span>
              )}
              {showForm ? (
                <span id={urlHelp} className="max-w-xl text-muted-foreground text-sm">
                  {configured
                    ? "Paste a new incoming webhook URL to replace the saved one."
                    : "An incoming webhook URL for the channel to post in. It stays on the server and is never shown again."}
                </span>
              ) : (
                <span className="text-muted-foreground text-sm">
                  Connected{data.slack.hint && " · ends in "}
                  {data.slack.hint && <span className="font-mono">{data.slack.hint}</span>}
                </span>
              )}
            </div>
            {showForm ? (
              <form onSubmit={saveWebhook} noValidate className="flex flex-col gap-1.5 sm:w-96">
                <div className="flex gap-2">
                  <Input
                    ref={input}
                    id={urlLabel}
                    type="password"
                    value={url}
                    onChange={(e) => {
                      setUrl(e.target.value);
                      setUrlError(undefined);
                    }}
                    placeholder="https://hooks.slack.com/services/…"
                    autoComplete="new-password"
                    spellCheck={false}
                    className="font-mono"
                    aria-invalid={Boolean(urlError)}
                    aria-describedby={urlError ? `${urlHelp} ${urlErrorId}` : urlHelp}
                  />
                  {replacing && (
                    <Button type="button" variant="ghost" onClick={cancelReplace} disabled={saving}>
                      Cancel
                    </Button>
                  )}
                  <Button type="submit" disabled={saving || !url.trim()}>
                    {saving && <LoaderCircleIcon className="animate-spin" />}
                    Save
                  </Button>
                </div>
                {urlError && (
                  <p id={urlErrorId} role="alert" className="break-words text-destructive text-xs">
                    {urlError}
                  </p>
                )}
              </form>
            ) : (
              <div className="flex items-center gap-2">
                <Button ref={replaceButton} variant="outline" size="sm" onClick={() => setReplacing(true)} disabled={busy}>
                  Replace
                  <span className="sr-only"> Slack webhook</span>
                </Button>
                <Button variant="ghost" size="sm" onClick={removeWebhook} disabled={busy}>
                  {removing && <LoaderCircleIcon className="animate-spin" />}
                  Remove
                  <span className="sr-only"> Slack webhook</span>
                </Button>
              </div>
            )}
          </div>

          <div className={rowClass}>
            <div className="flex flex-col gap-0.5">
              <span id={`${id}-test`} className="font-medium text-sm">
                Test message
              </span>
              <span className="max-w-xl text-muted-foreground text-sm">
                {configured ? "Posts a short message to the channel, to check the webhook works." : "Save a webhook first."}
              </span>
            </div>
            <Button variant="outline" size="sm" onClick={sendTest} disabled={!configured || testing || busy}>
              {testing ? <LoaderCircleIcon className="animate-spin" /> : <SendIcon />}
              Send test
              <span className="sr-only"> message to Slack</span>
            </Button>
          </div>

          <ListGroup label="Alerts" note={configured ? undefined : "Connect Slack to turn these on"} />
          {notificationEvents.map((event) => (
            <div key={event} className={rowClass}>
              <div className="flex flex-col gap-0.5">
                <label htmlFor={`${id}-${event}`} className="font-medium text-sm">
                  {eventLabels[event].label}
                </label>
                <span id={`${id}-${event}-description`} className="max-w-xl text-muted-foreground text-sm">
                  {eventLabels[event].description}
                </span>
              </div>
              <Switch
                id={`${id}-${event}`}
                aria-describedby={`${id}-${event}-description`}
                disabled={!configured}
                checked={data.events[event]}
                onCheckedChange={(on) => void toggle(event, on)}
              />
            </div>
          ))}

          {(configured || data.deliveries.length > 0) && (
            <>
              <ListGroup label="Recent deliveries" note="Latest 20 attempts, newest first" />
              {data.deliveries.length === 0 ? (
                <p className="px-4 py-3 text-muted-foreground text-sm">Nothing sent yet.</p>
              ) : (
                <ul className="divide-y">
                  {data.deliveries.map((d) => (
                    <DeliveryRow key={`${d.at}|${d.kind}|${d.incidentId ?? ""}`} delivery={d} now={now} />
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </section>
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
          {d.ok ? <StatusBadge tone="success">Sent</StatusBadge> : <StatusBadge tone="destructive">Failed</StatusBadge>}
        </span>
      </div>
      {!d.ok && d.error && <p className="break-words font-mono text-destructive text-xs">{d.error}</p>}
    </li>
  );
}
