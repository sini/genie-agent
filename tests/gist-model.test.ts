import assert from "node:assert/strict";
import { test } from "node:test";
import { tier1, type Host, type Pi } from "../src/tier1/index.ts";

test("gist model: existing propose advertises typed gist operations and converts explicit public yes no", async () => {
  const proposals: unknown[] = [];
  const noop = async () => ({});
  const host: Host = {
    eval: noop, recall: noop, escalate: noop, reply: noop, git: noop, gh_read: noop,
    propose: async (value) => { proposals.push(value); return { ok: true }; },
    clone: async () => ({ path: "/unused-fixture", rev: "fixture" }),
    screen: async (text) => text, room_context: async () => "",
  };
  const tools = new Map<string, any>();
  const pi: Pi = { registerTool: (tool) => { tools.set(tool.name, tool); }, on: () => {}, setActiveTools: () => {} };
  tier1({ root: "/unused-fixture", searxngUrl: "http://127.0.0.1:1", cluster: [] }, { host })(pi);
  const propose = tools.get("propose");
  assert.match(propose.description, /gist_read/);
  for (const [publicValue, expected] of [["yes", true], ["no", false]] as const) {
    await propose.execute("fixture", { kind: "gist", title: "candidate", body: "", files: { "note.md": "design" }, public: publicValue });
    assert.equal((proposals.at(-1) as any).public, expected);
  }
  await propose.execute("fixture", { kind: "gist_read", id: "abc123" });
  assert.deepEqual(proposals.at(-1), { kind: "gist_read", id: "abc123" });
});
