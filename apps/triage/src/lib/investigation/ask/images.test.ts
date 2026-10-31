import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { readQuestionImage, removeQuestionImages, saveQuestionImage } from "./images";

describe("question images", () => {
  const cwd = process.cwd();
  let dir: string;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "triage-images-"));
    process.chdir(dir);
  });
  after(async () => {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
  });

  const image = { mediaType: "image/webp", width: 2, height: 1, bytes: 4 };

  it("saves beside the incidents and reads back by question", async () => {
    await saveQuestionImage("inc_test_1", "q_2", new Uint8Array([1, 2, 3, 4]), "image/webp");
    assert.deepEqual(await readdir(path.join(dir, ".data", "question-images", "inc_test_1")), ["q_2.webp"]);
    const read = await readQuestionImage("inc_test_1", { id: "q_2", image });
    assert.equal(read?.mediaType, "image/webp");
    assert.deepEqual([...(read?.bytes ?? [])], [1, 2, 3, 4]);
  });

  it("reads nothing for a question without an image, or whose file is gone", async () => {
    assert.equal(await readQuestionImage("inc_test_1", { id: "q_1" }), undefined);
    assert.equal(await readQuestionImage("inc_test_1", { id: "q_9", image }), undefined);
  });

  it("refuses IDs that could leave the folder", async () => {
    await assert.rejects(saveQuestionImage("../inc_x", "q_1", new Uint8Array([1]), "image/png"), /invalid incident id/);
    await assert.rejects(saveQuestionImage("inc_x", "q_1/../../a", new Uint8Array([1]), "image/png"), /invalid question id/);
    await assert.rejects(saveQuestionImage("inc_x", "q_1", new Uint8Array([1]), "image/svg+xml"), /unsupported image type/);
  });

  it("removes every image on an incident", async () => {
    await removeQuestionImages("inc_test_1");
    assert.equal(await readQuestionImage("inc_test_1", { id: "q_2", image }), undefined);
    await removeQuestionImages("inc_test_1");
  });
});
