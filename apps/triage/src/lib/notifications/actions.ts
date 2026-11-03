import { decideApproval, openPr, type SlackDecider } from "../investigation/approval";
import type { DecideResult } from "../investigation/approval";
import { shopfrontDir } from "../investigation/live/live-source";
import { applyMitigation, decideMitigation } from "../investigation/mitigation/decide";
import { readSlackBot, type SlackBot } from "../models/settings";
import { refreshSlackCard } from "./notify";
import { postEphemeral } from "./slack-api";

// What a click on a button in a Slack message does. Only people on the
// approver list in Settings can decide; anyone else is told so privately.
// A click runs the same functions as the incident page, so a second click
// or a card that is out of date is refused the same way, and the card is
// brought up to date either way.

// The parts of Slack's block_actions payload Triage reads.
export type BlockActionsPayload = {
  type: "block_actions";
  user: { id: string; username?: string; name?: string };
  channel?: { id: string };
  container?: { message_ts?: string; channel_id?: string; thread_ts?: string };
  response_url?: string;
  actions: { action_id: string; value?: string; block_id?: string }[];
};

export type ActionDeps = {
  readBot: () => Promise<SlackBot>;
  tell: (bot: SlackBot, payload: BlockActionsPayload, text: string) => Promise<unknown>;
  decideMitigation: (id: string, decision: "approved" | "denied", by: SlackDecider) => Promise<DecideResult>;
  applyMitigation: (id: string) => Promise<void>;
  decideFix: (id: string, by: SlackDecider) => Promise<DecideResult>;
  openPr: (id: string) => Promise<void>;
  refresh: (id: string) => Promise<void>;
};

// A private reply under the message that was clicked.
async function tellPrivately(bot: SlackBot, payload: BlockActionsPayload, text: string) {
  const channel = payload.channel?.id ?? payload.container?.channel_id;
  if (!bot.botToken || !channel) return;
  const reply = await postEphemeral(bot.botToken, channel, payload.user.id, text, payload.container?.thread_ts);
  if (!reply.ok) console.error("[triage] slack reply failed", reply.error);
}

const realDeps: ActionDeps = {
  readBot: readSlackBot,
  tell: tellPrivately,
  decideMitigation,
  applyMitigation,
  decideFix: (id, by) => decideApproval(id, "approved", undefined, false, by),
  openPr: (id) => openPr(id, shopfrontDir),
  refresh: refreshSlackCard,
};

export async function handleBlockActions(payload: BlockActionsPayload, deps: ActionDeps = realDeps): Promise<void> {
  const action = payload.actions[0];
  // "Open in Triage" is a link; Slack reports the click anyway.
  if (!action || action.action_id === "open_triage") return;
  const bot = await deps.readBot();
  const tell = (text: string) => deps.tell(bot, payload, text);

  if (action.action_id === "test_button") {
    await tell("Buttons work: Triage got your click.");
    return;
  }
  if (!bot.approvers.includes(payload.user.id)) {
    await tell("You're not on Triage's approver list, so nothing changed. Approvers are set in Triage under Settings → Notifications.");
    return;
  }
  const id = action.value;
  if (!id) return;
  const by: SlackDecider = { name: payload.user.name ?? payload.user.username ?? payload.user.id, slackUser: payload.user.id };

  let result: DecideResult;
  switch (action.action_id) {
    case "mitigation_approve":
      result = await deps.decideMitigation(id, "approved", by);
      // Runs it, then watches the alert recover: minutes, so not awaited.
      if (result.ok) void deps.applyMitigation(id);
      break;
    case "mitigation_deny":
      result = await deps.decideMitigation(id, "denied", by);
      break;
    case "fix_approve":
      result = await deps.decideFix(id, by);
      if (result.ok && result.incident.approval?.prState === "opening") void deps.openPr(id);
      break;
    default:
      return;
  }
  if (!result.ok) {
    await tell(`Nothing changed: ${result.error}.`);
    await deps.refresh(id);
  }
}
