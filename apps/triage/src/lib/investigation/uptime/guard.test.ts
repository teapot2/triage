import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { addressRefusal, checkUrl, type Lookup } from "./guard";

const resolvesTo =
  (...addresses: string[]): Lookup =>
  async () =>
    addresses.map((address) => ({ address }));
const noLookup: Lookup = async () => assert.fail("an IP literal needs no lookup");

describe("checkUrl", () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env.TRIAGE_UPTIME_ALLOW_PRIVATE = env.TRIAGE_UPTIME_ALLOW_PRIVATE;
    if (env.TRIAGE_UPTIME_ALLOW_PRIVATE === undefined) delete process.env.TRIAGE_UPTIME_ALLOW_PRIVATE;
  });

  for (const url of ["http://127.0.0.1", "http://10.0.0.1", "http://[::1]", "http://[::ffff:127.0.0.1]"]) {
    it(`refuses ${url}`, async () => {
      delete process.env.TRIAGE_UPTIME_ALLOW_PRIVATE;
      assert.ok(await checkUrl(url, { lookup: noLookup }));
    });
  }

  it("refuses other schemes and userinfo", async () => {
    assert.match((await checkUrl("ftp://example.com", { lookup: noLookup })) ?? "", /http and https/);
    assert.match((await checkUrl("https://user:pw@example.com", { lookup: noLookup })) ?? "", /user name or password/);
  });

  it("accepts a public name", async () => {
    assert.equal(await checkUrl("https://www.google.com", { lookup: resolvesTo("142.250.80.36", "2607:f8b0:4006:80f::2004") }), undefined);
  });

  it("refuses a name when any address it resolves to is private", async () => {
    const why = await checkUrl("https://intranet.example", { lookup: resolvesTo("93.184.216.34", "192.168.1.10") });
    assert.match(why ?? "", /^intranet\.example resolves to 192\.168\.1\.10, a private address/);
  });

  it("says so when the name doesn't resolve", async () => {
    const lookup: Lookup = async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    };
    assert.equal(await checkUrl("https://nope.invalid", { lookup }), "couldn't resolve nope.invalid (ENOTFOUND)");
  });

  it("lets loopback and private through with the override, but never link-local", async () => {
    process.env.TRIAGE_UPTIME_ALLOW_PRIVATE = "1";
    assert.equal(await checkUrl("http://localhost:3001/api/health", { lookup: resolvesTo("127.0.0.1", "::1") }), undefined);
    assert.equal(await checkUrl("http://10.0.0.1", { lookup: noLookup }), undefined);
    assert.ok(await checkUrl("http://169.254.169.254/latest/meta-data", { lookup: noLookup }));
    assert.ok(await checkUrl("http://[::ffff:127.0.0.1]", { lookup: noLookup }));
  });
});

describe("addressRefusal", () => {
  const refused = [
    "127.0.0.1",
    "127.1.2.3",
    "10.20.30.40",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "169.254.169.254",
    "224.0.0.1",
    "0.0.0.0",
    "255.255.255.255",
    "::",
    "::1",
    "fe80::1",
    "fe80::1%eth0",
    "fc00::1",
    "fd12:3456::1",
    "ff02::1",
    "::ffff:8.8.8.8",
    "::ffff:7f00:1",
    "64:ff9b::a00:1",
    "2002:c0a8:101::1",
  ];
  for (const ip of refused) it(`refuses ${ip}`, () => assert.ok(addressRefusal(ip)));

  for (const ip of ["8.8.8.8", "172.32.0.1", "93.184.216.34", "2606:4700:4700::1111", "64:ff9b::808:808"]) {
    it(`accepts ${ip}`, () => assert.equal(addressRefusal(ip), undefined));
  }

  it("names the kind of address", () => {
    assert.match(addressRefusal("10.0.0.1") ?? "", /^10\.0\.0\.1 is a private address/);
    assert.match(addressRefusal("fe80::1") ?? "", /link-local/);
    assert.match(addressRefusal("fd00::1") ?? "", /^fd00::1 is a unique-local address/);
  });

  it("lets local kinds through only when allowed", () => {
    assert.equal(addressRefusal("127.0.0.1", true), undefined);
    assert.equal(addressRefusal("fd00::1", true), undefined);
    assert.ok(addressRefusal("169.254.169.254", true));
    assert.ok(addressRefusal("224.0.0.1", true));
  });
});
