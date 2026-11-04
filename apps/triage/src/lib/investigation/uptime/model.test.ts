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
  publicCheck,
  ruleDescription,
  ruleId,
  ruleSeverity,
  runStatus,
  slowLimitProblem,
  slowLimitRefusal,
  withSavedSecrets,
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

  it("wants a new or changed slow limit under the timeout, and still loads one saved equal", () => {
    const equal = { ...google, slowMs: 15_000 };
    // A saved check with the two equal still reads.
    assert.equal(checkSchema.safeParse(equal).success, true);
    assert.equal(slowLimitProblem(google), undefined);
    assert.equal(slowLimitProblem(equal), "the slow limit (15 s) must be under the timeout (15 s), or Slow never trips");
    assert.equal(slowLimitRefusal([equal], []), "Google: the slow limit (15 s) must be under the timeout (15 s), or Slow never trips");
    assert.equal(slowLimitRefusal([equal], [google]), slowLimitRefusal([equal], []));
    // Left as it was saved, it doesn't stop a save of the list.
    const other = { ...google, id: "chk_def456", name: "Other" };
    assert.equal(slowLimitRefusal([equal, other], [equal]), undefined);
    assert.equal(slowLimitRefusal([{ ...equal, slowMs: 20_000, timeoutMs: 20_000 }], [equal]), "Google: the slow limit (20 s) must be under the timeout (20 s), or Slow never trips");
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

  it("carries an auth header whose value stays on the server", () => {
    const secured = { ...google, auth: { header: "Authorization", value: "Bearer t0k3n" } };
    assert.deepEqual(checkSchema.parse(secured), secured);
    assert.equal(checkSchema.safeParse({ ...google, auth: { header: "Bad Name", value: "x" } }).success, false);
    assert.equal(checkSchema.safeParse({ ...google, auth: { header: "X-Api-Key", value: "a\r\nb" } }).success, false);
    assert.deepEqual(publicCheck(secured), { ...google, auth: { header: "Authorization" } });
    assert.equal(publicCheck(google), google);
    assert.equal(
      describeCheck(secured),
      "Every 30 s, GET https://www.google.com with an Authorization header and expect 200–299 within 10 s (gives up after 15 s)",
    );
  });

  it("puts the saved value back on a check that came without one, on the same origin only", () => {
    const secured = { ...google, auth: { header: "Authorization", value: "Bearer t0k3n" } };
    const back = publicCheck(secured);
    assert.deepEqual(withSavedSecrets([back], [secured]), { checks: [secured] });
    assert.deepEqual(withSavedSecrets([{ ...back, auth: { header: "X-Api-Key" } }], [secured]).checks?.[0].auth, {
      header: "X-Api-Key",
      value: "Bearer t0k3n",
    });
    assert.equal(withSavedSecrets([{ ...back, url: "https://www.google.com/health" }], [secured]).checks?.[0].auth?.value, "Bearer t0k3n");
    assert.equal(
      withSavedSecrets([{ ...back, url: "https://example.com/" }], [secured]).problem,
      "Google: the Authorization value saved was for www.google.com; enter the one for example.com",
    );
    assert.equal(withSavedSecrets([back], []).problem, "Google: enter the Authorization header's value");
    assert.equal(withSavedSecrets([{ ...secured, auth: { header: "Authorization", value: "new" } }], [secured]).checks?.[0].auth?.value, "new");
    assert.deepEqual(withSavedSecrets([google], [secured]), { checks: [google] });
  });

  it("titles a Down run the endpoint answered with 401 as rejected credentials", () => {
    const s = (status?: number) => ({ at: "2026-10-30T12:00:00.000Z", ms: 20, ...(status && { status }), outcome: "down" as const });
    assert.equal(runStatus([s(401), s(401)]), 401);
    assert.equal(runStatus([s(401), s(503)]), undefined);
    assert.equal(runStatus([s(401), s()]), undefined);
    assert.equal(runStatus([]), undefined);
    assert.equal(incidentTitle(google, "down", 401), "www.google.com is rejecting the check's credentials");
    assert.equal(incidentTitle(google, "down", 403), "www.google.com is rejecting the check's credentials");
    assert.equal(incidentTitle(google, "slow", 401), "Slow responses from www.google.com");
  });

  it("names the status a Down run answered with every time, and only then", () => {
    // Shopfront's /api/health answers 503 when its database probe fails.
    const local = { ...google, url: "http://localhost:3001/api/health" };
    assert.equal(incidentTitle(local, "down", 503), "localhost:3001 is returning HTTP 503");
    assert.equal(incidentTitle(google, "down", 302), "www.google.com is returning HTTP 302");
    // Timeouts, connection failures and mixed runs have no one status.
    assert.equal(incidentTitle(local, "down", undefined), "localhost:3001 is not responding");
    // A status the check expects can't be why it's down.
    assert.equal(incidentTitle(google, "down", 200), "www.google.com is not responding");
    assert.equal(incidentTitle({ ...google, expectedStatus: { min: 200, max: 503 } }, "down", 503), "www.google.com is not responding");
  });

  it("keys rules by check and kind, down sev2 and slow sev3", () => {
    assert.equal(ruleId(google, "down"), "uptime:chk_abc123:down");
    assert.deepEqual(parseRuleId("uptime:chk_abc123:slow"), { checkId: "chk_abc123", rule: "slow" });
    assert.equal(parseRuleId("api-latency"), undefined);
    assert.equal(ruleSeverity("down"), "sev2");
    assert.equal(ruleSeverity("slow"), "sev3");
  });
});
