import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { shopfrontDir } from "../live/live-source";
import { exportTreeAt, hasCommit, listFilesAt, readFileAt, releaseShaOf, repoOf, sourceFilesAt } from "./release-tree";

// Against this repository: the formatted-price release, a commit on
// shopfront-release/formatted-price whose tree adds src/lib/money.ts and a
// formatPrice line to the product route. Skipped where git or the commit
// isn't to hand (a checkout without the release branch).
const RELEASE = "0dfdbac";
const available = hasCommit(shopfrontDir, RELEASE).catch(() => false);

describe("releaseShaOf", () => {
  it("is the rolled-back release's sha, and nothing for other mitigations", () => {
    const base = {
      title: "",
      why: { text: "", evidenceIds: [] as string[] },
      steps: [] as string[],
      undo: "",
      risk: "low" as const,
      state: "proposed" as const,
      proposedAt: "",
    };
    assert.equal(releaseShaOf({ mitigation: { ...base, kind: "rollback", target: RELEASE, branch: "shopfront-release/x" } }), RELEASE);
    assert.equal(releaseShaOf({ mitigation: { ...base, kind: "flag_off", target: "FF_X" } }), undefined);
    assert.equal(releaseShaOf({ mitigation: undefined }), undefined);
  });
});

describe("the tree at a commit", () => {
  it("knows where the app sits in its repository", async (t) => {
    if (!(await available)) return t.skip(`commit ${RELEASE} isn't in this checkout`);
    const { root, prefix } = await repoOf(shopfrontDir);
    assert.equal(prefix, "apps/shopfront/");
    assert.equal(path.resolve(root, "apps", "shopfront"), path.resolve(shopfrontDir));
  });

  it("lists and reads the release's files, which the live checkout no longer has", async (t) => {
    if (!(await available)) return t.skip(`commit ${RELEASE} isn't in this checkout`);
    const files = await listFilesAt(shopfrontDir, RELEASE);
    assert.ok(files.includes("src/lib/money.ts"));
    assert.ok(files.includes("src/app/api/products/[id]/route.ts"));
    assert.ok(files.every((f) => !f.startsWith("apps/")));

    const money = await readFileAt(shopfrontDir, RELEASE, "src/lib/money.ts");
    assert.match(money ?? "", /export function formatPrice\(/);
    assert.ok(!money!.includes("\r\n"), "as committed, not as the checkout would have it");
    const route = await readFileAt(shopfrontDir, RELEASE, "src/app/api/products/[id]/route.ts");
    assert.match(route!.trimEnd().split("\n").at(-2) ?? "", /formatPrice\(priceCents\)/);
    assert.equal(await readFileAt(shopfrontDir, RELEASE, "src/lib/not-there.ts"), undefined);
  });

  it("offers the fix stage the same files as the live source would, never the harness", async (t) => {
    if (!(await available)) return t.skip(`commit ${RELEASE} isn't in this checkout`);
    const files = await sourceFilesAt(shopfrontDir, RELEASE);
    assert.ok(files.includes("package.json"));
    assert.ok(files.includes("src/lib/money.ts"));
    assert.ok(files.some((f) => /^drizzle\/\d+_.*\.sql$/.test(f)));
    assert.ok(!files.includes("src/lib/ops.ts"));
    assert.ok(!files.some((f) => f.startsWith("src/app/ops/") || f.startsWith("src/app/api/ops/")));
    assert.ok(!files.some((f) => f.startsWith("public/") || f.startsWith("scripts/") || f.endsWith(".md")));
    assert.deepEqual(files, [...files].sort());
  });

  it("exports the tree as the sandbox needs it, keeping what the filter keeps", async (t) => {
    if (!(await available)) return t.skip(`commit ${RELEASE} isn't in this checkout`);
    const dir = await mkdtemp(path.join(os.tmpdir(), "triage-release-tree-"));
    try {
      const written = await exportTreeAt(shopfrontDir, RELEASE, dir, (rel) => !rel.startsWith("public/"));
      assert.ok(written.includes("src/lib/money.ts"));
      assert.ok(!written.some((f) => f.startsWith("public/")));
      assert.equal(await readFile(path.join(dir, "src", "lib", "money.ts"), "utf8"), await readFileAt(shopfrontDir, RELEASE, "src/lib/money.ts"));
      assert.ok(!(await readdir(dir)).includes("public"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
