import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { exportFilename, slug } from "./filename";

const at = new Date("2026-10-30T02:15:59.999Z");

describe("exportFilename", () => {
  it("joins the dataset, the subject and the UTC minute", () => {
    assert.equal(exportFilename("endpoint-results", "Portionary", "csv", at), "endpoint-results_portionary_2026-10-30T0215Z.csv");
  });

  it("turns spaces and runs of punctuation into single dashes", () => {
    assert.equal(slug("  Shop front  API  "), "shop-front-api");
    assert.equal(slug("a -- b __ c"), "a-b-c");
  });

  it("drops accents", () => {
    assert.equal(slug("Café Ünïcode Señal"), "cafe-unicode-senal");
    assert.equal(slug("ﬁle ①"), "file-1");
  });

  it("leaves nothing Windows refuses", () => {
    const name = exportFilename("endpoint-hourly", 'CON<>:"/\\|?*. ', "json", at);
    assert.equal(name, "endpoint-hourly_con_2026-10-30T0215Z.json");
    assert.doesNotMatch(name, /[<>:"/\\|?*\x00-\x1f]/);
  });

  it("names an empty or symbol-only subject 'export'", () => {
    assert.equal(slug(""), "export");
    assert.equal(slug("日本語 🚀"), "export");
    assert.equal(exportFilename("endpoint-results", "", "csv", at), "endpoint-results_export_2026-10-30T0215Z.csv");
  });

  it("caps a slug at 40 characters without a trailing dash", () => {
    assert.equal(slug("a".repeat(100)), "a".repeat(40));
    assert.equal(slug(`${"a".repeat(39)} b`), "a".repeat(39));
  });
});
