// Writes what moved into .data/triage.db back out as the JSON files Triage
// kept before: one .data/incidents/<id>.json per incident, settings.json,
// uptime-checks.json and notifications.json. It's the way back if the move
// to SQLite has to be undone: run this, then check out the code from before
// it. The database itself is left as it is. Run from apps/triage.
//
//   pnpm --filter @triage/web export:incidents

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getDb } from "../src/lib/db";

const data = path.join(process.cwd(), ".data");
const db = getDb();

function write(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

const incidents = db.prepare("SELECT id, body FROM incidents").all() as { id: string; body: string }[];
for (const { id, body } of incidents) write(path.join(data, "incidents", `${id}.json`), JSON.parse(body));
console.log(`${incidents.length} incidents → .data/incidents/`);

const documents = db.prepare("SELECT name, body FROM documents").all() as { name: string; body: string }[];
for (const { name, body } of documents) {
  write(path.join(data, `${name}.json`), JSON.parse(body));
  console.log(`${name} → .data/${name}.json`);
}

const deliveries = (
  db.prepare("SELECT at, kind, incident_id, ok, error FROM notification_deliveries ORDER BY at DESC, id DESC").all() as {
    at: number;
    kind: string;
    incident_id: string | null;
    ok: number;
    error: string | null;
  }[]
).map((d) => ({
  at: new Date(d.at).toISOString(),
  kind: d.kind,
  ...(d.incident_id !== null && { incidentId: d.incident_id }),
  ok: d.ok === 1,
  ...(d.error !== null && { error: d.error }),
}));
const sent = (db.prepare("SELECT key FROM notification_sent ORDER BY at, rowid").all() as { key: string }[]).map((s) => s.key);
write(path.join(data, "notifications.json"), { deliveries, sent });
console.log(`${deliveries.length} deliveries, ${sent.length} sent keys → .data/notifications.json`);
