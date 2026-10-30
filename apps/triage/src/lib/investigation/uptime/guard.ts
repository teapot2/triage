import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { urlProblem } from "./model";

// Keeps uptime checks pointed at the public internet: Triage makes these
// requests from its own server, so a check on 10.0.0.5 or 169.254.169.254
// would let anyone who can save a check reach what only the server can.
// Run before every request and every redirect hop. Best-effort: fetch
// resolves the name again when it connects, so a DNS answer that changes
// in between isn't caught.

export type Lookup = (host: string) => Promise<{ address: string }[]>;

const systemLookup: Lookup = (host) => dnsLookup(host, { all: true });

// Loopback and private targets, for the local demo on Shopfront; never in
// production.
export const privateAllowed = () =>
  process.env.TRIAGE_UPTIME_ALLOW_PRIVATE === "1" && process.env.NODE_ENV !== "production";

type Kind = "loopback" | "private" | "link-local" | "unique-local" | "multicast" | "unspecified" | "reserved";

// The kinds a local target may be when privateAllowed(). Link-local stays
// refused: it's where cloud metadata services answer.
const localKinds = new Set<Kind>(["loopback", "private", "unique-local"]);

const ipv4Ranges: [string, number, Kind][] = [
  ["0.0.0.0", 8, "unspecified"],
  ["10.0.0.0", 8, "private"],
  ["100.64.0.0", 10, "private"], // carrier-grade NAT
  ["127.0.0.0", 8, "loopback"],
  ["169.254.0.0", 16, "link-local"],
  ["172.16.0.0", 12, "private"],
  ["192.0.0.0", 24, "reserved"],
  ["192.168.0.0", 16, "private"],
  ["198.18.0.0", 15, "reserved"], // benchmarking
  ["224.0.0.0", 4, "multicast"],
  ["240.0.0.0", 4, "reserved"], // and broadcast
];

const v4ToInt = (ip: string) => ip.split(".").reduce((n, part) => n * 256 + Number(part), 0);

function ipv4Kind(ip: string): Kind | undefined {
  const n = v4ToInt(ip);
  for (const [base, bits, kind] of ipv4Ranges) {
    const size = 2 ** (32 - bits);
    if (Math.floor(n / size) === Math.floor(v4ToInt(base) / size)) return kind;
  }
  return undefined;
}

// An IPv6 address as eight 16-bit groups, with "::" filled in and a dotted
// IPv4 tail split in two.
function ipv6Groups(ip: string): number[] {
  const bare = ip.replace(/%.*$/, "");
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(bare);
  let text = bare;
  if (tail) {
    const n = v4ToInt(tail[1]);
    text = `${bare.slice(0, -tail[1].length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, rest] = text.split("::");
  const parse = (s: string) => (s ? s.split(":").map((g) => parseInt(g, 16)) : []);
  const [h, r] = [parse(head), parse(rest ?? "")];
  return rest === undefined ? h : [...h, ...Array(8 - h.length - r.length).fill(0), ...r];
}

const v4From = (hi: number, lo: number) => [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");

// What an IPv6 address is, or, for one that only carries an IPv4 address
// (NAT64, 6to4), what that one is. Mapped and compatible forms are refused
// outright: nothing public needs them, and they're a way to dress up 127.0.0.1.
function ipv6Kind(ip: string): Kind | "mapped" | undefined {
  const g = ipv6Groups(ip);
  const zeros = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zeros(0, 8)) return "unspecified";
  if (zeros(0, 7) && g[7] === 1) return "loopback";
  if (zeros(0, 5) && g[5] === 0xffff) return "mapped";
  if (zeros(0, 6)) return "mapped"; // IPv4-compatible, deprecated
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return ipv4Kind(v4From(g[6], g[7]));
  if (g[0] === 0x2002) return ipv4Kind(v4From(g[1], g[2]));
  if ((g[0] & 0xffc0) === 0xfe80) return "link-local";
  if ((g[0] & 0xfe00) === 0xfc00) return "unique-local";
  if ((g[0] & 0xff00) === 0xff00) return "multicast";
  return undefined;
}

// "a unique-local", "an unspecified".
const article = (kind: Kind) => (kind === "unspecified" ? "an" : "a");

// What's wrong with an address ("a loopback address"), or undefined.
function refusedAs(ip: string, allowLocal: boolean): string | undefined {
  const family = isIP(ip.replace(/%.*$/, ""));
  if (family === 0) return "not an IP address";
  const kind = family === 4 ? ipv4Kind(ip) : ipv6Kind(ip);
  if (!kind) return undefined;
  if (kind === "mapped") return "an IPv4-mapped IPv6 address";
  if (allowLocal && localKinds.has(kind)) return undefined;
  const hint =
    localKinds.has(kind) && process.env.NODE_ENV !== "production"
      ? "; set TRIAGE_UPTIME_ALLOW_PRIVATE=1 to check local targets in development"
      : "";
  return `${article(kind)} ${kind} address${hint}`;
}

// Why an address can't be checked, or undefined when it can. Pure: the
// caller says whether local targets are allowed.
export function addressRefusal(ip: string, allowLocal = false): string | undefined {
  const why = refusedAs(ip, allowLocal);
  return why && `${ip} is ${why}`;
}

// Why a URL can't be checked, or undefined when it can: its scheme or
// userinfo, an IP literal in a refused range, or a name that resolves to
// one (any of its addresses), or doesn't resolve at all.
export async function checkUrl(url: string, opts: { lookup?: Lookup } = {}): Promise<string | undefined> {
  const problem = urlProblem(url);
  if (problem) return problem;
  const allowLocal = privateAllowed();
  const host = new URL(url).hostname.replace(/^\[(.*)\]$/, "$1");
  if (isIP(host)) return addressRefusal(host, allowLocal);

  let addresses: { address: string }[];
  try {
    addresses = await (opts.lookup ?? systemLookup)(host);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return `couldn't resolve ${host}${code ? ` (${code})` : ""}`;
  }
  if (addresses.length === 0) return `couldn't resolve ${host}`;
  for (const { address } of addresses) {
    const why = refusedAs(address, allowLocal);
    if (why) return `${host} resolves to ${address}, ${why}`;
  }
  return undefined;
}
