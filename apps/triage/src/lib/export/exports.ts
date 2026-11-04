import { z } from "zod";
import { parseListParams } from "@/app/list-params";
import { filterIncidents } from "@/lib/investigation/filter";
import { toSummary } from "@/lib/investigation/list-summary";
import { actionItems } from "@/lib/investigation/postmortem/render";
import { sortIncidents } from "@/lib/investigation/sort";
import type { Incident } from "@/lib/investigation/schema";
import { getIncident, listIncidents } from "@/lib/investigation/store";
import { checkIdPattern, readChecks } from "@/lib/investigation/uptime/checks";
import { readHourly, readSamplesSince } from "@/lib/investigation/uptime/samples";
import { listFindings } from "@/lib/investigation/dependencies/store";
import { dependencyFindings, shownFindings } from "./datasets/dependencies";
import { endpointHourly, endpointResults } from "./datasets/endpoint";
import {
  answerRows,
  askAnswers,
  dbRows,
  evidenceDb,
  evidenceLogs,
  evidenceMetrics,
  evidenceSource,
  evidenceSpans,
  fixPatch,
  incidentRecord,
  incidentSubject,
  investigationTrace,
  logRows,
  metricRows,
  sourceRows,
  spanRows,
  traceRows,
} from "./datasets/incident";
import { incidentList, incidentUrl } from "./datasets/incidents";
import { postmortemActions } from "./datasets/postmortem";
import type { Dataset } from "./dataset";
import { defineExport, exportRegistry } from "./registry";

// Every server export, by dataset id: /api/export/<id>. Add one per line.
// Browser-safe dataset definitions live in datasets/; loaders stay here.

const checkParams = z.object({ id: z.string().regex(checkIdPattern, "id: an uptime check id (chk_ and 6 letters or digits)") });

async function endpointSubject(id: string) {
  const check = (await readChecks()).find((c) => c.id === id);
  return check && { kind: "endpoint", id: check.id, name: check.name };
}

// All of what's stored, from the start of time: retention (RAW_HOURS,
// HOURLY_DAYS) decides the window, so nothing kept is left out.
const EPOCH = new Date(0).toISOString();
const END_OF_TIME = new Date(8.64e15).toISOString();

// The incident list's own query keys (app/list-params.ts), as its page's URL
// has them; parseListParams reads them as the page does. archived is the
// export's own: active incidents only unless it says include (or only, for
// Settings' archived list), as the list itself leaves them out.
const listKey = z.string().optional();
const listParams = z.object({
  q: listKey,
  status: listKey,
  severity: listKey,
  service: listKey,
  sort: listKey,
  size: listKey,
  page: listKey,
  archived: z.enum(["exclude", "include", "only"], "archived: exclude, include or only").optional(),
});

// The audited service, as the dependency audit files it: Shopfront, or the
// folder name of the directory the settings name.
const dependencyParams = z.object({ service: z.string().regex(/^[\w.@-]{1,200}$/, "service: the audited service's name") });

// As the store names incident files.
const incidentParams = z.object({ id: z.string().regex(/^inc_[a-z0-9_]+$/, "id: an incident id (inc_ and lowercase letters, digits or _)") });

// An incident's export: a 404 without the incident, or when it has nothing
// of this kind (no spans, no fix), as the page then offers no such file.
function incidentExport<Row>(dataset: Dataset<Row>, rowsOf: (incident: Incident) => Row[]) {
  return defineExport({
    dataset,
    params: incidentParams,
    load: async ({ id }) => {
      const incident = await getIncident(id);
      const rows = incident ? rowsOf(incident) : [];
      return incident && rows.length > 0 ? { subject: incidentSubject(incident), rows } : undefined;
    },
  });
}

export const exportEntries = exportRegistry([
  defineExport({
    dataset: endpointResults,
    params: checkParams,
    load: async ({ id }) => {
      const subject = await endpointSubject(id);
      return subject && { subject, rows: await readSamplesSince(id, EPOCH) };
    },
  }),
  defineExport({
    dataset: endpointHourly,
    params: checkParams,
    load: async ({ id }) => {
      const subject = await endpointSubject(id);
      return subject && { subject, rows: await readHourly(id, EPOCH, END_OF_TIME) };
    },
  }),
  defineExport({
    dataset: incidentList,
    params: listParams,
    // What the list shows, with the bundled examples as it shows them, on
    // every page: the size and page are read and left out. Nothing matching
    // is a 404, as the list then offers no file.
    load: async ({ archived, ...params }, { origin }) => {
      const asked = parseListParams(params);
      // Whole incidents, for the columns; filtered and sorted on their
      // summaries, as the page does.
      const listed = (await listIncidents({ archived })).map((incident) => ({ ...toSummary(incident), incident }));
      const incidents = sortIncidents(filterIncidents(listed, asked), asked.sort).map((r) => r.incident);
      if (incidents.length === 0) return undefined;
      return {
        subject: { kind: "incidents", id: "list", name: "incidents" },
        rows: incidents.map((incident) => ({ incident, url: incidentUrl(origin, incident.id) })),
      };
    },
  }),
  defineExport({
    dataset: postmortemActions,
    params: incidentParams,
    // The rows of the written postmortem's table, the fix first. Nothing to
    // file until it's written, or with no fix and no items: a 404, as the
    // incident page offers no export then.
    load: async ({ id }, { origin }) => {
      const incident = await getIncident(id);
      const items = incident?.postmortem?.status === "ready" ? actionItems(incident) : [];
      if (!incident || !items.length) return undefined;
      const url = incidentUrl(origin, incident.id);
      return {
        subject: { kind: "incident", id: incident.id, name: incident.title },
        rows: items.map((item) => ({ item, incident: { id: incident.id, title: incident.title }, url })),
      };
    },
  }),
  defineExport({
    dataset: dependencyFindings,
    params: dependencyParams,
    // What the Watch page lists: no more than it shows, gone ones only
    // within the week.
    load: async ({ service }) => {
      const rows = shownFindings(listFindings(service, { gone: true }), Date.now());
      return rows.length > 0 ? { subject: { kind: "service", id: service, name: service }, rows } : undefined;
    },
  }),
  incidentExport(incidentRecord, (incident) => [incident]),
  incidentExport(evidenceLogs, logRows),
  incidentExport(evidenceSpans, spanRows),
  incidentExport(evidenceMetrics, metricRows),
  incidentExport(evidenceDb, dbRows),
  incidentExport(evidenceSource, sourceRows),
  incidentExport(investigationTrace, traceRows),
  incidentExport(fixPatch, (incident) => (incident.fix ? [incident.fix] : [])),
  incidentExport(askAnswers, answerRows),
]);
