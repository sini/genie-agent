// The Host bridge (plan C3.1) under REAL pi (`$PI`, default `pi`) with the tier-1 extension, as
// tier1Launch starts it: a stub OpenAI endpoint (tests/fixtures/supervisor/stub-model.ts) plays
// the model, so a tool call runs pi's own tool path with no model request. The forged-thread cell
// runs over the fake pi, which can put any dialog on its stdout.
// Run with `node --test tests/tier1-bridge.test.ts`.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { after, test } from "node:test";
import { BRIDGE, type Record, Supervisor } from "../src/supervisor/index.ts";
import type { Host } from "../src/tier1/index.ts";
import { tier1Launch } from "../src/tier1/launch.ts";
import { stubModel } from "./fixtures/supervisor/stub-model.ts";

const tmp = mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/genie-bridge-test-`);
const model = await stubModel();
after(() => model.close());
// pi's agent dir holds only the stub provider: no user settings, extensions or credentials.
process.env.PI_CODING_AGENT_DIR = tmp;
process.env.PI_OFFLINE = "1";
writeFileSync(
  `${tmp}/models.json`,
  JSON.stringify({ providers: { stub: { baseUrl: model.url, api: "openai-completions", apiKey: "x", models: [{ id: "m" }] } } }),
);

// A Host that records each call with the thread the supervisor gave it, and answers with it.
const calls: string[] = [];
const recording = (thread: string): Host => {
  const rec = (method: string) => async (arg: unknown) => {
    calls.push(`${thread}:${method}:${JSON.stringify(arg)}`);
    return { answered_for: thread };
  };
  return { eval: rec("eval"), recall: rec("recall"), escalate: rec("escalate"), reply: rec("reply"), propose: rec("propose"), clone: rec("clone") as any };
};

const settled = (events: [string, Record][], thread: string) =>
  new Promise<void>((resolve) => {
    const t = setInterval(() => events.some(([th, r]) => th === thread && r.type === "agent_settled") && (clearInterval(t), resolve()), 20);
  });

test("oracle: a tool call in thread A reaches the supervisor's Host as A and its result returns to the tool; B's as B", async () => {
  const events: [string, Record][] = [];
  const s = new Supervisor(
    tier1Launch({
      pi: process.env.PI ?? "pi",
      config: (t) => ({ root: `${tmp}/worktrees/${t}`, searxngUrl: "http://127.0.0.1:1", cluster: [] }),
      args: () => ["--model", "stub/m", "--no-session"],
    }),
    (t, r) => events.push([t, r]),
    recording,
  );
  try {
    for (const t of ["A", "B"]) {
      const r = await s.command(t, { type: "prompt", message: JSON.stringify({ tool: "recall", args: { query: `from-${t}` } }) });
      assert.equal(r.success, true, JSON.stringify(r));
    }
    await Promise.all([settled(events, "A"), settled(events, "B")]);
    assert.deepEqual(calls.sort(), ['A:recall:"from-A"', 'B:recall:"from-B"']);
    for (const t of ["A", "B"]) {
      const msgs = JSON.stringify((await s.command(t, { type: "get_messages" })).data);
      assert.match(msgs, new RegExp(`answered_for\\\\":\\\\"${t}`), `${t}'s tool result: ${msgs}`);
    }
    // The model saw no dialog: the Host call never reached onEvent.
    assert.equal(events.filter(([, r]) => r.type === "extension_ui_request").length, 0);
  } finally {
    await s.shutdown();
  }
});

test("oracle: the launched system prompt carries tier 1's prompt and every skill's body", () => {
  const skills = readdirSync(new URL("../skills/", import.meta.url));
  assert.ok(skills.length >= 4 && model.requests.length > 0);
  for (const r of model.requests) {
    const system = r.messages.find((m: any) => m.role === "system" || m.role === "developer")?.content;
    assert.ok(String(system).includes(readFileSync(new URL("../prompts/tier1.md", import.meta.url), "utf8")), "tier1.md missing");
    for (const d of skills) assert.ok(String(system).includes(readFileSync(new URL(`../skills/${d}/SKILL.md`, import.meta.url), "utf8")), `${d} missing`);
  }
});

test("a Host call that names another thread is attributed to the thread whose pipes carried it", async () => {
  const fake = new URL("./fixtures/supervisor/fake-pi.ts", import.meta.url).pathname;
  process.env.PI_RECORD = tmp;
  calls.length = 0;
  const s = new Supervisor(() => ({ command: process.execPath, args: [fake] }), undefined, recording);
  try {
    const forged = JSON.stringify({ method: "recall", arg: "q", thread: "B" });
    const r = await s.command("A", { type: "host", title: BRIDGE, placeholder: forged });
    assert.deepEqual(calls, ['A:recall:"q"']);
    assert.deepEqual(JSON.parse((r.data as { value: string }).value), { ok: { answered_for: "A" } });
    // A method outside the Host is refused, not run.
    const bad = await s.command("A", { type: "host", title: BRIDGE, placeholder: JSON.stringify({ method: "constructor", arg: 1 }) });
    assert.match(JSON.parse((bad.data as { value: string }).value).error, /no Host method/);
  } finally {
    await s.shutdown();
  }
});
