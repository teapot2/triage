import { readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { exampleIncidents } from "./fixtures";
import { type Incident, type IncidentStatus, incidentSchema } from "./schema";
import { saveIncident } from "./store";

// Demo data for trying the UI with more than a handful of incidents: every
// status and severity, several services, spread over the last week, enough
// to page the list. Built from the two bundled examples (the pool leak, with
// its fix and approval, and the healthy control run), so each one opens to a
// full report; their investigation details are the examples', reused.

export const DEMO_PREFIX = "inc_demo_";
export const isDemo = (id: string) => id.startsWith(DEMO_PREFIX);

const [poolLeak, controlRun] = exampleIncidents;

const services = [
  { service: "shopfront", route: "GET /api/products/:id" },
  { service: "checkout-api", route: "POST /checkout" },
  { service: "payments", route: "POST /charges" },
  { service: "search", route: "GET /search" },
  { service: "auth-gateway", route: "POST /sessions" },
  { service: "inventory-worker", route: "GET /stock/:sku" },
];

// Ten states, repeated: mostly finished runs, with some of each kind that
// needs a person.
const states: IncidentStatus[] = [
  "diagnosed",
  "healthy",
  "awaiting_approval",
  "diagnosed",
  "resolved",
  "failed",
  "healthy",
  "diagnosed",
  "investigating",
  "healthy",
];

const COUNT = 30;
const minutes = (n: number) => n * 60_000;

function demoIncident(i: number, now: number): Incident {
  const status = states[i % states.length];
  const { service, route } = services[i % services.length];
  const base = structuredClone(status === "healthy" ? controlRun : poolLeak);
  // A healthy run is sev4; the rest spread across the incident levels.
  const severity: Incident["severity"] =
    status === "healthy" ? "sev4" : (["sev1", "sev2", "sev2", "sev3"] as const)[i % 4];

  // Spread over about a week, newest first, at uneven minutes.
  const startedAt = now - minutes(i * 330 + 20 + ((i * 17) % 50));
  const finishedAt = startedAt + minutes(2) + ((i * 13) % 60) * 1000;
  const iso = (t: number) => new Date(t).toISOString();

  const incident: Incident = {
    ...base,
    id: `${DEMO_PREFIX}${String(i + 1).padStart(2, "0")}`,
    title: status === "healthy" ? `Control run: ${route} latency check` : `p95 latency above 500 ms on ${route}`,
    service,
    severity,
    status,
    detectedAt: iso(startedAt - minutes(1)),
    run: { source: "demo", model: "muse-spark-1.3", startedAt: iso(startedAt), finishedAt: iso(finishedAt) },
  };

  switch (status) {
    case "awaiting_approval":
      incident.approval = { state: "pending", requestedAt: iso(finishedAt) };
      break;
    case "diagnosed":
      // A decided fix, approved or denied in turn.
      incident.approval = {
        state: i % 2 === 0 ? "approved" : "denied",
        requestedAt: iso(finishedAt),
        decidedAt: iso(finishedAt + minutes(8)),
      };
      break;
    case "resolved":
      incident.approval = { state: "approved", requestedAt: iso(finishedAt), decidedAt: iso(finishedAt + minutes(5)) };
      incident.resolvedAt = iso(finishedAt + minutes(9));
      break;
    case "failed":
      Object.assign(incident, { report: undefined, fix: undefined, validation: undefined, approval: undefined });
      incident.steps = incident.steps.slice(0, 3);
      incident.run = { ...incident.run!, error: "No accepted report after 30 model steps" };
      break;
    case "investigating": {
      // Partway through: a few calls done, the last still running.
      Object.assign(incident, { report: undefined, fix: undefined, validation: undefined, approval: undefined });
      const steps = incident.steps.slice(0, 4);
      const last = steps.at(-1);
      if (last) steps[steps.length - 1] = { ...last, status: "running", durationMs: undefined, summary: undefined };
      incident.steps = steps;
      incident.run = { source: "demo", model: "muse-spark-1.3", startedAt: iso(startedAt) };
      break;
    }
  }
  return incidentSchema.parse(incident);
}

export async function seedDemoIncidents(): Promise<number> {
  const now = Date.now();
  for (let i = 0; i < COUNT; i++) await saveIncident(demoIncident(i, now));
  return COUNT;
}

export async function removeDemoIncidents(): Promise<number> {
  const dir = path.join(process.cwd(), ".data", "incidents");
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  const demo = names.filter((n) => isDemo(n) && n.endsWith(".json"));
  await Promise.all(demo.map((n) => unlink(path.join(dir, n))));
  return demo.length;
}
