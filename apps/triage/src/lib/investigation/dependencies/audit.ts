import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { type AdvisorySeverity, type Finding, findingSchema, noCounts, type PackageManager, type SeverityCounts, severities } from "./model";

// Runs the watched service's own package manager's audit and reads what it
// finds about that service. The lockfile beside the nearest workspace root
// picks the manager (pnpm-lock.yaml, then package-lock.json); in a workspace
// only the service's importer counts (pnpm's paths start with it,
// "apps__shopfront>…"), so the other apps' findings never show up. Whether a
// finding is runtime or dev comes from the service's package.json: the head
// of each chain is one of its own dependencies or devDependencies.

const TIMEOUT_MS = 60_000;
const OUTPUT_LIMIT = 1024 * 1024;
// Chains kept per finding, shortest first: enough to show what pulls it in.
const MAX_PATHS = 20;

export type AuditTarget = {
  service: string;
  // The service's checkout.
  dir: string;
};

export type AuditResult = {
  packageManager: PackageManager;
  findings: Finding[];
  counts: SeverityCounts;
  // The audit's JSON as the package manager wrote it, kept on the latest
  // audit only.
  raw: string;
};

type Manifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

const exists = (file: string) => access(file).then(
  () => true,
  () => false,
);

// The directory holding the lockfile, walking up from the service, and the
// package manager it belongs to.
export async function findLockfile(dir: string): Promise<{ root: string; packageManager: PackageManager } | undefined> {
  for (let d = path.resolve(/* turbopackIgnore: true */ dir); ; d = path.dirname(d)) {
    if (await exists(path.join(/* turbopackIgnore: true */ d, "pnpm-lock.yaml"))) return { root: d, packageManager: "pnpm" };
    if (await exists(path.join(/* turbopackIgnore: true */ d, "package-lock.json"))) return { root: d, packageManager: "npm" };
    if (path.dirname(d) === d) return undefined;
  }
}

// pnpm's name for an importer in its paths: the path from the workspace
// root with each separator as "__"; the root itself is ".".
export function importerOf(root: string, dir: string): string {
  const rel = path.relative(root, dir).split(path.sep).filter(Boolean);
  return rel.length ? rel.join("__") : ".";
}

// The audit's environment: the registry settings (npm_config_*, NPM_TOKEN)
// stay, Triage's own secrets don't.
export function auditEnv(env: Record<string, string | undefined> = process.env): NodeJS.ProcessEnv {
  const secret = /(API_KEY|SECRET|PASSWORD|TOKEN|DATABASE_URL|SLACK|WEBHOOK)/i;
  const registry = /^(npm_config_|NPM_TOKEN$|NODE_AUTH_TOKEN$)/i;
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) if (!secret.test(k) || registry.test(k)) out[k] = v;
  return { ...out, FORCE_COLOR: "0", NO_COLOR: "1", CI: "1" } as unknown as NodeJS.ProcessEnv;
}

// From the environment, read at run time: Next's bundler folds
// process.platform and os.platform() into constants in the server build, so
// the Windows branches below would never run under it.
const windows = () => process.env.OS === "Windows_NT";

// `pnpm audit --json` / `npm audit --json` in `cwd`. Both exit non-zero when
// they find something, so the exit code says nothing; the JSON does.
export function runPackageManager(
  packageManager: PackageManager,
  args: string[],
  cwd: string,
  timeoutMs = TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  return new Promise((resolve) => {
    // On Windows pnpm and npm are .cmd shims, which only a shell can start.
    // The arguments are fixed by the caller, never a person's input, and go
    // as one command line (Node warns about separate args with a shell).
    const options = { cwd, env: auditEnv(), windowsHide: true };
    const child =
      windows()
        ? spawn([packageManager, ...args].join(" "), { ...options, shell: true })
        : spawn(packageManager, args, options);
    let stdout = "";
    let stderr = "";
    let size = 0;
    const take = (chunk: Buffer, to: "out" | "err") => {
      size += chunk.length;
      if (size > OUTPUT_LIMIT) return;
      if (to === "out") stdout += chunk.toString();
      else stderr += chunk.toString();
    };
    child.stdout.on("data", (c: Buffer) => take(c, "out"));
    child.stderr.on("data", (c: Buffer) => take(c, "err"));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (windows() && child.pid) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      else child.kill("SIGKILL");
    }, timeoutMs);
    const finish = (exitCode: number) => {
      clearTimeout(timer);
      if (size > OUTPUT_LIMIT) stderr += `\nOutput over ${OUTPUT_LIMIT / 1024} KB; the rest was dropped.`;
      resolve({ stdout, stderr, exitCode, timedOut });
    };
    child.on("error", (err) => {
      stderr += String(err);
      finish(127);
    });
    child.on("close", (code) => finish(code ?? 1));
  });
}

