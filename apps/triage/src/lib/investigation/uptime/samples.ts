import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { checkIdPattern, sampleSchema, type UptimeSample } from "./model";

// Each check's recent results, oldest first, in .data/uptime/<id>.json as
// { samples: [] }. Only the last MAX_SAMPLES are kept: enough for the judge,
// the charts and an investigation, small enough to rewrite after every check.

export const MAX_SAMPLES = 500;

const fileSchema = z.object({ samples: z.array(sampleSchema) });

// The id names a file, so it must be one the model minted, never a path.
function samplesFile(checkId: string): string {
  if (!checkIdPattern.test(checkId)) throw new Error(`not an uptime check id: ${JSON.stringify(checkId)}`);
  return path.join(process.cwd(), ".data", "uptime", `${checkId}.json`);
}

// Results that can't be read start over: losing old samples beats a check
// that can never record another one.
async function read(file: string): Promise<UptimeSample[]> {
  try {
    return fileSchema.parse(JSON.parse(await readFile(file, "utf8"))).samples;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.error(`[triage] ${file} unreadable, starting over`, err);
    return [];
  }
}

export async function readSamples(checkId: string): Promise<UptimeSample[]> {
  return read(samplesFile(checkId));
}

// Appends per check, chained so a read and its write never interleave with
// another's (the loop's tick and a Check now at the same moment both land).
const queues = new Map<string, Promise<unknown>>();

// Resolves to the samples as saved, newest last, ready for the judge.
export async function appendSample(checkId: string, sample: UptimeSample): Promise<UptimeSample[]> {
  const file = samplesFile(checkId);
  const parsed = sampleSchema.parse(sample);
  const run = async () => {
    const samples = [...(await read(file)), parsed].slice(-MAX_SAMPLES);
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify({ samples }));
    await rename(tmp, file);
    return samples;
  };
  const next = (queues.get(file) ?? Promise.resolve()).then(run, run);
  queues.set(file, next);
  // Forget the queue once it drains, so deleted checks don't pile up.
  void next.finally(() => queues.get(file) === next && queues.delete(file)).catch(() => {});
  return next;
}

// For a deleted check.
export async function deleteSamples(checkId: string) {
  await rm(samplesFile(checkId), { force: true });
}
