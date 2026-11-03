import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { auditEnv, countBySeverity, importerOf, parseAudit } from "./audit";
import { opensIncident } from "./model";

// The parser on a real `pnpm audit --json` from the repo root (Nov 2, paths
// trimmed): Shopfront's findings only, chains from its own dependencies,
// runtime or dev from its package.json.
const fixture = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures", "pnpm-audit.json"), "utf8"));
const manifest = JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "..", "..", "..", "..", "shopfront", "package.json"), "utf8"));
const shopfront = parseAudit(fixture, { service: "shopfront", importer: "apps__shopfront", manifest });
const byPackage = (name: string) => shopfront.find((f) => f.package === name)!;

describe("dependency audit parser", () => {
  it("keeps the service's importer only", () => {
    assert.deepEqual(shopfront.map((f) => f.package).sort(), ["esbuild", "glob", "minimatch"]);
    // linkify-it and deepmerge are Triage's own.
    assert.ok(!shopfront.some((f) => f.paths.some((p) => p.startsWith("apps__"))));
  });

  it("reads the advisory's fields", () => {
    const glob = byPackage("glob");
    assert.equal(glob.advisoryId, "GHSA-3g3m-2fjr-6pw4");
    assert.equal(glob.severity, "moderate");
    assert.deepEqual(glob.versions, ["10.5.0"]);
    assert.equal(glob.patched, ">=14.0.2");
    assert.deepEqual(glob.cwe, ["CWE-400"]);
    assert.equal(glob.url, "https://github.com/advisories/GHSA-3g3m-2fjr-6pw4");
    assert.deepEqual(glob.direct, ["@opentelemetry/auto-instrumentations-node"]);
  });

  it("tells runtime from dev by the service's own dependency at the head of each chain", () => {
    // drizzle-kit is a devDependency.
    assert.equal(byPackage("esbuild").dev, true);
    // Through auto-instrumentations-node, a runtime dependency.
    assert.equal(byPackage("glob").dev, false);
    // Through eslint-config-next (dev) and auto-instrumentations-node
    // (runtime): one runtime chain makes it runtime.
    const minimatch = byPackage("minimatch");
    assert.equal(minimatch.dev, false);
    assert.ok(minimatch.direct.includes("eslint-config-next"));
    assert.ok(minimatch.direct.includes("@opentelemetry/auto-instrumentations-node"));
    assert.deepEqual(minimatch.versions, ["10.2.6", "3.1.5", "9.0.9"]);
  });

  it("orders runtime chains first, then shortest", () => {
    const [first, ...rest] = byPackage("minimatch").paths;
    assert.ok(first.startsWith("@opentelemetry/auto-instrumentations-node>"));
    const lengths = rest.map((p) => p.split(">").length);
    assert.deepEqual(lengths, [...lengths].sort((a, b) => a - b));
  });

  it("finds Triage's own findings under its importer", () => {
    const triage = parseAudit(fixture, { service: "triage", importer: "apps__triage", manifest: { dependencies: { "ansi-to-react": "^6" } } });
    const linkify = triage.filter((f) => f.package === "linkify-it");
    assert.equal(linkify.length, 2);
    assert.ok(linkify.every((f) => f.severity === "high" && !f.dev));
    // deepmerge has no patched version published.
    assert.equal(triage.find((f) => f.package === "deepmerge")!.patched, undefined);
  });

  it("opens incidents for runtime findings at or over the floor only", () => {
    assert.ok(!shopfront.some((f) => opensIncident(f, "high")));
    assert.deepEqual(
      shopfront.filter((f) => opensIncident(f, "moderate")).map((f) => f.package).sort(),
      ["glob", "minimatch"],
    );
    assert.equal(opensIncident({ dev: true, severity: "critical" }, "high"), false);
    assert.equal(opensIncident({ dev: false, severity: "critical" }, "critical"), true);
  });

  it("counts by severity", () => {
    assert.deepEqual(countBySeverity(shopfront), { info: 0, low: 0, moderate: 3, high: 0, critical: 0 });
  });

  it("throws on an error the package manager reported", () => {
    assert.throws(
      () => parseAudit({ error: { code: "ERR_PNPM_AUDIT_BAD_RESPONSE", message: "getaddrinfo ENOTFOUND registry.npmjs.org" } }, {
        service: "shopfront",
        importer: "apps__shopfront",
        manifest,
      }),
      /ENOTFOUND/,
    );
    assert.throws(() => parseAudit({ nothing: true }, { service: "x", importer: ".", manifest: {} }), /neither/);
  });

  it("reads npm 7+'s vulnerabilities", () => {
    const npm = {
      vulnerabilities: {
        semver: {
          name: "semver",
          severity: "high",
          isDirect: true,
          via: [
            {
              source: 1101088,
              name: "semver",
              title: "semver vulnerable to Regular Expression Denial of Service",
              url: "https://github.com/advisories/GHSA-c2qf-rxjj-qqgw",
              severity: "high",
              cwe: ["CWE-1333"],
              range: ">=7.0.0 <7.5.2",
            },
          ],
          effects: [],
          nodes: ["node_modules/semver"],
        },
      },
    };
    const [f] = parseAudit(npm, {
      service: "app",
      importer: ".",
      manifest: { dependencies: { semver: "7.5.1" } },
      lockfile: { packages: { "node_modules/semver": { version: "7.5.1" } } },
    });
    assert.equal(f.advisoryId, "GHSA-c2qf-rxjj-qqgw");
    assert.deepEqual(f.versions, ["7.5.1"]);
    assert.deepEqual(f.direct, ["semver"]);
    assert.equal(f.dev, false);
  });

  it("names pnpm importers the way its paths do", () => {
    assert.equal(importerOf(path.resolve("/repo"), path.resolve("/repo/apps/shopfront")), "apps__shopfront");
    assert.equal(importerOf(path.resolve("/repo"), path.resolve("/repo")), ".");
  });

  it("keeps registry settings and drops Triage's secrets from the audit's environment", () => {
    const env = auditEnv({
      PATH: "/bin",
      META_API_KEY: "k",
      SLACK_BOT_TOKEN: "t",
      SHOPFRONT_DATABASE_URL: "postgres://",
      npm_config_registry: "https://registry.npmjs.org/",
      NPM_TOKEN: "n",
    });
    assert.equal(env.PATH, "/bin");
    assert.equal(env.npm_config_registry, "https://registry.npmjs.org/");
    assert.equal(env.NPM_TOKEN, "n");
    assert.equal(env.META_API_KEY, undefined);
    assert.equal(env.SLACK_BOT_TOKEN, undefined);
    assert.equal(env.SHOPFRONT_DATABASE_URL, undefined);
  });
});
