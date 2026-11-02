import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deployRecords, fetchRelease, gitLogArgs, harnessPaths, listSourceFiles, shopfrontDir } from "./live-source";
import type { LogRow } from "./otlp-files";

const at = (iso: string) => Date.parse(iso);
const warn = (time: string, body: string, attributes: LogRow["attributes"] = {}): LogRow => ({
  time: at(time),
  service: "shopfront",
  level: "warn",
  body,
  attributes,
});

const flagOn = warn("2026-11-01T12:00:00Z", "ops: FF_LIST_PRICES turned on", { "flag.name": "FF_LIST_PRICES" });
const deployed = warn("2026-11-01T12:05:00Z", "deploy: 9f3c2a1 feat(shopfront): return a formatted price from the product API", {
  "deploy.sha": "9f3c2a1",
  "deploy.message": "feat(shopfront): return a formatted price from the product API",
  "deploy.kind": "deploy",
  "deploy.branch": "shopfront-release/formatted-price",
});
const rolledBack = warn("2026-11-01T12:20:00Z", "deploy: rolled back 9f3c2a1", {
  "deploy.sha": "9f3c2a1",
  "deploy.kind": "rollback",
  "deploy.previous": "e50f949",
});

describe("deployRecords", () => {
  it("maps flag flips as before: a config record per ops warning, newest first", () => {
    const earlier = warn("2026-11-01T11:00:00Z", "ops: FF_LIVE_RATINGS turned off", { "flag.name": "FF_LIVE_RATINGS" });
    assert.deepEqual(deployRecords([earlier, flagOn]), [
      { service: "shopfront", sha: "config:FF_LIST_PRICES", deployedAt: "2026-11-01T12:00:00.000Z", kind: "config", message: "ops: FF_LIST_PRICES turned on" },
      { service: "shopfront", sha: "config:FF_LIVE_RATINGS", deployedAt: "2026-11-01T11:00:00.000Z", kind: "config", message: "ops: FF_LIVE_RATINGS turned off" },
    ]);
  });

  it("maps a deploy warning to a deploy record with its sha, message and branch", () => {
    assert.deepEqual(deployRecords([deployed]), [
      {
        service: "shopfront",
        sha: "9f3c2a1",
        deployedAt: "2026-11-01T12:05:00.000Z",
        kind: "deploy",
        message: "feat(shopfront): return a formatted price from the product API",
        branch: "shopfront-release/formatted-price",
      },
    ]);
  });

  it("maps a rollback warning to a rollback record naming the sha rolled back", () => {
    const [r] = deployRecords([rolledBack]);
    assert.deepEqual(r, {
      service: "shopfront",
      sha: "9f3c2a1",
      deployedAt: "2026-11-01T12:20:00.000Z",
      kind: "rollback",
      message: "deploy: rolled back 9f3c2a1",
    });
  });

  it("ignores other services, levels and bodies", () => {
    const noise: LogRow[] = [
      { ...flagOn, service: "postgres" },
      { ...flagOn, level: "info" },
      warn("2026-11-01T12:01:00Z", "fetched product", { "product.id": 3 }),
    ];
    assert.deepEqual(deployRecords(noise), []);
    assert.deepEqual(
      deployRecords([flagOn, ...noise, deployed, rolledBack]).map((r) => r.kind),
      ["rollback", "deploy", "config"],
    );
  });
});

describe("fetchRelease", () => {
  const ok = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

  it("returns the deployed release", async () => {
    const release = { name: "formatted-price", sha: "9f3c2a1", branch: "shopfront-release/formatted-price", message: "feat", deployedAt: "2026-11-01T12:05:00Z", previous: "e50f949" };
    assert.deepEqual(await fetchRelease(ok({ flags: [], release }), "http://ops.test/api/ops"), release);
  });

  it("is undefined with no release, an older ops API, a 404, or no answer", async () => {
    assert.equal(await fetchRelease(ok({ flags: [], release: null })), undefined);
    assert.equal(await fetchRelease(ok({ flags: [] })), undefined);
    assert.equal(await fetchRelease((async () => new Response("", { status: 404 })) as unknown as typeof fetch), undefined);
    assert.equal(await fetchRelease((async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch), undefined);
  });
});

describe("gitLogArgs", () => {
  // The command before releases existed: HEAD's log with the harness left out.
  const before = (file: string | undefined, limit: number) => [
    "-C",
    shopfrontDir,
    "log",
    `-n${limit}`,
    "--name-only",
    "--format=%x1e%h%x1f%an%x1f%s%x1f%cI",
    "--relative",
    "--",
    file ?? ".",
    ...harnessPaths.map((h) => `:(exclude)${h}`),
  ];

  it("runs the same command as before when no release is deployed", () => {
    assert.deepEqual(gitLogArgs({ limit: 10 }), before(undefined, 10));
    assert.deepEqual(gitLogArgs({ limit: 5, path: "src/lib/prices.ts" }), before("src/lib/prices.ts", 5));
    assert.deepEqual(gitLogArgs({ limit: 5, from: undefined }), before(undefined, 5));
  });

  it("logs from the release's sha when one is deployed", () => {
    const args = gitLogArgs({ limit: 10, from: "9f3c2a1" });
    assert.deepEqual(args.slice(0, 7), before(undefined, 10).slice(0, 7));
    assert.deepEqual(args.slice(7), ["9f3c2a1", ...before(undefined, 10).slice(7)]);
  });

  it("excludes the release harness", () => {
    for (const h of ["src/lib/releases.ts", "releases/", "scripts/release.ts"]) {
      assert.ok(harnessPaths.includes(h), `${h} is not a harness path`);
      assert.ok(gitLogArgs({ limit: 1 }).includes(`:(exclude)${h}`));
    }
  });
});

describe("listSourceFiles", () => {
  it("never lists the release harness", async () => {
    const files = await listSourceFiles();
    const shown = files.filter((f) => f === "src/lib/releases.ts" || f === "scripts/release.ts" || f.startsWith("releases/"));
    assert.deepEqual(shown, []);
  });
});
