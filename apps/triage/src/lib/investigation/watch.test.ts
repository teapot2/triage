import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { closeDb } from "../db";
import type { MessageKind } from "../notifications/types";
import type { Incident } from "./schema";
import { incidentBurn, type RuleResult } from "./watch-judge";
import { tripTitle, type WatchRule } from "./watch-rule-model";

// The rule watch's episodes over scripted verdicts and a fake clock,
// checked by hand, on a temp working directory so .data is ours. How a rule
// is judged is watch-judge's and slo/judge's (their own tests); here each
// rule's verdict at each check is set directly. The store resolves its
// folder when it loads, so everything that touches .data is imported after
// the chdir. Each test has its own rules (ids), so the incidents earlier
// tests left open don't count for its episodes.
const cwd = process.cwd();
let dir: string;
let watch: typeof import("./watch");
let store: typeof import("./store");

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "triage-watch-"));
  process.chdir(dir);
  watch = await import("./watch");
  store = await import("./store");
});
after(async () => {
  // Windows won't delete the temp directory while the database is open.
  closeDb();
  process.chdir(cwd);
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
let clock = Date.parse("2026-11-03T23:00:00.000Z");
let rules: WatchRule[] = [];
// Each rule's verdict at the next checks; ok unless set.
const verdicts = new Map<string, RuleResult>();
const sent: { kind: MessageKind; incidentId: string }[] = [];
let opened = 0;

const rule = (id: string, severity: WatchRule["severity"], o: Partial<WatchRule> = {}): WatchRule => ({
  id,
  name: id,
  enabled: true,
  target: { kind: "api" },
  condition: { metric: "p95", aboveMs: 500 },
  windowSeconds: 60,
  checksToOpen: 2,
  minRequests: 5,
  severity,
  ...o,
});

const slo = (id: string) =>
  rule(id, "sev2", { condition: { metric: "slo", objectivePercent: 99.9, windowDays: 30, latencyMs: 500 }, checksToOpen: 1, minRequests: 100 });

// Over its limit long enough to open; over it, not yet; within it.
const trips = (route = "/api/products/[id]"): RuleResult => ({ status: "breaching", checks: 2, trip: { route, method: "GET" }, summary: `over on ${route}` });
const over: RuleResult = { status: "breaching", checks: 1 };
const ok: RuleResult = { status: "ok" };
// An SLO's slow burn after an outage: firing, held, then tripping at sev4.
const slowBurn: RuleResult = {
  status: "breaching",
  summary: "burning 1.2× over 3 days",
  checks: 1,
  trip: { route: "/api/products/[id]", method: "GET", severity: "sev4", speed: "slow" },
};
// An SLO's 1 h alert firing at `rate`, at the rule's severity; `burning`,
// the minutes of its short window past the threshold, as the live judge
// works them out (unknown unless given).
const fastBurn = (rate: number, route = "/api/products/[id]", burning?: { from: number; to: number }): RuleResult => ({
  status: "breaching",
  summary: `burning ${rate}× over 1 h on ${route}`,
  checks: 1,
  trip: {
    route,
    method: "GET",
    speed: "fast",
    burn: { rate, threshold: 14.4, longMs: HOUR, shortMs: 5 * MINUTE, budgetLeftPercent: 60 },
    ...(burning && { burning }),
  },
});

// What the service says of an applied mitigation's state now (see
// mitigation/in-effect): still in place, undone, or unknown.
let holding: boolean | undefined = true;

function restart() {
  verdicts.clear();
  holding = true;
  watch.watchForTests.restart({
    now: () => clock,
    readRules: async () => rules,
    judge: async (list) => ({ requests: 120, results: list.map((r) => verdicts.get(r.id) ?? ok) }),
    notify: (kind, incident) => void sent.push({ kind, incidentId: incident.id }),
    investigationProblem: async () => undefined,
    mitigationInEffect: async (i) => (i.mitigation?.state === "applied" ? holding : false),
    createIncident: async (r, trip, relatedTo) => {
      const incident: Incident = {
        id: `inc_watch_${++opened}`,
        // As createRuleIncident words it.
        title: tripTitle(r, "GET", trip.route, trip.burn?.rate),
        service: "shopfront",
        severity: trip.severity ?? r.severity,
        status: "investigating",
        detectedAt: new Date(clock).toISOString(),
        openedBy: "watch",
        trigger: {
          metric: "m",
          unit: "ms",
          threshold: 500,
          observed: 900,
          series: [],
          rule: { id: r.id, name: r.name, description: r.name },
          route: trip.route,
          burn: incidentBurn(trip),
        },
        steps: [],
        evidence: [],
        ...(relatedTo && { relatedTo }),
      };
      await store.saveIncident(incident);
      return { incident, investigate: async () => {} };
    },
  });
}

// One check, CHECK_MS on; `times` of them.
async function check(times = 1) {
  for (let n = 0; n < times; n++) {
    clock += 10_000;
    await watch.watchForTests.check();
  }
}

const set = (o: Record<string, RuleResult>) => {
  for (const [id, r] of Object.entries(o)) verdicts.set(id, r);
};
const openedSince = (from: number) => sent.slice(from).filter((s) => s.kind === "incident_opened");
const ruleStatus = (id: string) => watch.watchState().rules.find((r) => r.id === id)?.status;
const episodeOf = (id: string) => watch.watchForTests.episodes().get(id)?.incidentId;

describe("rule watch episodes", () => {
  it("opens one incident when two rules trip in the same check, the most severe first", async () => {
    rules = [rule("lat-1", "sev3"), rule("err-1", "sev2")];
    restart();
    const from = sent.length;
    await check();
    set({ "lat-1": trips(), "err-1": trips() });
    await check();
    const news = openedSince(from);
    assert.equal(news.length, 1);
    const incident = (await store.getIncident(news[0].incidentId))!;
    // The sev2 rule opened it, though listed second; the other joined.
    assert.equal(incident.trigger.rule?.id, "err-1");
    assert.deepEqual(
      incident.joinedRules?.map((j) => j.id),
      ["lat-1"],
    );
    assert.equal(episodeOf("lat-1"), incident.id);
    const s = watch.watchState();
    assert.equal(s.status, "alerting");
    assert.equal(s.incidentId, incident.id);
    assert.deepEqual([ruleStatus("lat-1"), ruleStatus("err-1")], ["alerting", "alerting"]);

    // Both keep tripping: still the one incident.
    await check(5);
    assert.equal(openedSince(from).length, 1);
  });

  it("joins another rule tripping a few minutes in, while the first is still over", async () => {
    rules = [slo("slo-2"), rule("page-2", "sev3")];
    restart();
    const from = sent.length;
    set({ "slo-2": trips() });
    await check();
    set({ "page-2": over });
    await check(6 * 5);
    set({ "page-2": trips("/products/[id]") });
    await check();
    assert.equal(openedSince(from).length, 1);
    assert.equal(episodeOf("page-2"), episodeOf("slo-2"));
  });

  it("opens its own for a rule tripping hours into another rule's episode", async () => {
    rules = [rule("err-3", "sev2"), rule("lat-3", "sev3")];
    restart();
    const from = sent.length;
    set({ "err-3": trips() });
    await check();
    // Errors keep breaching for three hours.
    set({ "err-3": over });
    await check(6 * 60 * 3);
    set({ "lat-3": trips("/api/cart") });
    await check();
    const news = openedSince(from);
    assert.equal(news.length, 2);
    assert.deepEqual([episodeOf("err-3"), episodeOf("lat-3")], [news[0].incidentId, news[1].incidentId]);
    // The sidebar links the newest.
    assert.equal(watch.watchState().incidentId, news[1].incidentId);
    assert.equal((await store.getIncident(news[0].incidentId))!.joinedRules, undefined);
  });

  it("doesn't let an SLO's slow-burn tail take in a later Page latency trip", async () => {
    // Nov 3: the API SLO tripped on the pool leak at 23:00, and its slow
    // burn kept firing for hours after the leak ended at 23:29.
    rules = [slo("slo-4"), rule("page-4", "sev3")];
    restart();
    const from = sent.length;
    set({ "slo-4": trips() });
    await check();
    set({ "slo-4": slowBurn });
    await check(6 * 90);
    // Its sev4 trips stay in its own episode.
    assert.equal(openedSince(from).length, 1);
    set({ "page-4": trips("/") });
    await check();
    const news = openedSince(from);
    assert.equal(news.length, 2);
    const page = (await store.getIncident(news[1].incidentId))!;
    assert.equal(page.trigger.rule?.id, "page-4");
    assert.deepEqual([ruleStatus("slo-4"), ruleStatus("page-4")], ["alerting", "alerting"]);
  });

  it("re-arms each rule on its own healthy checks", async () => {
    rules = [rule("err-5", "sev2"), rule("lat-5", "sev3")];
    restart();
    const from = sent.length;
    set({ "err-5": trips() });
    await check();
    clock += JOIN_WINDOW();
    set({ "lat-5": trips("/api/cart") });
    await check();
    assert.equal(openedSince(from).length, 2);

    // Errors within their limit for five checks, then over again: the
    // count starts over.
    set({ "err-5": ok, "lat-5": over });
    await check(5);
    set({ "err-5": over });
    await check();
    set({ "err-5": ok });
    await check(5);
    assert.equal(ruleStatus("err-5"), "alerting");
    await check();
    // The sixth: errors re-armed, latency is still in its episode.
    assert.equal(ruleStatus("err-5"), "ok");
    assert.equal(episodeOf("err-5"), undefined);
    assert.equal(ruleStatus("lat-5"), "alerting");
    assert.equal(watch.watchState().status, "alerting");

    // Errors trip again: a new incident (the last was never resolved, so
    // there's nothing to reopen). Latency's episode, opened over 10 min
    // before, takes nothing in.
    clock += JOIN_WINDOW();
    set({ "err-5": trips() });
    await check();
    const news = openedSince(from);
    assert.equal(news.length, 3);
    assert.equal(episodeOf("err-5"), news[2].incidentId);

    // All healthy for a minute: nothing alerting.
    set({ "err-5": ok, "lat-5": ok });
    await check(6);
    assert.equal(watch.watchState().status, "ok");
    assert.equal(watch.watchState().incidentId, undefined);
  });

  it("puts every rule back in its episode after a restart mid-outage, opening nothing", async () => {
    rules = [rule("lat-6", "sev3"), rule("err-6", "sev2"), rule("other-6", "sev2")];
    restart();
    const from = sent.length;
    set({ "lat-6": trips(), "err-6": trips() });
    await check();
    const [first] = openedSince(from);

    // A new process: nothing in memory. Both rules still over their limits.
    clock += 30 * MINUTE;
    restart();
    set({ "lat-6": over, "err-6": over });
    await check();
    // Waiting for its rule to trip: not alerting yet.
    assert.equal(episodeOf("err-6"), first.incidentId);
    assert.equal(episodeOf("lat-6"), first.incidentId);
    assert.equal(watch.watchState().status, "breaching");
    set({ "lat-6": trips(), "err-6": trips() });
    await check(3);
    assert.equal(sent.length, from + 1);
    assert.equal(watch.watchState().status, "alerting");
    assert.equal(watch.watchState().incidentId, first.incidentId);
    assert.deepEqual([ruleStatus("lat-6"), ruleStatus("err-6")], ["alerting", "alerting"]);
    // A rule that wasn't in it opens its own: the incident opened 30 min ago.
    set({ "other-6": trips("/api/cart") });
    await check();
    assert.equal(openedSince(from).length, 2);
  });

  it("drops a rebuilt episode once its rule is healthy, and rebuilds none from a resolved incident", async () => {
    rules = [rule("err-7", "sev2"), rule("lat-7", "sev3")];
    restart();
    const from = sent.length;
    set({ "err-7": trips() });
    await check();
    clock += HOUR;
    set({ "lat-7": trips("/api/cart") });
    await check();
    const [errs, lats] = openedSince(from);
    await store.patchIncident(lats.incidentId, (i) => ({ ...i, status: "resolved", resolvedAt: new Date(clock - 2 * HOUR).toISOString() }));

    clock += HOUR;
    restart();
    await check();
    // Healthy at once: an old incident left open shows nothing.
    assert.equal(watch.watchState().status, "ok");
    assert.equal(episodeOf("err-7"), errs.incidentId);
    assert.equal(episodeOf("lat-7"), undefined);
    await check(5);
    assert.equal(episodeOf("err-7"), undefined);
    set({ "err-7": trips(), "lat-7": trips("/api/cart") });
    await check();
    // A new outage: errors opens one, latency joins it.
    const news = openedSince(from);
    assert.equal(news.length, 3);
    assert.equal(episodeOf("lat-7"), news[2].incidentId);
  });
});

const JOIN_WINDOW = () => watch.JOIN_WINDOW_MS + 10_000;

describe("rule watch reopening", () => {
  it("reopens the rule's incident resolved under 30 minutes before, announcing it once", async () => {
    rules = [rule("err-8", "sev2")];
    restart();
    const from = sent.length;
    set({ "err-8": trips() });
    await check();
    const [first] = openedSince(from);
    set({ "err-8": ok });
    await check(6);
    assert.equal(episodeOf("err-8"), undefined);
    await store.patchIncident(first.incidentId, (i) => ({ ...i, status: "resolved", resolvedAt: new Date(clock).toISOString() }));
    clock += 5 * MINUTE;
    set({ "err-8": trips() });
    await check(3);
    assert.deepEqual(
      sent.slice(from).map((s) => [s.kind, s.incidentId]),
      [
        ["incident_opened", first.incidentId],
        ["incident_reopened", first.incidentId],
      ],
    );
    assert.equal(episodeOf("err-8"), first.incidentId);
    assert.equal(watch.watchState().lastOpened?.reopened, true);
  });
});

// Nov 3: after the pool leak, the API SLO's slow burn kept its episode
// going for hours, and the fast burn of a new outage on its routes only
// joined it: the SLO never paged for the new outage.
describe("an SLO's fast burn in its own slow-burn tail", () => {
  it("opens a new incident at the rule's severity, titled with the new burn", async () => {
    rules = [slo("slo-10")];
    restart();
    const from = sent.length;
    set({ "slo-10": fastBurn(83.3) });
    await check();
    // The leak ends; the slow burn trips at sev4 into the episode for 2 h.
    set({ "slo-10": slowBurn });
    await check(6 * 60 * 2);
    assert.equal(openedSince(from).length, 1);

    set({ "slo-10": fastBurn(42) });
    await check();
    const news = openedSince(from);
    assert.equal(news.length, 2);
    const incident = (await store.getIncident(news[1].incidentId))!;
    assert.equal(incident.severity, "sev2");
    assert.equal(incident.title, "Error budget burning 42× on GET /api/products/[id]");
    assert.equal(incident.trigger.burn?.threshold, 14.4);
    // The SLO's episode is the new outage's; the sidebar links it.
    assert.equal(episodeOf("slo-10"), incident.id);
    assert.equal(watch.watchState().incidentId, incident.id);
    assert.equal(ruleStatus("slo-10"), "alerting");
    // The old incident is left as it was.
    assert.equal((await store.getIncident(news[0].incidentId))!.status, "investigating");

    // It goes on burning, fast then slow: still the one new incident.
    await check(6 * 5);
    set({ "slo-10": slowBurn });
    await check(6 * 60);
    assert.equal(openedSince(from).length, 2);
  });

  it("keeps a fast burn that flaps within 30 minutes in one incident", async () => {
    rules = [slo("slo-11")];
    restart();
    const from = sent.length;
    set({ "slo-11": fastBurn(83.3) });
    await check();
    // Clear for 10 minutes (the slow burn still over), then firing again.
    set({ "slo-11": slowBurn });
    await check(6 * 10);
    set({ "slo-11": fastBurn(20) });
    await check(6);
    // And again after 25 minutes: 25 from the last time it fired, not the first.
    set({ "slo-11": slowBurn });
    await check(6 * 25);
    set({ "slo-11": fastBurn(16) });
    await check();
    const news = openedSince(from);
    assert.equal(news.length, 1);
    assert.equal(episodeOf("slo-11"), news[0].incidentId);
  });

  it("opens a new one once the fast burn has been quiet for 30 minutes", async () => {
    rules = [slo("slo-12")];
    restart();
    const from = sent.length;
    set({ "slo-12": fastBurn(83.3) });
    await check();
    set({ "slo-12": slowBurn });
    await check(6 * 40);
    set({ "slo-12": fastBurn(30) });
    await check();
    const news = openedSince(from);
    assert.equal(news.length, 2);
    assert.equal(episodeOf("slo-12"), news[1].incidentId);
  });

  it("joins another rule's incident opened on the new outage minutes before", async () => {
    rules = [slo("slo-13"), rule("err-13", "sev3")];
    restart();
    const from = sent.length;
    set({ "slo-13": fastBurn(83.3) });
    await check();
    set({ "slo-13": slowBurn });
    await check(6 * 60);
    // Errors first, then the SLO's fast burn two minutes later.
    set({ "err-13": trips() });
    await check();
    set({ "err-13": over });
    await check(6 * 2);
    set({ "slo-13": fastBurn(30) });
    await check();
    const news = openedSince(from);
    assert.equal(news.length, 2);
    assert.equal(episodeOf("slo-13"), news[1].incidentId);
    assert.deepEqual(
      (await store.getIncident(news[1].incidentId))!.joinedRules?.map((j) => j.id),
      ["slo-13"],
    );
  });

  it("reopens its incident resolved in the last 30 minutes, the tail still burning", async () => {
    rules = [slo("slo-14")];
    restart();
    const from = sent.length;
    set({ "slo-14": fastBurn(83.3) });
    await check();
    set({ "slo-14": slowBurn });
    await check(6 * 60);
    await store.patchIncident(sent[from].incidentId, (i) => ({ ...i, status: "resolved", resolvedAt: new Date(clock).toISOString() }));
    await check(6 * 10);
    set({ "slo-14": fastBurn(30) });
    await check();
    assert.deepEqual(
      sent.slice(from).map((s) => s.kind),
      ["incident_opened", "incident_reopened"],
    );
    assert.equal(episodeOf("slo-14"), sent[from].incidentId);
    assert.equal(watch.watchState().lastOpened?.reopened, true);
  });

  it("after a restart in the tail, opens a new incident for a fast burn", async () => {
    rules = [slo("slo-15")];
    restart();
    const from = sent.length;
    set({ "slo-15": fastBurn(83.3) });
    await check();
    set({ "slo-15": slowBurn });
    await check(6 * 60);
    const [first] = openedSince(from);

    clock += MINUTE;
    restart();
    set({ "slo-15": slowBurn });
    await check(6 * 5);
    // The tail's sev4 trips join the incident it waited on.
    assert.equal(episodeOf("slo-15"), first.incidentId);
    assert.equal(ruleStatus("slo-15"), "alerting");
    assert.equal(openedSince(from).length, 1);
    set({ "slo-15": fastBurn(30) });
    await check();
    const news = openedSince(from);
    assert.equal(news.length, 2);
    assert.equal(episodeOf("slo-15"), news[1].incidentId);
  });

  it("after a restart mid-outage, its fast burn still firing, opens nothing", async () => {
    rules = [slo("slo-16")];
    restart();
    const from = sent.length;
    set({ "slo-16": fastBurn(83.3) });
    await check(6 * 60);
    const [first] = openedSince(from);

    clock += MINUTE;
    restart();
    set({ "slo-16": fastBurn(60) });
    await check(6 * 10);
    // Flapping after it, as before the restart.
    set({ "slo-16": slowBurn });
    await check(6 * 20);
    set({ "slo-16": fastBurn(20) });
    await check();
    assert.equal(openedSince(from).length, 1);
    assert.equal(episodeOf("slo-16"), first.incidentId);
    assert.equal(ruleStatus("slo-16"), "alerting");
  });
});

// Resolves `id` at `clock`, its mitigation (turning FF_STOCK_DIRECT_QUERY
// off) in the state given, as on the pool leak's incident on Nov 3.
async function resolveMitigated(id: string, state: "applied" | "denied" = "applied") {
  const at = new Date(clock).toISOString();
  await store.patchIncident(id, (i) => ({
    ...i,
    status: "resolved",
    resolvedAt: at,
    mitigation: {
      kind: "flag_off",
      target: "FF_STOCK_DIRECT_QUERY",
      title: "Turn off FF_STOCK_DIRECT_QUERY",
      why: { text: "The leak is behind the flag", evidenceIds: ["ev_log_1"] },
      steps: ["Turn FF_STOCK_DIRECT_QUERY off"],
      undo: "Turn FF_STOCK_DIRECT_QUERY back on from Shopfront's ops page",
      risk: "low",
      state,
      proposedAt: at,
      ...(state === "applied" && { appliedAt: at }),
    },
  }));
}

// Trips `id` on /products/[id], then within its limit until it re-arms;
// the incident it opened.
async function tripAndRearm(id: string) {
  const from = sent.length;
  set({ [id]: trips("/products/[id]") });
  await check();
  const [first] = openedSince(from);
  set({ [id]: ok });
  await check(6);
  assert.equal(episodeOf(id), undefined);
  return first.incidentId;
}

// Nov 3: the price gap's 500s tripped Server errors on /products/[id] 27 min
// after the pool leak's incident on that rule and route was resolved, with
// FF_STOCK_DIRECT_QUERY still off. The watch reopened the pool leak's
// incident, so the price gap was never investigated.
describe("a breach after a resolution, the old mitigation still in place", () => {
  it("opens a new incident, linked to the one it would have reopened", async () => {
    rules = [rule("err-17", "sev2")];
    restart();
    const from = sent.length;
    const leakId = await tripAndRearm("err-17");
    await resolveMitigated(leakId);
    clock += 27 * MINUTE;
    set({ "err-17": trips("/products/[id]") });
    await check(3);

    const news = openedSince(from);
    assert.equal(news.length, 2);
    assert.ok(!sent.slice(from).some((s) => s.kind === "incident_reopened"));
    const leak = (await store.getIncident(leakId))!;
    const gap = (await store.getIncident(news[1].incidentId))!;
    assert.deepEqual(gap.relatedTo && { id: gap.relatedTo.id, title: gap.relatedTo.title }, { id: leakId, title: leak.title });
    assert.match(
      gap.relatedTo!.why,
      /^Same rule and route, resolved 27 min before this opened, with its mitigation \(FF_STOCK_DIRECT_QUERY off\) still in effect/,
    );
    assert.equal(episodeOf("err-17"), gap.id);
    assert.equal(watch.watchState().lastOpened?.reopened, undefined);
    // The old one stays resolved, as it was.
    assert.equal(leak.status, "resolved");
    assert.equal(leak.reopenings, undefined);
  });

  // Nov 4: the pool leak's incident (Server errors, the API SLO joined) was
  // resolved 7 min after it opened, the SLO's slow-burn tail still over its
  // limit. The price gap's Server errors tripped 2 min later, inside the
  // 10-min join window, and joined the resolved incident: nothing opened,
  // nobody was told, for 16 minutes.
  it("doesn't join a resolved incident inside the join window, though a rule in it is still over", async () => {
    rules = [rule("err-31", "sev2"), slo("slo-31")];
    restart();
    const from = sent.length;
    set({ "err-31": trips("/products/[id]"), "slo-31": fastBurn(40) });
    await check();
    const [leak] = openedSince(from);
    assert.equal(openedSince(from).length, 1);
    assert.equal(episodeOf("slo-31"), leak.incidentId);
    // The leak mitigated: Server errors re-arms, the SLO stays in its tail.
    set({ "err-31": ok, "slo-31": slowBurn });
    await check(6);
    assert.equal(episodeOf("err-31"), undefined);
    clock += 5 * MINUTE;
    await resolveMitigated(leak.incidentId);
    clock += 2 * MINUTE;
    set({ "err-31": trips("/products/[id]") });
    await check(2);

    const news = openedSince(from);
    assert.equal(news.length, 2, "the price gap opens its own incident");
    const gap = (await store.getIncident(news[1].incidentId))!;
    assert.equal(gap.relatedTo?.id, leak.incidentId);
    assert.equal(episodeOf("err-31"), gap.id);
    const old = (await store.getIncident(leak.incidentId))!;
    assert.equal(old.status, "resolved");
    assert.ok(!(old.joinedRules ?? []).some((j) => j.id === "err-31" && Date.parse(j.at) > Date.parse(old.resolvedAt!)));
  });

  it("presumes it still holds when the service can't say", async () => {
    rules = [rule("err-18", "sev2")];
    restart();
    const from = sent.length;
    const leakId = await tripAndRearm("err-18");
    await resolveMitigated(leakId);
    holding = undefined;
    clock += 5 * MINUTE;
    set({ "err-18": trips("/products/[id]") });
    await check();
    const news = openedSince(from);
    assert.equal(news.length, 2);
    const gap = (await store.getIncident(news[1].incidentId))!;
    assert.equal(gap.relatedTo?.id, leakId);
    assert.match(gap.relatedTo!.why, /couldn't confirm is still in effect/);
  });

  it("reopens it as before once the mitigation is undone", async () => {
    rules = [rule("err-19", "sev2")];
    restart();
    const from = sent.length;
    const leakId = await tripAndRearm("err-19");
    await resolveMitigated(leakId);
    // Someone turned the flag back on: the old cause can be back.
    holding = false;
    clock += 10 * MINUTE;
    set({ "err-19": trips("/products/[id]") });
    await check();
    assert.deepEqual(
      sent.slice(from).map((s) => [s.kind, s.incidentId]),
      [
        ["incident_opened", leakId],
        ["incident_reopened", leakId],
      ],
    );
    assert.equal(episodeOf("err-19"), leakId);
  });

  it("reopens it as before when the mitigation was never applied", async () => {
    rules = [rule("err-20", "sev2")];
    restart();
    const from = sent.length;
    const leakId = await tripAndRearm("err-20");
    await resolveMitigated(leakId, "denied");
    clock += 10 * MINUTE;
    set({ "err-20": trips("/products/[id]") });
    await check();
    assert.deepEqual(
      sent.slice(from).map((s) => s.kind),
      ["incident_opened", "incident_reopened"],
    );
    assert.equal(episodeOf("err-20"), leakId);
  });

  it("joins one still verifying after its mitigation, though the mitigation holds", async () => {
    rules = [rule("err-21", "sev2")];
    restart();
    const from = sent.length;
    const leakId = await tripAndRearm("err-21");
    await resolveMitigated(leakId);
    // Not resolved yet: its quiet window is still running.
    const at = new Date(clock).toISOString();
    await store.patchIncident(leakId, (i) => ({
      ...i,
      status: "diagnosed",
      resolvedAt: undefined,
      verification: { after: "mitigation", since: at, windowMinutes: 5, metric: "m", threshold: 5, series: [], status: "verifying", startedAt: at },
    }));
    clock += 2 * MINUTE;
    set({ "err-21": trips("/products/[id]") });
    await check();
    assert.equal(openedSince(from).length, 1);
    assert.equal(episodeOf("err-21"), leakId);
  });
});

// Nov 3: the API SLO judged the price gap on /api/products/[id] 2.5 min
// after Server errors opened its incident on /products/[id] (its short window
// needs 70 requests in 5 min, and traffic had just come back). By then the
// gap was off and Server errors had re-armed, so the SLO opened a second
// incident for the same outage.
describe("an SLO's fast burn judged minutes late", () => {
  it("joins the incident its outage opened, after that rule re-armed", async () => {
    rules = [slo("slo-22"), rule("err-22", "sev2")];
    restart();
    const from = sent.length;
    const gapId = await tripAndRearm("err-22");
    const start = clock - 6 * 10_000;
    clock = start + 150_000 - 10_000;
    // Burning on the gap's minutes, from the minute before Server errors tripped.
    set({ "slo-22": fastBurn(40, "/api/products/[id]", { from: start - MINUTE, to: start + MINUTE }) });
    await check();
    assert.equal(openedSince(from).length, 1);
    assert.equal(episodeOf("slo-22"), gapId);
    assert.deepEqual(
      (await store.getIncident(gapId))!.joinedRules?.map((j) => j.id),
      ["slo-22"],
    );
    assert.equal(ruleStatus("slo-22"), "alerting");
  });

  it("joins on its short window when the burning minutes aren't known", async () => {
    rules = [slo("slo-23"), rule("err-23", "sev2")];
    restart();
    const from = sent.length;
    const gapId = await tripAndRearm("err-23");
    clock += 90_000;
    set({ "slo-23": fastBurn(40) });
    await check();
    assert.equal(openedSince(from).length, 1);
    assert.equal(episodeOf("slo-23"), gapId);
  });

  it("opens its own when its burn started after the other breach ended", async () => {
    rules = [slo("slo-24"), rule("err-24", "sev2")];
    restart();
    const from = sent.length;
    await tripAndRearm("err-24");
    const start = clock - 6 * 10_000;
    clock = start + 4 * MINUTE - 10_000;
    set({ "slo-24": fastBurn(40, "/api/products/[id]", { from: start + 2 * MINUTE, to: start + 4 * MINUTE }) });
    await check();
    const news = openedSince(from);
    assert.equal(news.length, 2);
    assert.equal(episodeOf("slo-24"), news[1].incidentId);
  });

  it("opens its own more than 10 minutes after the other incident opened", async () => {
    rules = [slo("slo-25"), rule("err-25", "sev2")];
    restart();
    const from = sent.length;
    await tripAndRearm("err-25");
    const start = clock - 6 * 10_000;
    clock = start + watch.JOIN_WINDOW_MS;
    set({ "slo-25": fastBurn(40, "/api/products/[id]", { from: start - MINUTE, to: clock }) });
    await check();
    assert.equal(openedSince(from).length, 2);
  });

  it("keeps requiring the other rule over its limit for every other trip", async () => {
    rules = [slo("slo-26"), rule("err-26", "sev2"), rule("lat-26", "sev3")];
    restart();
    const from = sent.length;
    await tripAndRearm("err-26");
    clock += 60_000;
    // A latency rule tripping after errors re-armed: its own incident.
    set({ "lat-26": trips("/api/products/[id]") });
    await check();
    assert.equal(openedSince(from).length, 2);
    set({ "lat-26": ok });
    await check(6);
    // An SLO's slow burn with both re-armed: its own, at sev4.
    set({ "slo-26": slowBurn });
    await check();
    const news = openedSince(from);
    assert.equal(news.length, 3);
    assert.equal((await store.getIncident(news[2].incidentId))!.severity, "sev4");
  });
});

// Nov 4: the API SLO's 6× alert on the price gap was investigated as the
// pool leak its 6 h window also held. The minutes it burns on go on the
// incident, for the brief and the off-flag check.
describe("the minutes an SLO's fast burn is on", () => {
  it("reach the incident it opens", async () => {
    rules = [slo("slo-40")];
    restart();
    const from = sent.length;
    const burning = { from: clock - 19 * MINUTE, to: clock - 3 * MINUTE };
    set({ "slo-40": fastBurn(118, "/api/products/[id]", burning) });
    await check();
    const [opened] = openedSince(from);
    const burn = (await store.getIncident(opened.incidentId))!.trigger.burn;
    assert.deepEqual(burn?.burning, { from: new Date(burning.from).toISOString(), to: new Date(burning.to).toISOString() });
    assert.equal(burn?.threshold, 14.4);
  });

  // The live judge's counts that night, simplified to 100 requests a minute,
  // every one bad in the minutes that burned on their own (02:41 and 03:24
  // to 03:25, the pool leak; 03:32 to 03:45 and 03:47 to 03:48, the price
  // gap, which passed clean at 03:46).
  const at = (hhmm: string) => Date.parse(`2026-11-04T${hhmm}:00.000Z`);
  const bad = new Set(
    [["02:41", 1], ["03:24", 2], ["03:32", 14], ["03:47", 2]].flatMap(([start, n]) =>
      Array.from({ length: n as number }, (_, i) => at(start as string) + i * MINUTE),
    ),
  );
  const counts = (_route: string, from: number) => ({ total: 100, good: bad.has(from) ? 0 : 100 });
  const sixX = { route: "/api/products/[id]", method: "GET", speed: "fast" as const };
  const burnOf = (threshold: number, longMs: number, shortMs: number) => ({ rate: 118, threshold, longMs, shortMs, budgetLeftPercent: -100 });

  it("are the newest run, back to where it began, over a clean minute or two", () => {
    // The 6× alert (6 h and 30 min) at 03:51:39: its short window holds the
    // pool leak's 03:24 to 03:25 too, 6 clean minutes before the burn it
    // fires on began at 03:32.
    const now = at("03:51") + 39_000;
    const burning = watch.burningMinutes(counts, slo("x"), { ...sixX, burn: burnOf(6, 6 * HOUR, 30 * MINUTE) }, now);
    assert.deepEqual(burning, { from: at("03:32"), to: at("03:49") });
    // The 14.4× alert (1 h and 5 min) at 03:49:30: back past its short window.
    const fast = watch.burningMinutes(counts, slo("x"), { ...sixX, burn: burnOf(14.4, HOUR, 5 * MINUTE) }, at("03:49") + 30_000);
    assert.deepEqual(fast, { from: at("03:32"), to: at("03:49") });
    // Three clean minutes in a row end a run: with 03:44 to 03:46 clean, the
    // burn is 03:47 to 03:48.
    const split = (_route: string, from: number) => ({ total: 100, good: bad.has(from) && from !== at("03:44") && from !== at("03:45") ? 0 : 100 });
    const short = watch.burningMinutes(split, slo("x"), { ...sixX, burn: burnOf(6, 6 * HOUR, 30 * MINUTE) }, at("03:51") + 39_000);
    assert.deepEqual(short, { from: at("03:47"), to: at("03:49") });
  });

  it("stop at the long window, and are unknown when no minute of the short window burns", () => {
    const capped = watch.burningMinutes(counts, slo("x"), { ...sixX, burn: burnOf(14.4, 10 * MINUTE, 5 * MINUTE) }, at("03:49") + 30_000);
    // The long window starts at 03:39:30; its first minute counts, as the
    // short window's does.
    assert.deepEqual(capped, { from: at("03:39"), to: at("03:49") });
    // At 03:55 the 5 min window (03:50 on) has no bad minute.
    assert.equal(watch.burningMinutes(counts, slo("x"), { ...sixX, burn: burnOf(14.4, HOUR, 5 * MINUTE) }, at("03:55")), undefined);
  });

  it("are left off when the trip doesn't know them", async () => {
    rules = [slo("slo-41")];
    restart();
    const from = sent.length;
    set({ "slo-41": fastBurn(40) });
    await check();
    const [opened] = openedSince(from);
    const burn = (await store.getIncident(opened.incidentId))!.trigger.burn;
    assert.equal(burn?.rate, 40);
    assert.equal(burn && "burning" in burn, false);
  });
});
