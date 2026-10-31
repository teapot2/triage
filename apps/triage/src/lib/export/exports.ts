import { z } from "zod";
import { checkIdPattern, readChecks } from "@/lib/investigation/uptime/checks";
import { readHourly, readSamplesSince } from "@/lib/investigation/uptime/samples";
import { endpointHourly, endpointResults } from "./datasets/endpoint";
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
]);
