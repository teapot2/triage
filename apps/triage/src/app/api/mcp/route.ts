import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { mcpAccessProblem } from "@/lib/mcp/access";
import { createTriageMcpServer } from "@/lib/mcp/server";

// Triage's MCP server over Streamable HTTP, for Muse Code and other coding
// agents (README: Use Triage from Muse Code). Stateless: each request gets
// its own server and transport. ask_incident runs its answer inside the
// request (up to 10 model steps, like the Ask route), so it gets the room.
export const maxDuration = 150;

async function handle(req: Request): Promise<Response> {
  const problem = mcpAccessProblem(req.headers);
  if (problem) {
    return Response.json({ jsonrpc: "2.0", error: { code: -32001, message: problem.error }, id: null }, { status: problem.status });
  }
  const baseUrl = (process.env.TRIAGE_URL || new URL(req.url).origin).replace(/\/+$/, "");
  const server = createTriageMcpServer({ baseUrl });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  return transport.handleRequest(req);
}

export { handle as DELETE, handle as GET, handle as POST };
