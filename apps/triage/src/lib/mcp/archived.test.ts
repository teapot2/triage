import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { archivedRefusal } from "../investigation/archive";
import { resolved } from "../investigation/postmortem/test-incidents";
import { closeDb } from "../db";

// The MCP tools on an archived incident, on a temp working directory so
// .data is ours. The store resolves its folder when it loads, so the
// server is imported after the chdir.
const cwd = process.cwd();
let dir: string;
const client = new Client({ name: "test", version: "0" });
const id = "inc_mcp_archived";

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "triage-mcp-archived-"));
  process.chdir(dir);
  const { saveIncident } = await import("../investigation/store");
  const { archiveIncident } = await import("../investigation/archive-store");
  await saveIncident({ ...resolved(), id });
  assert.ok((await archiveIncident(id, "2026-11-02T09:30:00.000Z")).ok);

  const { createTriageMcpServer } = await import("./server");
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createTriageMcpServer({ baseUrl: "http://localhost:3000" }).connect(serverSide);
  await client.connect(clientSide);
});
after(async () => {
  await client.close();
  process.chdir(cwd);
  closeDb();
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

async function call(name: string, args: Record<string, unknown>): Promise<CallToolResult & { body: string }> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const body = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
  return { ...result, body };
}

type Rows = { incidents: { id: string; archived_at?: string }[]; total: number };

describe("MCP on an archived incident", () => {
  it("leaves it out of list_incidents unless include_archived is set", async () => {
    const plain = (await call("list_incidents", { limit: 50 })).structuredContent as Rows;
    assert.ok(!plain.incidents.some((r) => r.id === id));

    const result = await call("list_incidents", { limit: 50, include_archived: true });
    const all = result.structuredContent as Rows;
    assert.equal(all.total, plain.total + 1);
    assert.equal(all.incidents.find((r) => r.id === id)?.archived_at, "2026-11-02T09:30:00.000Z");
    assert.match(result.body, new RegExp(`\`${id}\` \\(archived\\) \\|`));
    // The active ones carry no archived_at.
    assert.ok(all.incidents.filter((r) => r.id !== id).every((r) => r.archived_at === undefined));
  });

  it("still returns it from get_incident, saying it's archived and when", async () => {
    const result = await call("get_incident", { id });
    assert.ok(!result.isError);
    assert.match(result.body, /Archived 2026-11-02 09:30:00 UTC: read-only/);
    assert.match(result.body, /## Summary/);
    assert.equal((result.structuredContent as { archived_at?: string }).archived_at, "2026-11-02T09:30:00.000Z");
  });

  it("refuses ask_incident on it", async () => {
    const result = await call("ask_incident", { incident_id: id, question: "Why did it happen?" });
    assert.equal(result.isError, true);
    assert.equal(result.body, `Can't ask now: ${archivedRefusal}`);
  });
});
