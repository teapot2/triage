import { readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { getDb, transaction } from "../db";
import { type Delivery, messageKinds } from "./types";

// The notification log in .data/triage.db (db.ts): the attempts to send,
// for Settings, and the keys of the events already sent (or tried), so an
// event goes out once. Each change is one transaction, so two events at
// once both land and only one can claim a key, across processes too.

export const MAX_DELIVERIES = 50;
// Enough keys to cover every event still likely to be notified twice.
export const MAX_SENT = 500;

// Opens the database, bringing in the old log file the first time.
const imported = new WeakSet<DatabaseSync>();
function db(): DatabaseSync {
  const d = getDb();
  if (!imported.has(d)) {
    imported.add(d);
    importLogFile(d);
  }
  return d;
}

// Claims an event's key before anything is sent, so a second call for the
// same event finds it taken. False when it was already claimed. The oldest
// keys past MAX_SENT go.
export function claim(key: string): boolean {
  const d = db();
  return transaction(d, () => {
    const { changes } = d.prepare("INSERT OR IGNORE INTO notification_sent (key, at) VALUES (?, ?)").run(key, Date.now());
    if (Number(changes) === 0) return false;
    d.prepare(
      "DELETE FROM notification_sent WHERE rowid NOT IN (SELECT rowid FROM notification_sent ORDER BY at DESC, rowid DESC LIMIT ?)",
    ).run(MAX_SENT);
    return true;
  });
}

// Logs an attempt, keeping the newest MAX_DELIVERIES.
export function record(delivery: Delivery): void {
  const d = db();
  transaction(d, () => {
    d.prepare("INSERT INTO notification_deliveries (at, kind, incident_id, ok, error) VALUES (?, ?, ?, ?, ?)").run(
      Date.parse(delivery.at),
      delivery.kind,
      delivery.incidentId ?? null,
      delivery.ok ? 1 : 0,
      delivery.error ?? null,
    );
    d.prepare(
      "DELETE FROM notification_deliveries WHERE id NOT IN (SELECT id FROM notification_deliveries ORDER BY at DESC, id DESC LIMIT ?)",
    ).run(MAX_DELIVERIES);
  });
}

type DeliveryRow = { at: number; kind: Delivery["kind"]; incident_id: string | null; ok: number; error: string | null };

// The latest attempts, newest first.
export function recentDeliveries(limit = MAX_DELIVERIES): Delivery[] {
  const rows = db()
    .prepare("SELECT at, kind, incident_id, ok, error FROM notification_deliveries ORDER BY at DESC, id DESC LIMIT ?")
    .all(limit) as DeliveryRow[];
  return rows.map((r) => ({
    at: new Date(r.at).toISOString(),
    kind: r.kind,
    ...(r.incident_id !== null && { incidentId: r.incident_id }),
    ok: r.ok === 1,
    ...(r.error !== null && { error: r.error }),
  }));
}

// The log used to be .data/notifications.json, { deliveries (newest first),
// sent (oldest first) }. It moves in the first time the database is opened:
// all of it in one transaction, read back, and only then is the file
// deleted. A key already in stays; a delivery already in (an import cut
// short before the file went) isn't added twice. A file that doesn't parse
// is left for someone to look at, and the log starts empty: losing old
// attempts beats every later message failing on it.
const legacySchema = z.object({
  deliveries: z
    .array(
      z.object({
        at: z.string().refine((at) => !Number.isNaN(Date.parse(at)), "not a date"),
        kind: z.enum([...messageKinds, "test"]),
        incidentId: z.string().optional(),
        ok: z.boolean(),
        error: z.string().optional(),
      }),
    )
    .default([]),
  sent: z.array(z.string()).default([]),
});

function importLogFile(d: DatabaseSync) {
  const file = path.join(process.cwd(), ".data", "notifications.json");
  let log: z.infer<typeof legacySchema>;
  try {
    log = legacySchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.error(`[triage] ${file} unreadable, left in place`, err);
    return;
  }

  const insertSent = d.prepare("INSERT OR IGNORE INTO notification_sent (key, at) VALUES (?, ?)");
  const hasSent = d.prepare("SELECT 1 FROM notification_sent WHERE key = ?");
  const insertDelivery = d.prepare(
    `INSERT INTO notification_deliveries (at, kind, incident_id, ok, error)
     SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS
       (SELECT 1 FROM notification_deliveries WHERE at = ? AND kind = ? AND incident_id IS ?)`,
  );
  const hasDelivery = d.prepare("SELECT 1 FROM notification_deliveries WHERE at = ? AND kind = ? AND incident_id IS ?");
  const deliveryKey = (x: (typeof log.deliveries)[number]) => [Date.parse(x.at), x.kind, x.incidentId ?? null] as const;

  // The keys have no time of their own: all get the import's, and rowid
  // keeps their order. The deliveries go in oldest first, so ids rise with
  // time.
  const now = Date.now();
  transaction(d, () => {
    for (const key of log.sent) insertSent.run(key, now);
    for (const x of [...log.deliveries].reverse()) {
      insertDelivery.run(...deliveryKey(x), x.ok ? 1 : 0, x.error ?? null, ...deliveryKey(x));
    }
  });
  const missing =
    log.sent.filter((key) => !hasSent.get(key)).length + log.deliveries.filter((x) => !hasDelivery.get(...deliveryKey(x))).length;
  if (missing > 0) {
    console.error(`[triage] ${missing} entries of ${file} didn't read back; not deleted`);
    return;
  }
  try {
    unlinkSync(file);
  } catch (err) {
    console.error(`[triage] ${file} imported but not deleted`, err);
  }
  console.log(`[triage] imported ${log.deliveries.length} notification deliveries and ${log.sent.length} sent keys into the database`);
}
