// Runs once when the server starts, before it handles requests.
export async function register() {
  // The incident store is files on disk: Node only.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { failInterruptedRuns } = await import("./lib/investigation/recover");
    const fixed = await failInterruptedRuns().catch((err) => {
      console.error("[triage] couldn't check for interrupted runs", err);
      return 0;
    });
    if (fixed > 0) console.log(`[triage] marked ${fixed} interrupted run(s) as failed`);

    // Stage 1: watch the live store. TRIAGE_WATCH=0 leaves it off (it can
    // also be paused from the sidebar).
    if (process.env.TRIAGE_WATCH !== "0") {
      const { startWatch } = await import("./lib/investigation/watch");
      startWatch();
    }

    // The Slack bot's Socket Mode client, for button clicks in Slack. Stays
    // off until an app token is saved; Settings restarts it on a change.
    const { startSlackSocket } = await import("./lib/notifications/socket");
    startSlackSocket();
  }
}
