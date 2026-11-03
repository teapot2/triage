import type { SQLOutputValue } from "node:sqlite";
import { getDb, transaction } from "@/lib/db";
import { type Audit, type Finding, findingSchema, type SeverityCounts, type StoredFinding } from "./model";

// Audits and findings in SQLite (db.ts). A successful audit writes its row
// and brings every finding up to date in one transaction: found ones are
// seen now (and back, if they had gone), the rest of the service's open
// ones are gone as of this audit. A failed audit writes its row only, so
// the findings stand as the last audit that ran left them.

// Audit rows kept per service, newest; the package manager's JSON is kept
// on the latest only.
const KEEP_AUDITS = 500;

const iso = (ms: SQLOutputValue) => new Date(Number(ms)).toISOString();

function toAudit(row: Record<string, SQLOutputValue>): Audit {
  return {
    id: Number(row.id),
    service: String(row.service),
    at: iso(row.at),
    durationMs: Number(row.duration_ms),
    ...(row.package_manager === null ? {} : { packageManager: row.package_manager as Audit["packageManager"] }),
    counts: JSON.parse(String(row.counts)) as SeverityCounts,
    runtime: Number(row.runtime),
    ...(row.error === null ? {} : { error: String(row.error) }),
  };
}

function toFinding(row: Record<string, SQLOutputValue>): StoredFinding {
  return {
    ...findingSchema.parse(JSON.parse(String(row.body))),
    firstSeen: iso(row.first_seen),
    lastSeen: iso(row.last_seen),
    ...(row.incident_id === null ? {} : { incidentId: String(row.incident_id) }),
    ...(row.gone_at === null ? {} : { goneAt: iso(row.gone_at) }),
  };
}

export type AuditChanges = {
  audit: Audit;
  // Found for the first time, or found again after an audit had stopped
  // finding them.
  appeared: StoredFinding[];
  // Found before, and by this audit too.
  still: StoredFinding[];
  // Found before, not by this audit.
  gone: StoredFinding[];
};

// Saves an audit and, when it ran (`findings` given), what it found.
export function recordAudit(audit: Omit<Audit, "id">, findings?: Finding[], raw?: string): AuditChanges {
  const db = getDb();
  const at = Date.parse(audit.at);
  return transaction(db, () => {
    db.prepare("UPDATE dependency_audits SET raw = NULL WHERE service = ? AND raw IS NOT NULL").run(audit.service);
    const { lastInsertRowid } = db
      .prepare(
        "INSERT INTO dependency_audits (service, at, duration_ms, package_manager, counts, runtime, error, raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        audit.service,
        at,
        audit.durationMs,
        audit.packageManager ?? null,
        JSON.stringify(audit.counts),
        audit.runtime,
        audit.error ?? null,
        raw ?? null,
      );
    db.prepare(
      `DELETE FROM dependency_audits WHERE service = ? AND id NOT IN
        (SELECT id FROM dependency_audits WHERE service = ? ORDER BY at DESC, id DESC LIMIT ${KEEP_AUDITS})`,
    ).run(audit.service, audit.service);
    const saved = { ...audit, id: Number(lastInsertRowid) };
    if (!findings) return { audit: saved, appeared: [], still: [], gone: [] };

    const before = new Map(listFindings(audit.service, { gone: true }).map((f) => [f.advisoryId, f]));
    const upsert = db.prepare(
      `INSERT INTO dependency_findings (service, advisory_id, package, severity, dev, first_seen, last_seen, gone_at, incident_id, body)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
       ON CONFLICT (service, advisory_id) DO UPDATE SET
         package = excluded.package, severity = excluded.severity, dev = excluded.dev,
         last_seen = excluded.last_seen, gone_at = NULL, body = excluded.body`,
    );
    const appeared: StoredFinding[] = [];
    const still: StoredFinding[] = [];
    const found = new Set<string>();
    for (const f of findings) {
      found.add(f.advisoryId);
      upsert.run(f.service, f.advisoryId, f.package, f.severity, f.dev ? 1 : 0, at, at, JSON.stringify(f));
      const prior = before.get(f.advisoryId);
      const now = getFinding(f.service, f.advisoryId)!;
      if (!prior || prior.goneAt) appeared.push(now);
      else still.push(now);
    }
    const gone: StoredFinding[] = [];
    const markGone = db.prepare("UPDATE dependency_findings SET gone_at = ? WHERE service = ? AND advisory_id = ?");
    for (const f of before.values()) {
      if (found.has(f.advisoryId) || f.goneAt) continue;
      markGone.run(at, f.service, f.advisoryId);
      gone.push({ ...f, goneAt: audit.at });
    }
    return { audit: saved, appeared, still, gone };
  });
}

// The service's findings, most severe first; with `gone`, those no audit
// finds any more too.
export function listFindings(service: string, opts: { gone?: boolean } = {}): StoredFinding[] {
  const rows = getDb()
    .prepare(`SELECT * FROM dependency_findings WHERE service = ? ${opts.gone ? "" : "AND gone_at IS NULL"} ORDER BY first_seen`)
    .all(service);
  const rank = ["critical", "high", "moderate", "low", "info"];
  return rows.map(toFinding).sort((a, b) => rank.indexOf(a.severity) - rank.indexOf(b.severity) || Number(a.dev) - Number(b.dev));
}

export function getFinding(service: string, advisoryId: string): StoredFinding | undefined {
  const row = getDb().prepare("SELECT * FROM dependency_findings WHERE service = ? AND advisory_id = ?").get(service, advisoryId);
  return row && toFinding(row);
}

export function setFindingIncident(service: string, advisoryId: string, incidentId: string | undefined) {
  getDb()
    .prepare("UPDATE dependency_findings SET incident_id = ? WHERE service = ? AND advisory_id = ?")
    .run(incidentId ?? null, service, advisoryId);
}

// Newest first.
export function listAudits(service: string, limit = 50): Audit[] {
  return getDb()
    .prepare("SELECT * FROM dependency_audits WHERE service = ? ORDER BY at DESC, id DESC LIMIT ?")
    .all(service, limit)
    .map(toAudit);
}

export function latestAudit(service: string): Audit | undefined {
  return listAudits(service, 1)[0];
}

// The latest successful audit's JSON, as the package manager wrote it.
export function latestRaw(service: string): string | undefined {
  const row = getDb()
    .prepare("SELECT raw FROM dependency_audits WHERE service = ? AND raw IS NOT NULL ORDER BY at DESC LIMIT 1")
    .get(service);
  return row?.raw === undefined || row.raw === null ? undefined : String(row.raw);
}