// Audits the service: throws, with what went wrong in a line, when the
// audit couldn't run or its output isn't an audit (offline, a registry
// error, no lockfile).
export async function runAudit(target: AuditTarget): Promise<AuditResult> {
  const lock = await findLockfile(target.dir);
  if (!lock) throw new Error(`No pnpm-lock.yaml or package-lock.json in ${target.dir} or above it.`);
  const manifest = JSON.parse(await readFile(path.join(/* turbopackIgnore: true */ target.dir, "package.json"), "utf8")) as Manifest;
  const run = await runPackageManager(lock.packageManager, ["audit", "--json"], lock.root);
  if (run.timedOut) throw new Error(`${lock.packageManager} audit took longer than ${TIMEOUT_MS / 1000} s.`);
  const json = parseJson(run.stdout);
  if (json === undefined) {
    const why = (run.stderr || run.stdout).trim().split("\n").find(Boolean) ?? `exit code ${run.exitCode}`;
    throw new Error(`${lock.packageManager} audit failed: ${why}`);
  }
  const lockfile =
    lock.packageManager === "npm"
      ? ((await readFile(path.join(/* turbopackIgnore: true */ lock.root, "package-lock.json"), "utf8").then(JSON.parse).catch(() => undefined)) as NpmLock | undefined)
      : undefined;
  const findings = parseAudit(json, {
    service: target.service,
    importer: importerOf(lock.root, target.dir),
    manifest,
    lockfile,
  });
  return { packageManager: lock.packageManager, findings, counts: countBySeverity(findings), raw: run.stdout };
}

function parseJson(text: string): unknown {
  // pnpm can print a warning line before the JSON.
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return undefined;
  }
}

export function countBySeverity(findings: Pick<Finding, "severity">[]): SeverityCounts {
  const counts = noCounts();
  for (const f of findings) counts[f.severity]++;
  return counts;
}

type ParseContext = {
  service: string;
  importer: string;
  manifest: Manifest;
  lockfile?: NpmLock;
};

// The service's findings from an audit's JSON: pnpm's (and npm 6's)
// `advisories`, or npm 7+'s `vulnerabilities`. An error the package manager
// reported as JSON throws.
export function parseAudit(json: unknown, ctx: ParseContext): Finding[] {
  const o = (json ?? {}) as Record<string, unknown>;
  if (o.error) {
    const e = o.error as { message?: string; summary?: string; code?: string };
    throw new Error(`audit failed: ${e.message ?? e.summary ?? e.code ?? JSON.stringify(o.error).slice(0, 200)}`);
  }
  if (o.advisories && typeof o.advisories === "object") return fromAdvisories(o.advisories as Record<string, PnpmAdvisory>, ctx);
  if (o.vulnerabilities && typeof o.vulnerabilities === "object") return fromNpm(o.vulnerabilities as Record<string, NpmVulnerability>, ctx);
  throw new Error("audit output has neither advisories nor vulnerabilities");
}

type PnpmAdvisory = {
  id: number;
  title?: string;
  module_name: string;
  vulnerable_versions?: string;
  patched_versions?: string | null;
  severity: string;
  cwe?: string | string[];
  github_advisory_id?: string;
  url?: string;
  findings?: { version: string; paths: string[] }[];
};

const runtimeSections = ["dependencies", "optionalDependencies", "peerDependencies"] as const;

// Whether the service's own dependency `name` only ships in development. One
// it doesn't list (a chain the package manager shortened) counts as runtime:
// the cautious reading.
function isDevHead(name: string, manifest: Manifest): boolean {
  if (runtimeSections.some((s) => manifest[s]?.[name] !== undefined)) return false;
  return manifest.devDependencies?.[name] !== undefined;
}

const toSeverity = (s: string): AdvisorySeverity => ((severities as readonly string[]).includes(s) ? (s as AdvisorySeverity) : "moderate");

// "<0.0.0" is how the registry says nothing is patched.
const patchedRange = (p: string | null | undefined) => (p && p !== "<0.0.0" ? p : undefined);

const cwes = (c: string | string[] | undefined) => (Array.isArray(c) ? c : c ? [c] : []);

// Chains are written "a>b>c"; the head is the service's own dependency.
const headOf = (chain: string) => chain.split(">")[0];

