import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  checkIdPattern,
  checkSchema,
  checksSchema,
  defaultCheck,
  describeCheck,
  incidentTitle,
  newCheckId,
  parseRuleId,
  ruleDescription,
  ruleId,
  ruleSeverity,
} from "./model";

const google = defaultCheck({ id: "chk_abc123", name: "Google", url: "https://www.google.com" });

describe("uptime check model", () => {
  it("mints ids the schema accepts", () => {
    for (let i = 0; i < 20; i++) assert.match(newCheckId(), checkIdPattern);
  });

  it("accepts the defaults with a name and URL", () => {
    assert.deepEqual(checkSchema.parse(google), google);
    assert.equal(google.intervalSeconds, 30);
    assert.equal(google.timeoutMs, 15_000);
    assert.equal(google.slowMs, 10_000);
    assert.deepEqual(google.expectedStatus, { min: 200, max: 299 });
  });

  it("refuses other schemes, userinfo, and a slow limit past the timeout", () => {
    assert.equal(checkSchema.safeParse({ ...google, url: "ftp://example.com" }).success, false);
    assert.equal(checkSchema.safeParse({ ...google, url: "https://user:pw@example.com" }).success, false);
    assert.equal(checkSchema.safeParse({ ...google, slowMs: 20_000 }).success, false);
    assert.equal(checkSchema.safeParse({ ...google, expectedStatus: { min: 300, max: 200 } }).success, false);
  });

  it("caps the list at five and refuses duplicate ids", () => {
    const five = Array.from({ length: 5 }, (_, i) => ({ ...google, id: `chk_00000${i}` }));
    assert.equal(checksSchema.safeParse(five).success, true);
    assert.equal(checksSchema.safeParse([...five, { ...google, id: "chk_000009" }]).success, false);
    assert.equal(checksSchema.safeParse([google, google]).success, false);
  });

  it("words the rules and titles for Slack and the incident page", () => {
    assert.equal(ruleDescription(google, "slow"), "3 checks in a row slower than 10 s on https://www.google.com");
    assert.equal(ruleDescription(google, "down"), "no acceptable response for 5 min from https://www.google.com");
    assert.equal(incidentTitle(google, "slow"), "Slow responses from www.google.com");
    assert.equal(incidentTitle(google, "down"), "www.google.com is not responding");
    assert.equal(
      describeCheck(google),
      "Every 30 s, GET https://www.google.com and expect 200–299 within 10 s (gives up after 15 s)",
    );
  });

  it("takes the numbers from the check", () => {
    const local = { ...google, url: "http://localhost:3001/api/health", slowMs: 1500, slowChecksToOpen: 2, downMinutesToOpen: 1 };
    assert.equal(ruleDescription(local, "slow"), "2 checks in a row slower than 1.5 s on http://localhost:3001/api/health");
    assert.equal(ruleDescription(local, "down"), "no acceptable response for 1 min from http://localhost:3001/api/health");
    assert.equal(incidentTitle(local, "down"), "localhost:3001 is not responding");
  });

  it("keys rules by check and kind, down sev2 and slow sev3", () => {
    assert.equal(ruleId(google, "down"), "uptime:chk_abc123:down");
    assert.deepEqual(parseRuleId("uptime:chk_abc123:slow"), { checkId: "chk_abc123", rule: "slow" });
    assert.equal(parseRuleId("api-latency"), undefined);
    assert.equal(ruleSeverity("down"), "sev2");
    assert.equal(ruleSeverity("slow"), "sev3");
  });
});
