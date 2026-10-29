import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { exampleIncidents } from "../fixtures";
import type { Incident, Question } from "../schema";
import { askRefusal, knownEvidenceIds, nextQuestionId, parseCitations } from "./rules";

const finished = (): Incident => structuredClone(exampleIncidents[0]);

function question(id: string, patch: Partial<Question> = {}): Question {
  return {
    id,
    text: "Why not the cache?",
    askedAt: "2026-10-23T03:00:00Z",
    status: "answered",
    answer: "",
    citedIds: [],
    unknownIds: [],
    steps: [],
    evidence: [],
    mode: "tools",
    model: "muse-spark-1.3",
    ...patch,
  };
}

describe("parseCitations", () => {
  const known = new Set(["ev_log_3", "ev_span_1", "ev_q2_metric_1"]);

  it("splits bracketed IDs into cited and unknown, in order of first mention", () => {
    const answer = "Pool waits rose [ev_span_1] while the cache stayed fast [ev_q2_metric_1]. Errors: [ev_log_9] and [ev_log_3] [ev_span_1].";
    assert.deepEqual(parseCitations(answer, known), {
      citedIds: ["ev_span_1", "ev_q2_metric_1", "ev_log_3"],
      unknownIds: ["ev_log_9"],
    });
  });

  it("reads several IDs in one bracket, and backticks inside it", () => {
    assert.deepEqual(parseCitations("Both [ev_log_3, `ev_span_1`; ev_db_2].", known), {
      citedIds: ["ev_log_3", "ev_span_1"],
      unknownIds: ["ev_db_2"],
    });
  });

  it("ignores IDs outside brackets and brackets without IDs", () => {
    assert.deepEqual(parseCitations("See ev_log_3 and [the report] (ev_span_1).", known), { citedIds: [], unknownIds: [] });
  });

  it("does not take a trailing underscore or punctuation into the ID", () => {
    assert.deepEqual(parseCitations("[ev_log_3_]. [ev_span_1.]", known).citedIds, ["ev_log_3", "ev_span_1"]);
  });
});

describe("askRefusal", () => {
  it("accepts a finished incident with no open question", () => {
    assert.equal(askRefusal(finished()), undefined);
  });

  it("refuses while the investigation runs or without a report", () => {
    const running = { ...finished(), status: "investigating" as const };
    assert.match(askRefusal(running) ?? "", /no report yet/);
    const noReport = { ...finished(), report: undefined };
    assert.match(askRefusal(noReport) ?? "", /no report yet/);
  });

  it("refuses while another question is answering, not after it ends", () => {
    const answering = { ...finished(), questions: [question("q_1"), question("q_2", { status: "answering" })] };
    assert.match(askRefusal(answering) ?? "", /q_2 is still being answered/);
    const failed = { ...finished(), questions: [question("q_1"), question("q_2", { status: "failed" })] };
    assert.equal(askRefusal(failed), undefined);
  });
});

describe("nextQuestionId", () => {
  it("numbers questions from q_1", () => {
    assert.equal(nextQuestionId(finished()), "q_1");
    assert.equal(nextQuestionId({ ...finished(), questions: [question("q_1"), question("q_2")] }), "q_3");
  });
});

describe("knownEvidenceIds", () => {
  it("covers the investigation's evidence and every question's", () => {
    const incident = finished();
    const span = incident.evidence.find((e) => e.kind === "span")!;
    const earlier = question("q_1", { evidence: [{ ...span, id: "ev_q1_span_1" }] });
    const current = question("q_2", { status: "answering", evidence: [{ ...span, id: "ev_q2_span_1" }] });
    const known = knownEvidenceIds({ ...incident, questions: [earlier, { ...current, evidence: [] }] }, current);
    assert.ok(known.has(incident.evidence[0].id));
    assert.ok(known.has("ev_q1_span_1"));
    assert.ok(known.has("ev_q2_span_1"));
  });
});
