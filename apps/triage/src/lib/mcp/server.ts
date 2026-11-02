import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { answerQuestion } from "../investigation/ask/agent";
import { MAX_QUESTION_CHARS } from "../investigation/ask/rules";
import { startQuestion } from "../investigation/ask/start";
import { postmortemMarkdown } from "../investigation/postmortem/render";
import type { Evidence, Incident } from "../investigation/schema";
import { getIncident, isExample, listIncidents } from "../investigation/store";
import { openStatuses } from "../investigation/summary";
import {
  allEvidence,
  answerMarkdown,
  citedEvidence,
  evidenceMarkdown,
  fixMarkdown,
  incidentListMarkdown,
  incidentMarkdown,
  incidentRow,
} from "./format";

// Triage as an MCP server: a coding agent (Muse Code, or any MCP client)
// reads incidents, their cited reports, evidence, fixes and postmortems,
// and asks follow-up questions, from the terminal. Read-only but for
// ask_incident, which saves its question on the incident like the page's
// Ask does. Approvals stay on the incident's page, with a person.

const INSTRUCTIONS = `Triage is the team's SRE agent. It watches the services, opens an incident when an alert crosses its limit, investigates it with read-only tools and writes a cited report: hypotheses, a verdict and a causal chain (symptom, propagation, root cause) where every claim cites evidence IDs like [ev_log_3]. It proposes a mitigation and a fix proven in a sandbox, which a person approves on the incident's page.

- Start with list_incidents, or get_incident with "latest". get_incident returns the report and one line per cited evidence item; get_evidence returns items in full.
- Keep Triage's [ev_…] citations when you quote it, and never invent one.
- get_fix returns the proven patch as a unified diff and its regression test.
- ask_incident asks Triage a follow-up question; it investigates again if it needs to (up to about two minutes) and saves the question on the incident.
- These tools change nothing in production. To approve a fix or mitigation, open the incident's page.`;

const MAX_EVIDENCE = 20;

const incidentId = z.string().min(1).max(100).describe('Incident ID, e.g. "inc_pool_leak", or "latest" for the most recent');

const text = (body: string, structured?: Record<string, unknown>): CallToolResult => ({
  content: [{ type: "text", text: body }],
  ...(structured && { structuredContent: structured }),
});

const failure = (body: string): CallToolResult => ({ content: [{ type: "text", text: body }], isError: true });

// The incident an ID names, "latest" being the newest run (or the newest
// example when there are none); an error result listing recent IDs when
// there is no such incident, so the agent can pick one.
async function resolveIncident(id: string): Promise<Incident | CallToolResult> {
  if (id === "latest") {
    const latest = (await listIncidents())[0];
    return latest ?? failure("There are no incidents yet.");
  }
  const incident = /^inc_[a-z0-9_]+$/.test(id) ? await getIncident(id) : undefined;
  if (incident) return incident;
  const recent = (await listIncidents()).slice(0, 8).map((i) => `\`${i.id}\` (${i.title})`);
  return failure(`Unknown incident: ${id}. Recent incidents: ${recent.join(", ") || "none"}.`);
}

const isResult = (x: Incident | CallToolResult): x is CallToolResult => "content" in x;

