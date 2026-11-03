import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BlockActionsPayload } from "./actions";
import { createSlackSocket, type SocketDeps, type SocketLike } from "./socket";

// A WebSocket that records what was sent and lets a test play Slack.
class FakeSocket implements SocketLike {
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  sent: string[] = [];
  closed = false;
  constructor(
    readonly url: string,
    private log: string[],
  ) {}
  send(data: string) {
    this.sent.push(data);
    this.log.push(`send ${data}`);
  }
  close() {
    this.closed = true;
  }
  receive(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop(code = 1006) {
    this.closed = true;
    this.onclose?.({ code });
  }
}

// Lets the client's awaits (settings read, fetch, json) run.
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

type Reply = { ok: boolean; url?: string; error?: string };

function setup(opts: { token?: string; replies?: Reply[]; handler?: SocketDeps["onBlockActions"] } = {}) {
  const log: string[] = [];
  const sockets: FakeSocket[] = [];
  const opens: { auth: string | null }[] = [];
  const actions: BlockActionsPayload[] = [];
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const replies = [...(opts.replies ?? [])];
  let n = 0;
  const deps: SocketDeps = {
    readAppToken: async () => ("token" in opts ? opts.token : "xapp-1-test"),
    fetch: async (_url, init) => {
      opens.push({ auth: new Headers(init?.headers).get("Authorization") });
      const reply = replies.shift() ?? { ok: true, url: `wss://slack.test/link/${++n}` };
      return new Response(JSON.stringify(reply), { status: 200 });
    },
    openSocket: (url) => {
      const ws = new FakeSocket(url, log);
      sockets.push(ws);
      return ws;
    },
    onBlockActions:
      opts.handler ??
      (async (payload) => {
        log.push(`handle ${payload.actions[0].action_id}`);
        actions.push(payload);
      }),
    setTimer: (fn, ms) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
  };
  const client = createSlackSocket(deps);
  // Fires the pending timers (a backoff or the hello deadline).
  const fireTimers = () => {
    for (const t of timers.splice(0)) if (!t.cancelled) t.fn();
  };
  const pending = () => timers.filter((t) => !t.cancelled);
  return { client, log, sockets, opens, actions, fireTimers, pending };
}

const blockActions = (actionId: string): BlockActionsPayload => ({
  type: "block_actions",
  user: { id: "U0123456" },
  actions: [{ action_id: actionId, value: "inc_1" }],
});

describe("Slack socket", () => {
  it("stays off without an app token and opens nothing", async () => {
    const t = setup({ token: undefined });
    t.client.start();
    await settle();
    assert.deepEqual(t.client.status(), { state: "off" });
    assert.equal(t.opens.length, 0);
    assert.equal(t.sockets.length, 0);
  });

  it("opens the URL Slack returns with the app token, and is connected after hello", async () => {
    const t = setup();
    t.client.start();
    await settle();
    assert.equal(t.opens[0].auth, "Bearer xapp-1-test");
    assert.equal(t.sockets.length, 1);
    assert.equal(t.sockets[0].url, "wss://slack.test/link/1");
    assert.equal(t.client.status().state, "connecting");

    t.sockets[0].receive({ type: "hello", num_connections: 1 });
    assert.deepEqual(t.client.status(), { state: "connected" });
  });

  it("acks every envelope before the handler runs, and passes block_actions on", async () => {
    const t = setup();
    t.client.start();
    await settle();
    const ws = t.sockets[0];
    ws.receive({ type: "hello" });

    ws.receive({ envelope_id: "e1", type: "interactive", payload: blockActions("approve_fix") });
    ws.receive({ envelope_id: "e2", type: "events_api", payload: { type: "event_callback" } });
    // Both acks go out synchronously, before any handler has run.
    assert.deepEqual(t.log, ['send {"envelope_id":"e1"}', 'send {"envelope_id":"e2"}']);
    await settle();
    assert.deepEqual(t.log, ['send {"envelope_id":"e1"}', 'send {"envelope_id":"e2"}', "handle approve_fix"]);
    assert.deepEqual(t.actions, [blockActions("approve_fix")]);
  });

  it("logs a failing handler and keeps the socket", async () => {
    const t = setup({ handler: async () => Promise.reject(new Error("boom")) });
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
    try {
      t.client.start();
      await settle();
      const ws = t.sockets[0];
      ws.receive({ type: "hello" });
      ws.receive({ envelope_id: "e1", type: "interactive", payload: blockActions("approve_fix") });
      await settle();
    } finally {
      console.error = original;
    }
    assert.deepEqual(t.sockets[0].sent, ['{"envelope_id":"e1"}']);
    assert.equal(t.client.status().state, "connected");
    assert.ok(errors.some((e) => e.includes("boom")));
  });

  it("moves to a fresh socket when Slack says disconnect", async () => {
    const t = setup();
    t.client.start();
    await settle();
    t.sockets[0].receive({ type: "hello" });
    t.sockets[0].receive({ type: "disconnect", reason: "refresh_requested" });
    await settle();
    assert.equal(t.sockets.length, 2);
    assert.ok(t.sockets[0].closed);
    assert.equal(t.sockets[1].url, "wss://slack.test/link/2");
    // Messages on the old socket are ignored from here on.
    t.sockets[0].onmessage?.({ data: JSON.stringify({ envelope_id: "late" }) });
    assert.deepEqual(t.sockets[0].sent, []);
    t.sockets[1].receive({ type: "hello" });
    assert.equal(t.client.status().state, "connected");
  });

  it("reconnects with backoff after a drop, and resets the backoff after hello", async () => {
    const t = setup({ replies: [{ ok: true, url: "wss://slack.test/a" }, { ok: false, error: "internal_error" }] });
    const original = console.error;
    console.error = () => {};
    try {
      t.client.start();
      await settle();
      t.sockets[0].receive({ type: "hello" });
      t.sockets[0].drop();
      assert.equal(t.client.status().state, "connecting");
      assert.deepEqual(t.pending().map((p) => p.ms), [1000]);

      // The next open fails with a passing error: retried, later.
      t.fireTimers();
      await settle();
      assert.equal(t.sockets.length, 1);
      assert.deepEqual(t.pending().map((p) => p.ms), [2000]);

      t.fireTimers();
      await settle();
      assert.equal(t.sockets.length, 2);
      t.sockets[1].receive({ type: "hello" });
      assert.equal(t.client.status().state, "connected");
      t.sockets[1].drop();
      assert.deepEqual(t.pending().map((p) => p.ms), [1000]);
    } finally {
      console.error = original;
    }
  });

  it("caps the backoff at 30 s", async () => {
    const t = setup({ replies: Array.from({ length: 8 }, () => ({ ok: false, error: "ratelimited" })) });
    const original = console.error;
    console.error = () => {};
    try {
      t.client.start();
      await settle();
      const delays: number[] = [];
      for (let i = 0; i < 7; i++) {
        delays.push(...t.pending().map((p) => p.ms));
        t.fireTimers();
        await settle();
      }
      assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
      t.client.stop();
    } finally {
      console.error = original;
    }
  });

  it("fails without retrying when Slack refuses the token", async () => {
    const t = setup({ replies: [{ ok: false, error: "invalid_auth" }] });
    const original = console.error;
    const logged: string[] = [];
    console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
    try {
      t.client.start();
      await settle();
    } finally {
      console.error = original;
    }
    assert.equal(t.client.status().state, "failed");
    assert.match(t.client.status().error!, /app token.*invalid_auth/);
    assert.equal(t.pending().length, 0);
    assert.equal(t.opens.length, 1);
    assert.ok(!logged.some((l) => l.includes("xapp-")));
  });

  it("restart closes the socket, cancels a pending retry and opens a new one", async () => {
    const t = setup();
    const original = console.error;
    console.error = () => {};
    try {
      t.client.start();
      await settle();
      t.sockets[0].drop();
      assert.equal(t.pending().length, 1);

      t.client.restart();
      assert.equal(t.pending().length, 0);
      await settle();
      assert.equal(t.sockets.length, 2);
      t.sockets[1].receive({ type: "hello" });

      t.client.restart();
      await settle();
      assert.ok(t.sockets[1].closed);
      assert.equal(t.sockets.length, 3);
      assert.equal(t.client.status().state, "connecting");
      // The retired socket closing doesn't count as a drop.
      t.sockets[1].onclose?.({ code: 1000 });
      assert.equal(t.sockets.length, 3);
    } finally {
      console.error = original;
    }
  });

  it("gives up on a socket that never says hello", async () => {
    const t = setup();
    const original = console.error;
    console.error = () => {};
    try {
      t.client.start();
      await settle();
      assert.deepEqual(t.pending().map((p) => p.ms), [30000]);
      t.fireTimers();
      assert.ok(t.sockets[0].closed);
      assert.deepEqual(t.pending().map((p) => p.ms), [1000]);
      t.client.stop();
    } finally {
      console.error = original;
    }
  });
});
