import type { BlockActionsPayload } from "./actions";
import type { SlackSocketState } from "./types";
import { errorMessage } from "../errors";
import { readSlackBot } from "../models/settings";

// The Slack bot's Socket Mode client: Slack pushes button clicks down a
// WebSocket that Triage opens, so they arrive without a public URL. With the
// app token (xapp-) Triage asks Slack for a socket URL, opens it, acks every
// envelope at once (Slack wants the ack within 3 s and retries otherwise),
// then hands block_actions to handleBlockActions. Slack cycles the socket
// every few hours, saying "disconnect" first; a drop it didn't announce is
// retried with backoff. The app token is a secret: it goes in one header and
// is never logged.

const OPEN_URL = "https://slack.com/api/apps.connections.open";
const OPEN_TIMEOUT_MS = 10_000;
// A socket that opens but never says hello is as good as dropped.
const HELLO_TIMEOUT_MS = 30_000;
const BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

// Errors that mean the token itself is wrong: retrying won't help, a new
// token in Settings will.
const tokenErrors: Record<string, string> = {
  invalid_auth: "Slack didn't accept the app token",
  not_authed: "Slack didn't accept the app token",
  token_revoked: "The app token was revoked",
  account_inactive: "The Slack app or its workspace is inactive",
  missing_scope: "The app token is missing the connections:write scope",
};

// The parts of a WebSocket the client uses, so tests can pass a fake.
export type SocketLike = {
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
};

export type SocketDeps = {
  readAppToken: () => Promise<string | undefined>;
  fetch: typeof fetch;
  openSocket: (url: string) => SocketLike;
  onBlockActions: (payload: BlockActionsPayload) => Promise<void>;
  // Runs fn after ms; returns a cancel.
  setTimer: (fn: () => void, ms: number) => () => void;
};

export type SlackSocket = {
  start(): void;
  restart(): void;
  stop(): void;
  status(): SlackSocketState;
};

type Envelope = { envelope_id?: string; type?: string; payload?: { type?: string } };

export function createSlackSocket(deps: SocketDeps): SlackSocket {
  let state: SlackSocketState = { state: "off" };
  let started = false;
  // Bumped by every start and stop: work begun for an older generation (a
  // fetch still in flight, a timer) finds it stale and drops out.
  let gen = 0;
  let socket: SocketLike | undefined;
  let cancelTimer: (() => void) | undefined;
  let attempt = 0;

  const clearTimer = () => {
    cancelTimer?.();
    cancelTimer = undefined;
  };

  // Closes the current socket without its close counting as a drop.
  const retire = () => {
    const ws = socket;
    socket = undefined;
    if (!ws) return;
    ws.onmessage = ws.onclose = ws.onerror = null;
    try {
      ws.close();
    } catch {
      // Already closed.
    }
  };

  const retry = (g: number, why: string) => {
    if (g !== gen) return;
    retire();
    clearTimer();
    const delay = Math.min(BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
    attempt++;
    console.error(`[triage] slack socket: ${why}; retrying in ${delay / 1000} s`);
    state = { state: "connecting", error: why };
    cancelTimer = deps.setTimer(() => void connect(g), delay);
  };

  const onMessage = (g: number, ws: SocketLike, data: unknown) => {
    if (g !== gen || ws !== socket) return;
    let msg: Envelope;
    try {
      msg = JSON.parse(String(data)) as Envelope;
    } catch {
      console.error("[triage] slack socket: a message that isn't JSON, ignored");
      return;
    }
    // Ack first, before any work: Slack shows the person an error and sends
    // the click again if the ack is late.
    if (msg.envelope_id) ws.send(JSON.stringify({ envelope_id: msg.envelope_id }));

    if (msg.type === "hello") {
      clearTimer();
      attempt = 0;
      state = { state: "connected" };
      console.log("[triage] slack socket connected");
    } else if (msg.type === "disconnect") {
      // Slack is about to cycle this socket: move to a fresh one now.
      retire();
      void connect(g);
    } else if (msg.type === "interactive" && msg.payload?.type === "block_actions") {
      const payload = msg.payload as BlockActionsPayload;
      Promise.resolve()
        .then(() => deps.onBlockActions(payload))
        .catch((err) => console.error("[triage] slack action failed", err));
    }
  };

  const connect = async (g: number) => {
    if (g !== gen) return;
    clearTimer();
    try {
      state = { state: "connecting", error: state.error };
      const token = await deps.readAppToken();
      if (g !== gen) return;
      if (!token) {
        state = { state: "off" };
        return;
      }

      const res = await deps.fetch(OPEN_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
        signal: AbortSignal.timeout(OPEN_TIMEOUT_MS),
      });
      const body = (await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))) as {
        ok?: boolean;
        url?: string;
        error?: string;
      };
      if (g !== gen) return;
      if (!body.ok || !body.url) {
        const code = body.error ?? `HTTP ${res.status}`;
        if (tokenErrors[code]) {
          state = { state: "failed", error: `${tokenErrors[code]} (${code})` };
          console.error(`[triage] slack socket: ${state.error}`);
          return;
        }
        return retry(g, `apps.connections.open failed (${code})`);
      }

      const ws = deps.openSocket(body.url);
      socket = ws;
      ws.onmessage = (ev) => onMessage(g, ws, ev.data);
      ws.onerror = () => {};
      ws.onclose = (ev) => {
        if (ws !== socket) return;
        retry(g, `Slack closed the socket${ev.code ? ` (${ev.code})` : ""}`);
      };
      cancelTimer = deps.setTimer(() => {
        if (ws === socket && state.state !== "connected") retry(g, "no hello from Slack");
      }, HELLO_TIMEOUT_MS);
    } catch (err) {
      retry(g, errorMessage(err));
    }
  };

  const stop = () => {
    gen++;
    started = false;
    clearTimer();
    retire();
    attempt = 0;
    state = { state: "off" };
  };

  const start = () => {
    if (started) return;
    started = true;
    gen++;
    void connect(gen);
  };

  return {
    start,
    stop,
    restart() {
      stop();
      start();
    },
    status: () => ({ ...state }),
  };
}

const defaultDeps = (): SocketDeps => ({
  readAppToken: async () => (await readSlackBot()).appToken,
  fetch: (...args) => fetch(...args),
  openSocket: (url) => new WebSocket(url) as unknown as SocketLike,
  // Loaded when a click arrives, not with this module: actions reaches into
  // the incident store, which notify (and so this module's importers) don't
  // need at load.
  onBlockActions: async (payload) => (await import("./actions")).handleBlockActions(payload),
  setTimer: (fn, ms) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
});

// On globalThis: one socket per server process, across dev hot reloads and
// however many bundles load this module. A client from an older shape of
// this module is stopped and replaced, keeping whether it was running.
const VERSION = 1;
const g = globalThis as unknown as { triageSlackSocket?: { version: number; client: SlackSocket; running: boolean } };
const current = (() => {
  const old = g.triageSlackSocket;
  if (old?.version === VERSION) return old;
  old?.client.stop();
  g.triageSlackSocket = { version: VERSION, client: createSlackSocket(defaultDeps()), running: false };
  if (old?.running) setTimeout(() => startSlackSocket(), 0);
  return g.triageSlackSocket;
})();

export function startSlackSocket(): void {
  current.running = true;
  current.client.start();
}

// Closes the socket and opens a new one with the saved app token, or stays
// off without one. Called when the Slack bot settings change.
export function restartSlackSocket(): void {
  current.running = true;
  current.client.restart();
}

export function slackSocketStatus(): SlackSocketState {
  return current.client.status();
}
