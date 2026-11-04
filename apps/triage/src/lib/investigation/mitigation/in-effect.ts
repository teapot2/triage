import type { Incident, Mitigation } from "../schema";
import { executorFor, type OpsState, readOpsState, shopfrontOps } from "./executors";

// Whether an incident's mitigation still holds on the service: applied, and
// not undone since. The watch asks before reopening an incident (watch.ts):
// with its flag still off, or its release still rolled back, the cause it
// diagnosed can't be what breaches again, so the breach gets an incident and
// an investigation of its own.
//
// false: never applied (proposed, denied, failed, or none), or undone since.
// true: applied and still in place. undefined: applied, but the service
// can't say (no ops API to read, or it didn't answer); the caller decides.
export async function mitigationInEffect(incident: Incident): Promise<boolean | undefined> {
  const m = incident.mitigation;
  if (m?.state !== "applied") return false;
  // Only the live store's ops API knows; Triage itself never undoes one.
  if (executorFor(incident) !== shopfrontOps) return undefined;
  try {
    return holds(m, await readOpsState());
  } catch {
    return undefined;
  }
}

// An applied mitigation against the store's state now: a flag_off holds while
// its flag is off; a rollback while the release it rolled back isn't
// deployed again (nothing deployed, or another release, which is a change of
// its own). Undefined when the state doesn't say: an unknown flag, or no
// release field.
export function holds(m: Pick<Mitigation, "kind" | "target">, ops: OpsState): boolean | undefined {
  if (m.kind === "flag_off") {
    const flag = ops.flags.find((f) => f.name === m.target);
    return flag ? !flag.enabled : undefined;
  }
  if (ops.release === undefined) return undefined;
  return ops.release === null || !sameSha(ops.release.sha, m.target);
}

// Short and full shas of the same commit match.
const sameSha = (a: string, b: string) => {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  return x.length > 0 && y.length > 0 && (x.startsWith(y) || y.startsWith(x));
};
