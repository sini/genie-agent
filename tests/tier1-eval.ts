// Tier 1's live draft evaluation: each question of tests/fixtures/tier1-eval/questions.jsonl goes to
// ninfer at temperature 0 with prompts/tier1.md, the four skills appended as the supervisor seeds
// them (design §4 step 2), and the tools C1 registers, offered as C1 offers them. Every tool but
// `reply` answers "unavailable in this evaluation". A question passes when its last model turn
// carries a `reply` call whose arguments draftOf() accepts against schemas/draft.json.
// One request at a time: ninfer also serves the live guard.
//
// Usage:
//   flock ~/.local/state/genie-model.lock node tests/tier1-eval.ts [--prompt <file>] [--out <file>]
// Exit 0: every question parsed. 1: at least one did not, including a turn cut off at max-tokens
// (finish "length"). 2: could not measure.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { firstModel } from "../src/guard/service.ts";
import { type Draft, draftOf, type Message } from "../src/tier1/draft.ts";
import { type Pi, tier1 } from "../src/tier1/index.ts";

const root = new URL("..", import.meta.url);
const defaultKey = "/home/sini/.config/hyperqwen/api-key";
const { values: args } = parseArgs({
  options: {
    prompt: { type: "string", default: new URL("prompts/tier1.md", root).pathname },
    out: { type: "string" },
    base: { type: "string", default: process.env.NINFER_URL ?? "http://10.9.2.2:18020/v1" },
    "api-key-file": { type: "string", default: existsSync(defaultKey) ? defaultKey : undefined },
    turns: { type: "string", default: "6" },
    // Reasoning counts against it. At 8192, 2 of 8 first turns were cut mid-reasoning (2026-10-12).
    "max-tokens": { type: "string", default: "16384" },
  },
});

const die = (msg: string): never => {
  console.error(`COULD NOT MEASURE: ${msg}`);
  process.exit(2);
};
// A crash is no measurement either: exit 1 means a draft failed to parse, and only that.
process.on("uncaughtException", (e) => die(String(e)));

const questions: { id: string; question: string }[] = readFileSync(
  new URL("tests/fixtures/tier1-eval/questions.jsonl", root),
  "utf8",
)
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const skillsDir = new URL("skills/", root);
const skills = readdirSync(skillsDir)
  .sort()
  .map((d) => `<skill name="${d}">\n${readFileSync(new URL(`${d}/SKILL.md`, skillsDir), "utf8")}</skill>`);
const system = `${readFileSync(args.prompt, "utf8")}\n\n# Skills\n\n${skills.join("\n\n")}\n`;

// The tool definitions exactly as C1 registers them.
const tools: { type: "function"; function: { name: string; description: string; parameters: unknown } }[] = [];
const recorder = {
  registerTool: ({ name, description, parameters }) => tools.push({ type: "function", function: { name, description, parameters } }),
  on() {},
  setActiveTools() {},
} as Pi;
const never = () => Promise.reject(new Error("not called"));
tier1(
  { root: "/nonexistent", searxngUrl: "http://127.0.0.1:1", cluster: [] },
  { host: { eval: never, recall: never, escalate: never, reply: never, propose: never, clone: never }, screen: never },
)(recorder);

const apiKey = args["api-key-file"] ? readFileSync(args["api-key-file"], "utf8").trim() : undefined;
if (args["api-key-file"] && !apiKey) die(`${args["api-key-file"]} is empty`);
const model = await firstModel(args.base, apiKey).catch((e) => die(e.message));

async function complete(messages: unknown[]): Promise<{ message: Message; finish: string }> {
  const res = await fetch(`${args.base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({ model, temperature: 0, max_tokens: Number(args["max-tokens"]), messages, tools }),
    signal: AbortSignal.timeout(300_000),
  }).catch((e) => die(String(e)));
  const body = await res.text();
  if (!res.ok) die(`HTTP ${res.status} ${body.slice(0, 200)}`);
  const choice = JSON.parse(body).choices?.[0];
  if (!choice?.message) die(`no choice in ${body.slice(0, 200)}`);
  return { message: choice.message, finish: choice.finish_reason };
}

interface Result {
  id: string;
  calls: string[];
  finish: string;
  draft?: Draft;
  error?: string;
  last: Message;
}

const results: Result[] = [];
for (const q of questions) {
  const messages: any[] = [
    { role: "system", content: system },
    { role: "user", content: q.question },
  ];
  const calls: string[] = [];
  let last: Message = {};
  let finish = "";
  for (let turn = 0; turn < Number(args.turns); turn++) {
    ({ message: last, finish } = await complete(messages));
    const toolCalls = (last as any).tool_calls ?? [];
    calls.push(...toolCalls.map((c: any) => c.function.name));
    if (!toolCalls.length || toolCalls.some((c: any) => c.function.name === "reply")) break;
    messages.push({ role: "assistant", content: last.content ?? "", tool_calls: toolCalls });
    for (const c of toolCalls)
      messages.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify({ error: `${c.function.name} is unavailable in this evaluation` }) });
  }
  const parsed = draftOf(last);
  results.push({ id: q.id, calls, finish, last, ...parsed });
}

console.log(`model: ${model}`);
console.log(`prompt: ${args.prompt}`);
console.log("id                      parsed  confidence  gaps  forced  calls");
for (const r of results) {
  const d = r.draft;
  console.log(
    `${r.id.padEnd(23)} ${(d ? "yes" : "no").padEnd(7)} ${String(d?.confidence ?? "-").padEnd(11)} ${String(d?.gaps.length ?? "-").padEnd(5)} ${String(d?.escalate_forced ?? "-").padEnd(7)} ${r.calls.join(",") || "(none)"}${r.error ? `  ERROR: ${r.error} (finish ${r.finish})` : ""}`,
  );
}
const ok = results.filter((r) => r.draft).length;
console.log(`parsed: ${ok}/${results.length}`);
if (args.out) writeFileSync(args.out, `${JSON.stringify({ model, prompt: args.prompt, results }, null, 2)}\n`);
process.exit(ok === results.length && results.length > 0 ? 0 : 1);
