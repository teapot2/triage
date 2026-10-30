import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Incident } from "../schema";
import { patchIncident } from "../store";
import { startVerification, verificationRefusal } from "../verify";

// After Stage 5: notices that the fix's PR was merged, records when, and
// starts verifying the fix from that moment. There's no background poll:
// the incident page asks, at most once a minute per incident, while the PR
// is open. Nothing here merges anything.

const run = promisify(execFile);

const EVERY_MS = 60_000;

// On globalThis so dev hot reloads keep them: when each incident's PR was
// last checked, and what was last logged for it (each outcome is logged
// once, not every minute).
const g = globalThis as unknown as { triagePrChecks?: Map<string, number>; triagePrLogged?: Map<string, string> };
const checkedAt = (g.triagePrChecks ??= new Map());
const logged = (g.triagePrLogged ??= new Map());

function logOnce(id: string, line: string) {
  if (logged.get(id) === line) return;
  logged.set(id, line);
  console.log(`[triage] PR check on ${id}: ${line}`);
}

// Never throws.
export async function checkPrMerged(incident: Incident): Promise<void> {
  const url = incident.approval?.prUrl;
  if (!url) return;
  const last = checkedAt.get(incident.id);
  if (last !== undefined && Date.now() - last < EVERY_MS) return;
  checkedAt.set(incident.id, Date.now());
  try {
    const { stdout } = await run("gh", ["pr", "view", url, "--json", "state,mergedAt"], {
      timeout: 10_000,
      windowsHide: true,
    });
    const pr = JSON.parse(stdout) as { state?: string; mergedAt?: string | null };
    if (pr.state !== "MERGED" || !pr.mergedAt) {
      logOnce(incident.id, `${url} is ${pr.state?.toLowerCase() ?? "in an unknown state"}`);
      return;
    }
    const mergedAt = new Date(pr.mergedAt).toISOString();
    const saved = await patchIncident(incident.id, (i) =>
      i.approval ? { ...i, approval: { ...i.approval, prMergedAt: mergedAt } } : i,
    );
    logOnce(incident.id, `${url} merged at ${mergedAt}`);
    if (saved.status === "resolved") return;
    const refusal = verificationRefusal(saved, "fix");
    if (refusal) {
      logOnce(incident.id, `not verifying the merged fix: ${refusal}`);
      return;
    }
    // The loop runs on its own; a refusal it raises before saving is logged.
    void startVerification(saved.id, { after: "fix", since: mergedAt }).catch((err: unknown) =>
      logOnce(incident.id, `couldn't verify the merged fix: ${err instanceof Error ? err.message : String(err)}`),
    );
  } catch (err) {
    // gh missing, not signed in, no network, or a timeout: try again on a
    // later page load.
    const e = err as { stderr?: string; message?: string };
    logOnce(incident.id, `couldn't read ${url}: ${(e.stderr || e.message || String(err)).trim().split("\n")[0]}`);
  }
}
