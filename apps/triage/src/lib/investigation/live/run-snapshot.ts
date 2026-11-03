import { execFile } from "node:child_process";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { RunSnapshot } from "../schema";
import type { DbCheck, DbResult, TelemetrySource } from "../source";
import { dbQueries, fetchRelease, gitLog, listSourceFiles, normalize, shopfrontDir } from "./live-source";

// What a live investigation reads that a re-run couldn't read again: the
// database checks answer for the database as it is now, and read_source and
// git_log for the code on disk now, which a fix or a rollback may have
// changed since. As a live run starts, the three checks run once and the
// readable source is copied beside the incident, with the commit git_log
// reads from. A re-run reads these, and the telemetry, which is already
// read as of the alert (createLiveSource's `now`).

const root = () => path.join(/* turbopackIgnore: true */ process.cwd(), ".data", "snapshots");
const dirFor = (id: string) => {
  if (!/^inc_[a-z0-9_]+$/.test(id)) throw new Error(`invalid incident id: ${id}`);
  return path.join(/* turbopackIgnore: true */ root(), id);
};
// The source as it stood, laid out as in the app: the sandbox copies it
// over the app when a re-run proves a fix.
export const snapshotSourceDir = (id: string) => path.join(/* turbopackIgnore: true */ dirFor(id), "source");
const dbFile = (id: string) => path.join(/* turbopackIgnore: true */ dirFor(id), "db.json");

// The whole snapshot, for a permanent delete of its incident.
export async function deleteRunSnapshot(id: string): Promise<void> {
  await rm(dirFor(id), { recursive: true, force: true });
}

const run = promisify(execFile);

async function headSha(): Promise<string | undefined> {
  try {
    const { stdout } = await run("git", ["-C", shopfrontDir, "rev-parse", "HEAD"], { timeout: 5000 });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

// Takes the incident's snapshot from the running Shopfront, or undefined
// when it couldn't be saved (the source unreadable, the disk full): a
// re-run of it is then turned down. A database that doesn't answer is
// saved as the error the check would have shown.
export async function takeRunSnapshot(
  incidentId: string,
  source: Pick<TelemetrySource, "dbDiagnostics">,
): Promise<RunSnapshot | undefined> {
  const takenAt = new Date().toISOString();
  try {
    const dir = dirFor(incidentId);
    await rm(dir, { recursive: true, force: true });
    await mkdir(snapshotSourceDir(incidentId), { recursive: true });
    const checks = Object.keys(dbQueries) as DbCheck[];
    const [db, files, release, head] = await Promise.all([
      Promise.all(checks.map(async (c) => [c, await source.dbDiagnostics(c)] as const)),
      listSourceFiles(),
      fetchRelease(),
      headSha(),
    ]);
    await writeFile(dbFile(incidentId), JSON.stringify(Object.fromEntries(db), null, 2));
    for (const file of files) {
      await cp(path.join(/* turbopackIgnore: true */ shopfrontDir, file), path.join(/* turbopackIgnore: true */ snapshotSourceDir(incidentId), file));
    }
    return { takenAt, gitFrom: release?.sha ?? head };
  } catch (err) {
    console.error("[triage] couldn't save the run's snapshot", incidentId, err);
    return undefined;
  }
}

// Whether the incident's snapshot is still on disk.
export async function hasSnapshotFiles(incidentId: string): Promise<boolean> {
  return readFile(dbFile(incidentId), "utf8").then(
    () => true,
    () => false,
  );
}

// `source` with the database, source and git reads answered from the
// incident's snapshot.
export async function withSnapshot(source: TelemetrySource, incidentId: string, snapshot: RunSnapshot): Promise<TelemetrySource> {
  const db = JSON.parse(await readFile(dbFile(incidentId), "utf8")) as Partial<Record<DbCheck, DbResult>>;
  const dir = snapshotSourceDir(incidentId);
  const files = (await listSnapshotFiles(dir)).sort();
  const known = new Set(files);
  return {
    ...source,
    describe: () => source.describe(),
    async dbDiagnostics(check) {
      return db[check] ?? { query: dbQueries[check], rows: [{ error: "not in the snapshot taken when the investigation started" }] };
    },
    async listSourceFiles() {
      return files;
    },
    async readSource(file) {
      const rel = normalize(file);
      if (!known.has(rel)) return undefined;
      return { path: rel, content: await readFile(path.join(/* turbopackIgnore: true */ dir, rel), "utf8") };
    },
    // History is fixed once committed: from the commit the run read from,
    // it reads the same however much has been committed since.
    async gitLog(q) {
      return snapshot.gitFrom ? gitLog({ ...q, from: snapshot.gitFrom }) : source.gitLog(q);
    },
  };
}

async function listSnapshotFiles(dir: string, rel = ""): Promise<string[]> {
  const entries = await readdir(path.join(/* turbopackIgnore: true */ dir, rel), { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map((e) => {
      const child = rel ? `${rel}/${e.name}` : e.name;
      return e.isDirectory() ? listSnapshotFiles(dir, child) : Promise.resolve([child]);
    }),
  );
  return nested.flat();
}
