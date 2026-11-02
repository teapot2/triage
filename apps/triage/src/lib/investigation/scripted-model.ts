import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";

// Tests: a scripted language model for the agents' loops, and what to read
// back from the calls it saw. Each call is answered with a turn: text, tool
// calls, both, or an error to throw. A turn with no tool calls ends the
// agent's run, as plain text does from a real model.

export type Call = Parameters<MockLanguageModelV4["doGenerate"]>[0];
export type Turn = { tools?: [string, unknown][]; text?: string } | Error;
type Reply = Awaited<ReturnType<MockLanguageModelV4["doGenerate"]>>;
type StreamPart = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>["stream"] extends ReadableStream<infer P> ? P : never;

const textOf = (m: Call["prompt"][number]) =>
  m.role === "user" ? m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n") : "";

export const userText = (call: Call) => call.prompt.map(textOf).filter(Boolean).join("\n");
// The last message the agent was sent: the prompt, or a nudge.
export const lastUserText = (call: Call) => textOf(call.prompt.findLast((m) => m.role === "user")!);
export const systemText = (call: Call) => call.prompt.flatMap((m) => (m.role === "system" ? [m.content] : [])).join("\n");
export const toolNames = (call: Call) => (call.tools ?? []).map((t) => t.name).sort();
// How many times the agent has answered before this call, nudges or not.
export const turnOf = (call: Call) => call.prompt.filter((m) => m.role === "assistant").length;

// What the tools returned so far in this agent's conversation, as objects.
export function toolResults(call: Call): Record<string, unknown>[] {
  return toolOutputs(call).flatMap((o) => (typeof o.value === "object" && o.value ? [o.value as Record<string, unknown>] : []));
}

// Every tool result so far, by tool: JSON, text or an error's text.
export function toolOutputs(call: Call): { toolName: string; value: unknown }[] {
  return call.prompt.flatMap((m) =>
    m.role === "tool"
      ? m.content.flatMap((p) => (p.type === "tool-result" && "value" in p.output ? [{ toolName: p.toolName, value: p.output.value }] : []))
      : [],
  );
}

// A script answering each call with the next turn, whatever came back. (A
// turn with neither text nor tool calls leaves nothing in the conversation,
// so turnOf can't count it.)
export function inOrder(...turns: Turn[]): () => Turn {
  let i = 0;
  return () => turns[i++] ?? new Error(`the script has ${turns.length} turns`);
}

let callIds = 0;
const toolCalls = (turn: Exclude<Turn, Error>) =>
  (turn.tools ?? []).map(([toolName, input]) => ({
    type: "tool-call" as const,
    toolCallId: `call_${++callIds}`,
    toolName,
    input: JSON.stringify(input),
  }));

const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};

export function reply(turn: Exclude<Turn, Error>): Reply {
  const calls = toolCalls(turn);
  return {
    content: [...(turn.text ? [{ type: "text" as const, text: turn.text }] : []), ...calls],
    finishReason: { unified: calls.length ? "tool-calls" : "stop", raw: undefined },
    usage,
    warnings: [],
  };
}

// The same turn as a stream: the text, then each tool call's input as it's
// written and the call itself.
function streamParts(turn: Exclude<Turn, Error>): StreamPart[] {
  const calls = toolCalls(turn);
  return [
    { type: "stream-start", warnings: [] },
    ...(turn.text
      ? ([
          { type: "text-start", id: "text_1" },
          { type: "text-delta", id: "text_1", delta: turn.text },
          { type: "text-end", id: "text_1" },
        ] as const)
      : []),
    ...calls.flatMap((c) => [
      { type: "tool-input-start" as const, id: c.toolCallId, toolName: c.toolName },
      { type: "tool-input-delta" as const, id: c.toolCallId, delta: c.input },
      { type: "tool-input-end" as const, id: c.toolCallId },
      c,
    ]),
    { type: "finish", finishReason: { unified: calls.length ? "tool-calls" : "stop", raw: undefined }, usage },
  ];
}

// A model that answers every call, generated or streamed, from `script`,
// and keeps the calls in `seen`.
export function scriptedModel(script: (call: Call) => Turn, seen: Call[] = [], modelId = "scripted") {
  const next = (call: Call) => {
    seen.push(call);
    const turn = script(call);
    if (turn instanceof Error) throw turn;
    return turn;
  };
  return new MockLanguageModelV4({
    provider: "mock",
    modelId,
    doGenerate: async (call) => reply(next(call)),
    doStream: async (call) => ({ stream: convertArrayToReadableStream(streamParts(next(call))) }),
  });
}

export const claim = (text: string, ...evidenceIds: string[]) => ({ text, evidenceIds });

// A pool-leak root-cause report that passes reportProblems, citing `ids`.
export function rootCause(ids: { symptom: string; cause: string; ruledOut: string }) {
  return {
    summary: "Product pages slowed down because the stock lookup leaks database connections.",
    hypotheses: [
      {
        id: "A",
        title: "Connection pool leak in the stock lookup",
        confidence: 0.8,
        status: "leading",
        causalChain: {
          symptom: claim("Product page p95 latency climbed past the limit", ids.symptom),
          propagation: claim("Requests wait for a pooled connection that never frees", ids.cause),
          rootCause: claim("getStockLevel never releases its connection", ids.cause),
        },
      },
      {
        id: "B",
        title: "Traffic spike overloaded the service",
        confidence: 0.1,
        status: "rejected",
        causalChain: {
          symptom: claim("Latency rose with load", ids.symptom),
          propagation: claim("More requests queue for the database", ids.ruledOut),
          rootCause: claim("A burst of traffic arrived", ids.ruledOut),
        },
        rejectedBecause: claim("The request rate stayed flat throughout", ids.ruledOut),
      },
      {
        id: "C",
        title: "Slow queries in Postgres",
        confidence: 0.1,
        status: "plausible",
        causalChain: {
          symptom: claim("Latency rose on database routes", ids.symptom),
          propagation: claim("Queries hold connections for longer", ids.cause),
          rootCause: claim("A query plan regressed", ids.cause),
        },
      },
    ],
    verdict: { kind: "root_cause", hypothesisId: "A" },
  };
}
