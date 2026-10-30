import { readNotificationSettings } from "@/lib/models/settings";
import { sendTest } from "@/lib/notifications/notify";

// Sends a test message to the saved webhook, so a person can see it work
// before an incident needs it. The attempt is logged like any other.
export async function POST() {
  if (!(await readNotificationSettings()).slackWebhookUrl) {
    return Response.json({ error: "Save a Slack webhook first." }, { status: 409 });
  }
  const delivery = await sendTest();
  return delivery.ok
    ? Response.json({ ok: true, delivery })
    : Response.json({ error: delivery.error ?? "Slack didn't accept the message.", delivery }, { status: 502 });
}
