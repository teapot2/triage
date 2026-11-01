import { asSchema, type ToolSet } from "ai";
import type { PromptParts } from "../schema";

// What a question's prompt is made of, so its first call's input tokens
// (the only count the API gives) can be split between the parts for the
// Ask composer's context card. The split is by each part's share of the
// text: close enough to say what fills the window, not a tokenizer's count.

// The prompt's text, part by part, in the order the bar shows them.
export type PromptText = Record<Exclude<keyof PromptParts, "screenshot">, string>;

// The tools as a provider sees them: name, description and JSON Schema.
export async function toolsText(tools: ToolSet): Promise<string> {
  const defs = await Promise.all(
    Object.entries(tools).map(async ([name, t]) => ({
      name,
      description: t.description,
      parameters: await asSchema(t.inputSchema).jsonSchema,
    })),
  );
  return defs.length > 0 ? JSON.stringify(defs) : "";
}

// About 4 characters a token for English and JSON. Used only to tell a
// screenshot's share from the text's, which the API doesn't split.
const CHARS_PER_TOKEN = 4;

export function splitTokens(inputTokens: number, text: PromptText, image: boolean): PromptParts {
  const keys = Object.keys(text) as (keyof PromptText)[];
  const total = keys.reduce((sum, k) => sum + text[k].length, 0);
  // Without a screenshot the whole input is text, shared by length; with
  // one, the text is estimated from its length and the rest is the image.
  const textTokens = image ? Math.min(inputTokens, Math.round(total / CHARS_PER_TOKEN)) : inputTokens;
  const parts = Object.fromEntries(
    keys.map((k) => [k, total > 0 ? Math.round((textTokens * text[k].length) / total) : 0]),
  ) as PromptParts;
  if (image) parts.screenshot = inputTokens - textTokens;
  return parts;
}
