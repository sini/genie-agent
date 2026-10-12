// Tier 1's draft out of one model reply (an OpenAI-style assistant message): the arguments of its
// `reply` call, mapped back from the model's "yes"/"no" and validated against schemas/draft.json.
// A reply with no `reply` call, including one that writes the call as text, has no draft.
import { errors, fromModel, load } from "./schema.ts";

export interface Message {
  content?: string | null;
  tool_calls?: { function: { name: string; arguments: string } }[];
}

export type Draft = { answer: string; confidence: number; gaps: string[]; escalate_forced: boolean };

const schema = load("draft");

export function draftOf(message: Message): { draft: Draft } | { error: string } {
  const calls = (message.tool_calls ?? []).filter((c) => c.function.name === "reply");
  if (calls.length !== 1) return { error: `${calls.length} reply calls` };
  let args: unknown;
  try {
    args = JSON.parse(calls[0].function.arguments);
  } catch {
    return { error: "reply arguments are not JSON" };
  }
  const draft = fromModel(schema, args);
  const bad = errors(schema, draft);
  return bad.length ? { error: bad.join("; ") } : { draft: draft as Draft };
}
