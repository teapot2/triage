import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { exampleIncidents } from "./fixtures";
import { type Incident, incidentSchema } from "./schema";

// Local JSON store, one file per incident. Fine for development and the
// demo machine; a hosted deploy needs a database behind the same functions.
const dir = path.join(process.cwd(), ".data", "incidents");

const fileFor = (id: string) => {
  if (!/^inc_[a-z0-9_]+$/.test(id)) throw new Error(`invalid incident id: ${id}`);
  return path.join(dir, `${id}.json`);
};

export async function saveIncident(incident: Incident): Promise<void> {
  await mkdir(dir, { recursive: true });
  const file = fileFor(incident.id);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(incident, null, 2));
  await rename(tmp, file);
}

async function readStored(id: string): Promise<Incident | undefined> {
  try {
    return incidentSchema.parse(JSON.parse(await readFile(fileFor(id), "utf8")));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

export async function getIncident(id: string): Promise<Incident | undefined> {
  return (await readStored(id)) ?? exampleIncidents.find((i) => i.id === id);
}

export async function listIncidents(): Promise<Incident[]> {
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".json"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const stored = (await Promise.all(names.map((n) => readStored(n.replace(/\.json$/, ""))))).filter(
    (i): i is Incident => i !== undefined,
  );
  // An example is saved once someone changes it (e.g. decides its approval);
  // the saved copy then stands in for the bundled one, in the examples' place.
  const storedById = new Map(stored.map((i) => [i.id, i]));
  const runs = stored
    .filter((i) => !isExample(i.id))
    .sort((a, b) => Date.parse(b.run?.startedAt ?? b.detectedAt) - Date.parse(a.run?.startedAt ?? a.detectedAt));
  return [...runs, ...exampleIncidents.map((e) => storedById.get(e.id) ?? e)];
}

export function isExample(id: string): boolean {
  return exampleIncidents.some((i) => i.id === id);
}
