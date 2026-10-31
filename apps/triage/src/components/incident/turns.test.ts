import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { InvestigationStep, Thought } from "../../lib/investigation/schema";
import { countTurns, groupTurns, turnTiming } from "./turns";

const at = (s: number) => new Date(Date.UTC(2026, 9, 31, 12, 0, s)).toISOString();
const thought = (id: string, s: number): Thought => ({ id, startedAt: at(s), durationMs: 500, text: id });
// `null` for a call still running.
const step = (id: string, s: number, turn?: string, durationMs: number | null = 1000): InvestigationStep => ({
  id,
  tool: "query_logs",
  input: {},
  status: durationMs === null ? "running" : "completed",
  startedAt: at(s),
  durationMs: durationMs ?? undefined,
  evidenceIds: [],
  ...(turn && { turn }),
});

const shape = (turns: ReturnType<typeof groupTurns>) =>
  turns.map((t) => [t.key, t.thought?.id ?? null, t.steps.map((s) => s.id), t.together]);

describe("groupTurns", () => {
  it("keeps a model call whose thought was dropped as its own turn", () => {
    // th_b came back empty and was dropped; its calls still carry its ID.
    const thoughts = [thought("th_a", 0)];
    const steps = [step("c1", 1, "th_a"), step("c2", 1, "th_a"), step("c3", 5, "th_b"), step("c4", 5, "th_b")];
    assert.deepEqual(shape(groupTurns(thoughts, thoughts, steps)), [
      ["th_a", "th_a", ["c1", "c2"], true],
      ["th_b", null, ["c3", "c4"], true],
    ]);
  });

  it("falls back to the time order for runs recorded without turn IDs", () => {
    // The old shape: the second call's empty thought is gone, so its calls
    // join the first. That's what the timeline drew before.
    const thoughts = [thought("th_a", 0), thought("th_c", 9)];
    const steps = [step("c1", 1), step("c2", 1), step("c3", 5), step("c4", 10)];
    assert.deepEqual(shape(groupTurns(thoughts, thoughts, steps)), [
      ["th_a", "th_a", ["c1", "c2", "c3"], false],
      ["th_c", "th_c", ["c4"], false],
    ]);
  });

  it("cuts turns at hidden thoughts too, and keeps the last thought with no calls", () => {
    const thoughts = [thought("th_a", 0), thought("th_b", 4), thought("th_c", 8)];
    const steps = [step("c1", 1, "th_a"), step("c2", 5, "th_b")];
    assert.deepEqual(shape(groupTurns(thoughts, [thoughts[0], thoughts[2]], steps)), [
      ["th_a", "th_a", ["c1"], true],
      ["th_b", null, ["c2"], true],
      ["th_c", "th_c", [], false],
    ]);
  });
});

describe("turnTiming", () => {
  it("measures the calls from the first start to the last end, and back to back", () => {
    const steps = [step("c1", 1, "th_a", 2000), step("c2", 1, "th_a", 3000), step("c3", 2, "th_a", 1000)];
    assert.deepEqual(turnTiming(steps), { calls: 3, wallMs: 3000, serialMs: 6000 });
  });

  it("gives no times while a call still runs", () => {
    assert.deepEqual(turnTiming([step("c1", 1, "th_a"), step("c2", 1, "th_a", null)]), { calls: 2 });
  });
});

describe("countTurns", () => {
  it("counts the model calls that made tool calls, where recorded", () => {
    assert.equal(countTurns([step("c1", 1, "th_a"), step("c2", 1, "th_a"), step("c3", 5, "th_b")]), 2);
    assert.equal(countTurns([step("c1", 1)]), undefined);
  });
});
