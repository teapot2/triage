import assert from "node:assert/strict";
import { access, lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { shopfrontDir } from "../live/live-source";
import { hasCommit } from "./release-tree";
import { createSandbox, removeSandbox } from "./sandbox";

// A sandbox built from a release commit rather than the live checkout: the
// formatted-price release (on shopfront-release/formatted-price) adds
// src/lib/money.ts, which the live Shopfront, with the release rolled back,
// doesn't have. Skipped where the commit isn't to hand.
const RELEASE = "0dfdbac";
const exists = (p: string) => access(p).then(() => true, () => false);

describe("createSandbox from a release commit", () => {
  it("holds the release's files, with the live app's dependencies and generated types", async (t) => {
    if (!(await hasCommit(shopfrontDir, RELEASE).catch(() => false))) return t.skip(`commit ${RELEASE} isn't in this checkout`);
    if (!(await exists(path.join(shopfrontDir, "node_modules")))) return t.skip("Shopfront's node_modules isn't installed");
    assert.ok(!(await exists(path.join(shopfrontDir, "src", "lib", "money.ts"))), "the release is rolled back on the live checkout");

    const dir = await createSandbox(shopfrontDir, "sandbox-test-release", { releaseSha: RELEASE });
    try {
      assert.match(await readFile(path.join(dir, "src", "lib", "money.ts"), "utf8"), /export function formatPrice\(/);
      assert.ok(await exists(path.join(dir, "package.json")));
      assert.ok(await exists(path.join(dir, "drizzle", "meta", "_journal.json")));
      // Never copied into a sandbox, from git or from disk.
      assert.ok(!(await exists(path.join(dir, "public"))));
      assert.ok(!(await exists(path.join(dir, ".env.example"))));
      // The live app's node_modules, linked entry by entry.
      assert.ok((await lstat(path.join(dir, "node_modules", "typescript"))).isSymbolicLink());
      if (await exists(path.join(shopfrontDir, ".next", "dev", "types"))) {
        assert.ok(await exists(path.join(dir, ".next", "dev", "types")));
      }
    } finally {
      await removeSandbox(dir);
    }
  });
});
