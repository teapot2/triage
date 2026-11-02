import { timingSafeEqual } from "node:crypto";

// Who may call the MCP server. With TRIAGE_MCP_TOKEN set (a hosted
// Triage), a bearer token that matches it. Without one, only this machine:
// the Host is a loopback name, and so is the Origin when a browser sends
// one, so a web page can't reach it by DNS rebinding.

const loopback = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function hostname(value: string): string | undefined {
  try {
    return new URL(value.includes("://") ? value : `http://${value}`).hostname;
  } catch {
    return undefined;
  }
}

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Why the request is refused, with its status, or undefined when it may call.
export function mcpAccessProblem(
  headers: Headers,
  token: string | undefined = process.env.TRIAGE_MCP_TOKEN,
): { status: 401 | 403; error: string } | undefined {
  if (token) {
    const given = headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    if (!given || !sameToken(given, token)) return { status: 401, error: "expected Authorization: Bearer <TRIAGE_MCP_TOKEN>" };
    return undefined;
  }
  const host = hostname(headers.get("host") ?? "");
  if (!host || !loopback.has(host)) {
    return { status: 403, error: "Triage's MCP server only answers on localhost unless TRIAGE_MCP_TOKEN is set" };
  }
  const origin = headers.get("origin");
  if (origin && !loopback.has(hostname(origin) ?? "")) return { status: 403, error: `origin not allowed: ${origin}` };
  return undefined;
}
