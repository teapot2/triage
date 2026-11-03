import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { lookupNames, type SlackFetch } from "./slack-api";

// Slack as a table of method → reply.
const slack =
  (replies: Record<string, (params: URLSearchParams) => unknown>): SlackFetch =>
  async (url, init) => {
    const method = String(url).split("/").pop()!;
    const reply = replies[method]?.(new URLSearchParams(String(init?.body ?? ""))) ?? { ok: false, error: "unknown_method" };
    return new Response(JSON.stringify(reply), { status: 200 });
  };

describe("lookupNames", () => {
  it("names the bot, the channel and each approver", async () => {
    const names = await lookupNames(
      "xoxb-1",
      "C0ALERTS",
      ["U0ANA", "U0BO"],
      slack({
        "auth.test": () => ({ ok: true, user: "triage", team: "Personal" }),
        "conversations.info": (p) => ({ ok: true, channel: { name: p.get("channel") === "C0ALERTS" ? "alerts" : "?", is_member: true } }),
        "users.info": (p) =>
          p.get("user") === "U0ANA"
            ? { ok: true, user: { name: "ana", profile: { display_name: "Ana" } } }
            : { ok: true, user: { name: "bo", real_name: "Bo Diaz", profile: { display_name: "" } } },
      }),
    );
    assert.deepEqual(names, {
      bot: "triage",
      team: "Personal",
      channel: { name: "alerts", isMember: true },
      approvers: { U0ANA: "Ana", U0BO: "Bo Diaz" },
      problems: [],
    });
  });

  it("says which scope is missing, once, and keeps what it could read", async () => {
    const names = await lookupNames(
      "xoxb-1",
      "C0ALERTS",
      ["U0ANA", "U0BO"],
      slack({
        "auth.test": () => ({ ok: true, user: "triage", team: "Personal" }),
        "conversations.info": () => ({ ok: false, error: "missing_scope" }),
        "users.info": () => ({ ok: false, error: "missing_scope" }),
      }),
    );
    assert.equal(names.bot, "triage");
    assert.equal(names.channel, undefined);
    assert.deepEqual(names.approvers, {});
    assert.deepEqual(names.problems, [
      "Add the channels:read scope and reinstall to show the channel's name.",
      "Add the users:read scope and reinstall to show approvers' names.",
    ]);
  });

  it("blames the token alone when Slack refuses it", async () => {
    const names = await lookupNames(
      "xoxb-bad",
      "C0ALERTS",
      [],
      slack({
        "auth.test": () => ({ ok: false, error: "invalid_auth" }),
        "conversations.info": () => ({ ok: false, error: "invalid_auth" }),
      }),
    );
    assert.deepEqual(names.problems, ["Slack didn't accept the bot token (invalid_auth)."]);
  });
});
