import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mcpAccessProblem } from "./access";
import { createTriageMcpServer } from "./server";

// The server end to end through an in-memory client, on the bundled
// examples. ask_incident needs a model, so only its refusals are here.

const client = new Client({ name: "test", version: "0" });

before(async () => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createTriageMcpServer({ baseUrl: "http://localhost:3000" }).connect(serverSide);
  await client.connect(clientSide);
});
after(() => client.close());

async function call(name: string, args: Record<string, unknown>): Promise<CallToolResult & { body: string }> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const body = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
  return { ...result, body };
}

describe("Triage MCP server", () => {
  it("lists its six tools, all read-only but ask_incident", async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      "ask_incident",
      "get_evidence",
      "get_fix",
      "get_incident",
      "get_postmortem",
      "list_incidents",
    ]);
    for (const t of tools) assert.equal(t.annotations?.readOnlyHint, t.name !== "ask_incident", t.name);
    assert.match(client.getInstructions() ?? "", /\[ev_log_3\]/);
  });

  // Stored runs in .data come first, so the examples may be past the limit.
  it("lists runs, then the examples, and filters", async () => {
    const result = await call("list_incidents", { limit: 50 });
    const { incidents, total } = result.structuredContent as { incidents: { example: boolean }[]; total: number };
    assert.ok(total >= 3);
    assert.equal(incidents.length, Math.min(total, 50));
    const firstExample = incidents.findIndex((r) => r.example);
    if (firstExample >= 0) assert.ok(incidents.slice(firstExample).every((r) => r.example));
    assert.equal((await call("list_incidents", { service: "no-such-service" })).body, "No incidents match.");
  });

  it("summarizes inc_pool_leak with its evidence in one call", async () => {
    const result = await call("get_incident", { id: "inc_pool_leak" });
    assert.ok(!result.isError);
    assert.match(result.body, /Root cause: \*\*/);
    assert.match(result.body, /## Cited evidence\n\n- \[ev_/);
  });

  it("answers an unknown ID with recent ones to pick from", async () => {
    const result = await call("get_incident", { id: "inc_nope" });
    assert.equal(result.isError, true);
    assert.match(result.body, /Unknown incident: inc_nope\. Recent incidents: .*`inc_/);
  });

  it("returns evidence by ID and says which aren't there", async () => {
    const incident = await call("get_incident", { id: "inc_pool_leak" });
    const [id] = (incident.structuredContent as { cited_evidence_ids: string[] }).cited_evidence_ids;
    const result = await call("get_evidence", { incident_id: "inc_pool_leak", ids: [id, "ev_missing_1"] });
    assert.ok(result.body.startsWith(`### ${id} · `));
    assert.match(result.body, /Not on this incident: ev_missing_1\./);
  });

  it("returns the fix's patch", async () => {
    const result = await call("get_fix", { incident_id: "inc_pool_leak" });
    assert.match(result.body, /```diff\n/);
  });

  it("says when there's no postmortem", async () => {
    const result = await call("get_postmortem", { incident_id: "inc_control" });
    assert.match(result.body, /hasn't been written/);
  });

  it("refuses a question on an unknown incident", async () => {
    const result = await call("ask_incident", { incident_id: "inc_nope", question: "why?" });
    assert.equal(result.isError, true);
  });
});

describe("mcpAccessProblem", () => {
  const headers = (h: Record<string, string>) => new Headers(h);

  it("takes loopback hosts without a token", () => {
    assert.equal(mcpAccessProblem(headers({ host: "localhost:3000" }), undefined), undefined);
    assert.equal(mcpAccessProblem(headers({ host: "127.0.0.1:3000", origin: "http://localhost:3000" }), undefined), undefined);
  });

  it("refuses other hosts and origins without a token", () => {
    assert.equal(mcpAccessProblem(headers({ host: "triage.example.com" }), undefined)?.status, 403);
    assert.equal(mcpAccessProblem(headers({ host: "localhost:3000", origin: "https://evil.example" }), undefined)?.status, 403);
  });

  it("needs the bearer token when one is set", () => {
    const token = "s3cret";
    assert.equal(mcpAccessProblem(headers({ host: "triage.example.com" }), token)?.status, 401);
    assert.equal(mcpAccessProblem(headers({ host: "x", authorization: "Bearer nope" }), token)?.status, 401);
    assert.equal(mcpAccessProblem(headers({ host: "x", authorization: "Bearer s3cret" }), token), undefined);
  });
});
