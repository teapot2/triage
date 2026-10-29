// Server-sent events, as `createUIMessageStreamResponse` writes them, back
// into the JSON values inside them: one `data:` line per event (a chunk
// may hold several events or a part of one), blank line between events,
// `[DONE]` at the end. `ai` offers its own parser only against a schema,
// and the chunks are typed on the server already.
export function sseJson<T>(): TransformStream<string, T> {
  let buffer = "";
  let data: string[] = [];

  const dispatch = (controller: TransformStreamDefaultController<T>) => {
    if (data.length === 0) return;
    const text = data.join("\n");
    data = [];
    if (text !== "[DONE]") controller.enqueue(JSON.parse(text) as T);
  };
  const take = (line: string, controller: TransformStreamDefaultController<T>) => {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line === "") return dispatch(controller);
    if (line.startsWith(":")) return;
    if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  };

  return new TransformStream<string, T>({
    transform(text, controller) {
      buffer += text;
      let end = buffer.indexOf("\n");
      while (end !== -1) {
        take(buffer.slice(0, end), controller);
        buffer = buffer.slice(end + 1);
        end = buffer.indexOf("\n");
      }
    },
    flush(controller) {
      if (buffer) take(buffer, controller);
      dispatch(controller);
    },
  });
}

// Bytes to text, with multi-byte characters that straddle two chunks kept
// whole. (TextDecoderStream's types don't line up with a fetch body's.)
function decodeText(): TransformStream<Uint8Array, string> {
  const decoder = new TextDecoder();
  return new TransformStream<Uint8Array, string>({
    transform(chunk, controller) {
      controller.enqueue(decoder.decode(chunk, { stream: true }));
    },
    flush(controller) {
      const rest = decoder.decode();
      if (rest) controller.enqueue(rest);
    },
  });
}

// A response body's events as a stream of the values inside them.
export function sseJsonStream<T>(body: ReadableStream<Uint8Array>): ReadableStream<T> {
  return body.pipeThrough(decodeText()).pipeThrough(sseJson<T>());
}
