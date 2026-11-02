import type { ModelMessage, ToolLoopAgent, ToolSet } from "ai";
import { addUsage, type TokenCounts } from "../models/usage";

type Streamed<TOOLS extends ToolSet> = Awaited<ReturnType<ToolLoopAgent<never, TOOLS>["stream"]>>;

// The loop every model-calling agent runs (the investigation, a fan-out's
// scout, lanes and merge, the fix stage, Ask and the postmortem writer).
// Meta's API only supports tool_choice "auto" (other providers vary), so an
// agent can't be forced to call the tool that finishes it: a run that stops
// in plain text before `done` is told `nudge` and runs again, up to
// `maxNudges` times, while it has steps left. Each run's messages join
// `messages` and its tokens go on `tokens`.
export async function runAgentLoop<TOOLS extends ToolSet>(o: {
  agent: ToolLoopAgent<never, TOOLS>;
  messages: ModelMessage[];
  abortSignal: AbortSignal;
  // Model steps used so far (the agent's prepareStep counts them), and the cap.
  steps: () => number;
  maxSteps: number;
  maxNudges: number;
  nudge: string;
  // Whether the agent did what it's for: an accepted submission, say.
  done: () => boolean;
  tokens: TokenCounts;
  // Streams each run instead of generating it, and reads it to the end.
  // Returns true when the run settled it, done or not, and a nudge wouldn't
  // help.
  read?: (result: Streamed<TOOLS>, pass: number) => Promise<boolean | void>;
}): Promise<void> {
  for (let pass = 0; pass <= o.maxNudges && !o.done() && o.steps() < o.maxSteps; pass++) {
    if (pass > 0) o.messages.push({ role: "user", content: o.nudge });
    if (o.read) {
      const result = await o.agent.stream({ messages: o.messages, abortSignal: o.abortSignal });
      const settled = await o.read(result, pass);
      addUsage(o.tokens, await result.totalUsage);
      o.messages.push(...(await result.responseMessages));
      if (settled) break;
    } else {
      const result = await o.agent.generate({ messages: o.messages, abortSignal: o.abortSignal });
      o.messages.push(...result.responseMessages);
      addUsage(o.tokens, result.usage);
    }
  }
}
