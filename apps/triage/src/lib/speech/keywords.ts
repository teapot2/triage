import type { Incident } from "@/lib/investigation/schema";

// The words of an incident that voice input should hear right: its service,
// route and host names, given to Meta's transcription as `keywords` when a
// session opens. Meta biases recognition toward them ("shop front" comes out
// "shopfront") but drops their punctuation, so a raw "/api/products/[id]" or
// "portionary.app" is no use and can make things worse ("portionaryapp").
// Each name goes in as the words a person says for it: "products",
// "portionary". Pure, so it is tested without a socket.

// Meta documents no limit; a handful is what an incident has anyway.
export const MAX_KEYWORDS = 20;
const MAX_KEYWORD_CHARS = 50;

// Path segments that aren't names: "api", versions, parameters, IDs and a
// framework's own routes ("/_not-found").
const skipSegment = /^(?:api|v\d+|\[.*\]|:.*|\{.*\}|\*|\d+|_.*)$/i;
// "GET /api/products/[id]", a span's name.
const methodPrefix = /^(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)\s+/;
// The label a metric carries its route in: "…p95{route=/api/products/[id]}".
const routeLabel = /\broute=([^,}]+)/;

// "/api/checkout-session/[id]" → ["checkout session"].
function routeWords(route: string): string[] {
  return route
    .replace(methodPrefix, "")
    .split(/[?#]/)[0]
    .split("/")
    .filter((s) => s && !skipSegment.test(s))
    .map((s) => s.replace(/[-_.]+/g, " ").trim());
}

const ipAddress = /^(?:\d{1,3}\.){3}\d{1,3}$|:/;

// "www.portionary.app:443" → ["portionary"]: the site's own name, the label
// before the top-level domain, as a person says it. Nothing for an IP
// address or localhost.
function hostWords(host: string): string[] {
  const name = host.replace(/^\[.*\](?::\d+)?$/, "").replace(/:\d+$/, "").toLowerCase();
  if (!name || ipAddress.test(name) || name === "localhost") return [];
  const labels = name.split(".").filter(Boolean);
  const site = labels.length > 1 ? labels[labels.length - 2] : labels[0];
  return site ? [site.replace(/-+/g, " ")] : [];
}

function urlHost(value: string): string | undefined {
  try {
    return new URL(value).host;
  } catch {
    return undefined;
  }
}

// A service is usually a name ("shopfront"); an uptime check's incident is
// filed under the endpoint's host.
const serviceWords = (service: string) => (service.includes(".") ? hostWords(service) : [service.trim()]);

export function incidentKeywords(incident: Pick<Incident, "service" | "trigger" | "evidence">): string[] {
  const words: string[] = [...serviceWords(incident.service)];
  const routes = [incident.trigger.route, incident.trigger.focus?.route, incident.trigger.metric.match(routeLabel)?.[1]];
  for (const e of incident.evidence) {
    if (e.kind === "log") words.push(...serviceWords(e.service));
    if (e.kind === "span") {
      words.push(...serviceWords(e.service));
      routes.push(e.name);
      for (const key of ["server.address", "url.full"]) {
        const value = e.attributes[key];
        const host = typeof value === "string" ? (key === "url.full" ? urlHost(value) : value) : undefined;
        if (host) words.push(...hostWords(host));
      }
    }
    if (e.kind === "metric") routes.push(e.metric.match(routeLabel)?.[1]);
  }
  // Spans are named for what they did; only an HTTP one names a route.
  for (const route of routes) if (route && (route.startsWith("/") || methodPrefix.test(route))) words.push(...routeWords(route));

  const seen = new Set<string>();
  const out: string[] = [];
  for (const word of words) {
    const key = word.toLowerCase();
    if (!word || word.length > MAX_KEYWORD_CHARS || seen.has(key)) continue;
    seen.add(key);
    out.push(word);
    if (out.length === MAX_KEYWORDS) break;
  }
  return out;
}
