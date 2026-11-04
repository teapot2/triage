import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { incidentStatusSchema } from "../../lib/investigation/schema";
import { openStatuses } from "../../lib/investigation/summary";
import { statusGroupOf, statusGroups } from "./status-badges";

describe("statusGroups", () => {
  it("lists every status under exactly one heading", () => {
    const listed = statusGroups.flatMap((g) => g.statuses);
    assert.deepEqual([...listed].sort(), [...incidentStatusSchema.options].sort());
  });

  // The list's filter and the open count (sidebar, Services, MCP) agree.
  it("puts exactly the open statuses under Open, a failed run among them", () => {
    assert.deepEqual(statusGroups.find((g) => g.label === "Open")?.statuses, openStatuses);
    assert.equal(statusGroupOf.failed, "Open");
    assert.equal(statusGroupOf.resolved, "Done");
    assert.equal(statusGroupOf.healthy, "Done");
  });
});
