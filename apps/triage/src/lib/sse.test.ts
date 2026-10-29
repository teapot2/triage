import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sseJsonStream } from "./sse";

function body(pieces: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const p of pieces) controller.enqueue(p);
      controller.close();
    },
  });
}

// The pieces as a fetch body would deliver them: bytes, split wherever.
async function parse(pieces: string[]): Promise<unknown[]> {
  const encoder = new TextEncoder();
  const out: unknown[] = [];
  const reader = sseJsonStream<unknown>(body(pieces.map((p) => encoder.encode(p)))).getReader();
  for (let next = await reader.read(); !next.done; next = await reader.read()) out.push(next.value);
  return out;
}

describe("sseJsonStream", () => {
  it("reads one event per data line, and drops [DONE]", async () => {
    const chunks = await parse(['data: {"type":"start"}\n\ndata: {"type":"text-delta","delta":"hi"}\n\ndata: [DONE]\n\n']);
    assert.deepEqual(chunks, [{ type: "start" }, { type: "text-delta", delta: "hi" }]);
  });

  it("joins events split across chunks, with CRLF and comments", async () => {
    const chunks = await parse([': keep-alive\r\ndata: {"type":"te', 'xt-delta","del', 'ta":"a"}\r\n', "\r\n", 'data: {"type":"finish"}']);
    assert.deepEqual(chunks, [{ type: "text-delta", delta: "a" }, { type: "finish" }]);
  });

  it("joins several data lines of one event with newlines", async () => {
    const chunks = await parse(['data: {"a":\ndata: 1}\n\n']);
    assert.deepEqual(chunks, [{ a: 1 }]);
  });

  it("keeps a multi-byte character split across chunks whole", async () => {
    const bytes = new TextEncoder().encode('data: {"t":"é"}\n\n');
    // The e-acute is two bytes; cut between them.
    const cut = 11;
    const first = await sseJsonStream<{ t: string }>(body([bytes.slice(0, cut), bytes.slice(cut)])).getReader().read();
    assert.deepEqual(first.value, { t: "é" });
  });
});
