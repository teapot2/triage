import { connection } from "next/server";
import { z } from "zod";
import { writeNotificationSettings } from "@/lib/models/settings";
import { publicNotificationSettings } from "@/lib/notifications/notify";
import { notificationEvents, slackWebhookPattern } from "@/lib/notifications/types";

// Where Triage sends Slack messages and which events send one. The webhook
// URL goes in and never comes back: the reply has only its last characters.

const putSchema = z.object({
  // A new URL, "" to remove it, or absent to keep the saved one.
  slackWebhookUrl: z
    .string()
    .trim()
    .refine((url) => url === "" || slackWebhookPattern.test(url), "Paste a Slack incoming webhook URL (https://hooks.slack.com/services/…)")
    .optional(),
  events: z.partialRecord(z.enum(notificationEvents), z.boolean()).optional(),
});

export async function GET() {
  await connection();
  return Response.json(await publicNotificationSettings());
}

export async function PUT(req: Request) {
  const parsed = putSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: parsed.error.issues[0]?.message ?? "invalid notification settings" }, { status: 400 });
  }
  await writeNotificationSettings(parsed.data);
  return Response.json(await publicNotificationSettings());
}
