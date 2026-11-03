import { connection } from "next/server";
import { z } from "zod";
import { writeNotificationSettings, writeSlackBot } from "@/lib/models/settings";
import { publicNotificationSettings } from "@/lib/notifications/notify";
import { restartSlackSocket } from "@/lib/notifications/socket";
import {
  notificationEvents,
  slackAppTokenPattern,
  slackBotTokenPattern,
  slackChannelPattern,
  slackUserPattern,
  slackWebhookPattern,
} from "@/lib/notifications/types";

// Where Triage sends Slack messages and which events send one. The webhook
// URL and the bot's tokens go in and never come back: the reply has only
// their last characters.

// A new value, "" to remove it, or absent to keep the saved one.
const secret = (pattern: RegExp, message: string) =>
  z
    .string()
    .trim()
    .refine((value) => value === "" || pattern.test(value), message)
    .optional();

const putSchema = z.object({
  slackWebhookUrl: secret(slackWebhookPattern, "Paste a Slack incoming webhook URL (https://hooks.slack.com/services/…)"),
  events: z.partialRecord(z.enum(notificationEvents), z.boolean()).optional(),
  slackBot: z
    .object({
      botToken: secret(slackBotTokenPattern, "Paste the Bot User OAuth Token (xoxb-…)"),
      appToken: secret(slackAppTokenPattern, "Paste an app-level token (xapp-…) with the connections:write scope"),
      channel: secret(slackChannelPattern, "Paste the channel ID (C0…), found at the bottom of the channel's details"),
      // Replaces the saved list; [] clears it.
      approvers: z
        .array(
          z
            .string()
            .trim()
            .regex(slackUserPattern, { error: (iss) => `Approvers are member IDs (U0…), and ${JSON.stringify(iss.input)} isn't one` }),
        )
        .max(50, "Up to 50 approvers")
        .transform((ids) => [...new Set(ids)])
        .optional(),
    })
    .optional(),
});

export async function GET() {
  await connection();
  return Response.json(await publicNotificationSettings());
}

export async function PUT(req: Request) {
  const parsed = putSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // The field it's about (botToken, approvers…), so the form can show the
    // message in that field's place.
    const field = issue?.path.filter((key) => typeof key === "string").at(-1);
    return Response.json({ error: issue?.message ?? "invalid notification settings", field }, { status: 400 });
  }
  const { slackBot, ...rest } = parsed.data;
  await writeNotificationSettings(rest);
  if (slackBot) {
    await writeSlackBot(slackBot);
    restartSlackSocket();
  }
  return Response.json(await publicNotificationSettings());
}