export function createTriageMcpServer({ baseUrl }: { baseUrl: string }): McpServer {
  const server = new McpServer({ name: "triage", title: "Triage", version: "0.1.0" }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "list_incidents",
    {
      title: "List incidents",
      description:
        "Triage's incidents, newest first (runs, then the bundled examples): ID, title, service, severity, where it stands and a one-line headline (the root cause when Triage found one).",
      inputSchema: {
        status: z.enum(["open", "resolved", "all"]).default("all").describe("open: still being worked on; resolved: resolved or no issue found"),
        service: z.string().max(100).optional().describe('Only this service, e.g. "shopfront"'),
        limit: z.number().int().min(1).max(50).default(10),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ status, service, limit }) => {
      const incidents = (await listIncidents()).filter(
        (i) =>
          (!service || i.service === service) &&
          (status === "all" || (status === "open" ? openStatuses.includes(i.status) : !openStatuses.includes(i.status))),
      );
      const rows = incidents.slice(0, limit).map((i) => incidentRow(i, baseUrl, isExample(i.id)));
      return text(incidentListMarkdown(rows, incidents.length), { incidents: rows, total: incidents.length });
    },
  );

  server.registerTool(
    "get_incident",
    {
      title: "Get an incident's report",
      description:
        "One incident's cited report: summary, verdict and causal chain with [ev_…] citations, the other hypotheses and why they were ruled out, the alert, the mitigation, the fix and its approval, the resolution, and one line per cited evidence item.",
      inputSchema: { id: incidentId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      const incident = await resolveIncident(id);
      if (isResult(incident)) return incident;
      return text(incidentMarkdown(incident, baseUrl), {
        ...incidentRow(incident, baseUrl, isExample(incident.id)),
        verdict: incident.report?.verdict.kind ?? null,
        cited_evidence_ids: citedEvidence(incident).map((e) => e.id),
      });
    },
  );

  server.registerTool(
    "get_evidence",
    {
      title: "Get evidence",
      description: `Evidence items in full: log lines, spans with their attributes, metric series, database rows, source code and commits, each with the tool call that found it. Pick items by ID or by kind; with neither, the evidence the report cites. At most ${MAX_EVIDENCE} items per call.`,
      inputSchema: {
        incident_id: incidentId,
        ids: z.array(z.string().regex(/^ev_[a-z0-9_]+$/)).max(MAX_EVIDENCE).optional().describe("Evidence IDs, e.g. [\"ev_log_3\"]"),
        kind: z.enum(["log", "span", "metric", "db", "source", "commit"]).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ incident_id, ids, kind }) => {
      const incident = await resolveIncident(incident_id);
      if (isResult(incident)) return incident;
      const all = allEvidence(incident);
      let picked: Evidence[];
      let missing: string[] = [];
      if (ids?.length) {
        const byId = new Map(all.map((e) => [e.id, e]));
        picked = ids.flatMap((id) => byId.get(id) ?? []);
        missing = ids.filter((id) => !byId.has(id));
      } else {
        picked = kind ? all.filter((e) => e.kind === kind) : citedEvidence(incident);
      }
      const shown = picked.slice(0, MAX_EVIDENCE);
      const notes = [
        missing.length && `Not on this incident: ${missing.join(", ")}.`,
        picked.length > shown.length && `${shown.length} of ${picked.length} items shown; ask for the rest by ID.`,
        !picked.length && !missing.length && (kind ? `No ${kind} evidence on this incident.` : "The report cites no evidence."),
      ].filter(Boolean);
      const body = [...shown.map((e) => evidenceMarkdown(e, incident)), ...notes].join("\n\n");
      return text(body, { incident_id: incident.id, evidence: shown, missing });
    },
  );

  server.registerTool(
    "get_fix",
    {
      title: "Get the fix",
      description:
        "Triage's fix for an incident: what it changes, its risk, whether it changes stored data, the regression test, the sandbox runs that proved it (failing on the original code, passing on the patched) and the patch as a unified diff. Approval and the PR are on the incident's page.",
      inputSchema: {
        incident_id: incidentId,
        attempt: z.number().int().min(1).optional().describe("An earlier, denied fix by its place (1 = the first); the current fix by default"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ incident_id, attempt }) => {
      const incident = await resolveIncident(incident_id);
      if (isResult(incident)) return incident;
      return text(fixMarkdown(incident, attempt));
    },
  );

  server.registerTool(
    "get_postmortem",
    {
      title: "Get the postmortem",
      description: "The incident's blameless postmortem as Markdown, once one has been written on its page.",
      inputSchema: { incident_id: incidentId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ incident_id }) => {
      const incident = await resolveIncident(incident_id);
      if (isResult(incident)) return incident;
      const pm = incident.postmortem;
      if (pm?.status !== "ready") {
        const state = pm?.status === "writing" ? "is still being written" : pm?.status === "failed" ? "failed to write" : "hasn't been written";
        return text(`The postmortem for \`${incident.id}\` ${state}. Write it from the incident's page.`);
      }
      return text(postmortemMarkdown(incident));
    },
  );

  server.registerTool(
    "ask_incident",
    {
      title: "Ask Triage about an incident",
      description:
        "Asks Triage a follow-up question about a finished incident. It answers from the recorded evidence and, when that doesn't settle it, investigates again with its read-only tools, citing evidence IDs. Takes up to about two minutes. The question and answer are saved on the incident, where the team sees them.",
      inputSchema: {
        incident_id: incidentId,
        question: z.string().trim().min(1).max(MAX_QUESTION_CHARS),
      },
      // Saves the question; changes nothing in the system it asks about.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ incident_id, question }, extra) => {
      const resolved = await resolveIncident(incident_id);
      if (isResult(resolved)) return resolved;
      const started = await startQuestion(resolved.id, question, { via: "mcp" });
      if (!started.ok) return failure(`Can't ask now: ${started.error}`);

      // Each tool Triage calls, as progress, when the client asked for it.
      const token = extra._meta?.progressToken;
      let calls = 0;
      const onToolCall =
        token === undefined
          ? undefined
          : (tool: string) => {
              calls += 1;
              void extra
                .sendNotification({
                  method: "notifications/progress",
                  params: { progressToken: token, progress: calls, message: `Triage is calling ${tool}` },
                })
                .catch(() => {});
            };
      const result = await answerQuestion(started.incident, started.question, { onToolCall });
      await result.consumeStream();

      const incident = (await getIncident(resolved.id)) ?? started.incident;
      const answered = incident.questions?.find((q) => q.id === started.question.id);
      if (!answered) return failure(`The answer to ${started.question.id} wasn't saved.`);
      const body = answerMarkdown(answered, incident, baseUrl);
      return answered.status === "failed" ? failure(body) : text(body);
    },
  );

  return server;
}