function finding(
  base: Omit<Finding, "dev" | "direct" | "paths" | "versions">,
  versions: string[],
  chains: string[],
  manifest: Manifest,
): Finding {
  // Runtime chains first, then shortest: when they're capped, the chain that
  // makes a finding runtime is never the one cut.
  const dev = (c: string) => (isDevHead(headOf(c), manifest) ? 1 : 0);
  const unique = [...new Set(chains)].sort(
    (a, b) => dev(a) - dev(b) || a.split(">").length - b.split(">").length || a.localeCompare(b),
  );
  const direct = [...new Set(unique.map(headOf))];
  return findingSchema.parse({
    ...base,
    versions: [...new Set(versions)].sort(),
    dev: direct.length > 0 && direct.every((d) => isDevHead(d, manifest)),
    direct,
    paths: unique.slice(0, MAX_PATHS),
  });
}

function fromAdvisories(advisories: Record<string, PnpmAdvisory>, ctx: ParseContext): Finding[] {
  const prefix = `${ctx.importer}>`;
  const byId = new Map<string, { a: PnpmAdvisory; versions: string[]; chains: string[] }>();
  for (const a of Object.values(advisories)) {
    const versions: string[] = [];
    const chains: string[] = [];
    for (const f of a.findings ?? []) {
      const ours = f.paths.filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length));
      if (!ours.length) continue;
      versions.push(f.version);
      chains.push(...ours);
    }
    if (!versions.length) continue;
    const id = a.github_advisory_id || `npm-${a.id}`;
    const seen = byId.get(id);
    if (seen) {
      seen.versions.push(...versions);
      seen.chains.push(...chains);
    } else byId.set(id, { a, versions, chains });
  }
  return [...byId].map(([advisoryId, { a, versions, chains }]) =>
    finding(
      {
        advisoryId,
        service: ctx.service,
        package: a.module_name,
        title: a.title ?? "",
        vulnerable: a.vulnerable_versions ?? "",
        patched: patchedRange(a.patched_versions),
        severity: toSeverity(a.severity),
        cwe: cwes(a.cwe),
        url: a.url ?? (a.github_advisory_id ? `https://github.com/advisories/${a.github_advisory_id}` : ""),
      },
      versions,
      chains,
      ctx.manifest,
    ),
  );
}

// npm 7+: one entry per vulnerable package, its advisories in `via` (an
// object per advisory, a string where it's only vulnerable through another
// package), the packages that depend on it in `effects`, and its copies in
// the tree in `nodes`, whose versions are in the lockfile.
type NpmVulnerability = {
  name: string;
  severity: string;
  isDirect?: boolean;
  via: (string | { source: number; name: string; title?: string; url?: string; severity: string; cwe?: string[]; range?: string })[];
  effects?: string[];
  nodes?: string[];
};
type NpmLock = { packages?: Record<string, { version?: string; dev?: boolean }> };

function fromNpm(vulnerabilities: Record<string, NpmVulnerability>, ctx: ParseContext): Finding[] {
  // Chains from each direct dependency down to `name`, following effects up.
  const chainsTo = (name: string, seen = new Set<string>()): string[] => {
    const v = vulnerabilities[name];
    if (!v || seen.has(name)) return [name];
    seen.add(name);
    const up = (v.effects ?? []).flatMap((e) => chainsTo(e, new Set(seen)).map((c) => `${c}>${name}`));
    const own = v.isDirect || ctx.manifest.dependencies?.[name] || ctx.manifest.devDependencies?.[name] ? [name] : [];
    return [...own, ...up].slice(0, MAX_PATHS * 2);
  };
  const out: Finding[] = [];
  for (const v of Object.values(vulnerabilities)) {
    for (const via of v.via) {
      if (typeof via === "string" || via.name !== v.name) continue;
      const versions = (v.nodes ?? []).map((n) => ctx.lockfile?.packages?.[n]?.version).filter((x): x is string => !!x);
      const advisoryId = /GHSA-[\w-]+/.exec(via.url ?? "")?.[0] ?? `npm-${via.source}`;
      out.push(
        finding(
          {
            advisoryId,
            service: ctx.service,
            package: v.name,
            title: via.title ?? "",
            vulnerable: via.range ?? "",
            patched: undefined,
            severity: toSeverity(via.severity),
            cwe: cwes(via.cwe),
            url: via.url ?? "",
          },
          versions.length ? versions : ["unknown"],
          chainsTo(v.name),
          ctx.manifest,
        ),
      );
    }
  }
  return out;
}
