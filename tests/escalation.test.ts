// Escalation (plan C5): which drafts send, 🔍 through C4's lifecycle, one delivery per draft, and
// the package as it leaves. xmsg is a recording fake with X10's idempotency; the guard (S5) is the
// identity and the router (C6) a fixed address. Run with `node --test tests/escalation.test.ts`.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { test } from "node:test";
import { Escalation, THRESHOLD, type XmsgSend } from "../src/escalation/index.ts";
import { Lifecycle } from "../src/lifecycle/index.ts";
import { ThreadStateStore } from "../src/state/index.ts";
import { Supervisor } from "../src/supervisor/index.ts";
import { errors, load } from "../src/tier1/schema.ts";

const tmp = mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/genie-escalation-test-`);
const EXPERT = "genie-expert@trusted";

// X10: a key already sent with the same body returns the first id and delivers nothing; a send
// with no key always delivers.
class FakeXmsg implements XmsgSend {
  sends: { to: string; text: string; key: string }[] = [];
  delivered: { to: string; text: string }[] = [];
  private keys = new Map<string, { text: string; id: string }>();
  async send(to: string, text: string, key: string): Promise<string> {
    this.sends.push({ to, text, key });
    const seen = key ? this.keys.get(key) : undefined;
    if (seen) {
      if (seen.text !== text) throw new Error("xmsg conflict: key reused with another body");
      return seen.id;
    }
    const id = `m${this.delivered.push({ to, text })}`;
    if (key) this.keys.set(key, { text, id });
    return id;
  }
}

let n = 0;
function boot() {
  const thread = `t${n++}`;
  const store = new ThreadStateStore(`${tmp}/state`, `${tmp}/store`);
  const now = "2026-10-12T00:00:00Z";
  store.write({ thread_id: thread, status: "active", created: now, last_active: now, sender_tier: "trusted" });
  const xmsg = new FakeXmsg();
  const esc = new Escalation({
    store,
    xmsg,
    guard: async (p) => p,
    route: () => EXPERT,
    context: () => ({ cleaned_question: "why does my module not apply?", eval_transcript: [] }),
  });
  const supervisor = new Supervisor(() => {
    throw new Error("no process in these tests");
  });
  const lc = new Lifecycle({ supervisor, store, mirror: { mirrorRoot: `${tmp}/m`, worktreeRoot: `${tmp}/w` }, deeper: (t) => esc.deeper(t) });
  return { thread, store, xmsg, esc, lc };
}

const draft = (confidence: number, escalate_forced = false) => ({ answer: "Set `services.foo.enable = true;`.", confidence, gaps: ["did not evaluate at the asker's rev"], escalate_forced });

test("oracle: a forced draft sends with no 🔍", async () => {
  const { thread, store, xmsg, esc } = boot();
  await esc.reply(thread, draft(0.95, true));
  assert.equal(xmsg.delivered.length, 1);
  assert.equal(xmsg.delivered[0].to, EXPERT);
  assert.equal(store.read(thread)!.status, "escalated");
});

test("oracle: a below-threshold draft sends", async () => {
  const { thread, store, xmsg, esc } = boot();
  await esc.reply(thread, draft(0.5));
  assert.equal(xmsg.delivered.length, 1);
  assert.equal(store.read(thread)!.status, "escalated");
});

test("oracle: a confident draft does not send until 🔍", async () => {
  const { thread, store, xmsg, esc, lc } = boot();
  await esc.reply(thread, draft(0.95));
  assert.equal(xmsg.sends.length, 0);
  assert.equal(store.read(thread)!.status, "active");
  await lc.control(thread, "deeper");
  assert.equal(xmsg.delivered.length, 1);
  assert.equal(JSON.parse(xmsg.delivered[0].text).draft.confidence, 0.95);
  assert.equal(store.read(thread)!.status, "escalated");
});

test("oracle: a draft at exactly the threshold does not send until 🔍", async () => {
  const { thread, xmsg, esc, lc } = boot();
  await esc.reply(thread, draft(THRESHOLD));
  assert.equal(xmsg.sends.length, 0);
  await lc.control(thread, "deeper");
  assert.equal(xmsg.delivered.length, 1);
});

test("oracle: 🔍 arriving twice sends exactly once", async () => {
  const { thread, xmsg, esc, lc } = boot();
  await esc.reply(thread, draft(0.95));
  await lc.control(thread, "deeper");
  await lc.control(thread, "deeper");
  await Promise.all([lc.control(thread, "deeper"), lc.control(thread, "deeper")]);
  assert.equal(xmsg.sends.length, 4);
  assert.equal(xmsg.delivered.length, 1);
  assert.equal(new Set(xmsg.sends.map((s) => s.key)).size, 1);
  // Control: a new draft is a new escalation, under a new key.
  await esc.reply(thread, draft(0.9));
  await lc.control(thread, "deeper");
  assert.equal(xmsg.delivered.length, 2);
});

test("oracle: the package validates against schemas/escalation.json, thread_id the supervisor's", async () => {
  const { thread, xmsg, esc } = boot();
  // Tier 1's escalate call names another thread; the supervisor's own id is the one sent.
  const forged = { thread_id: "t-other", cleaned_question: "q", draft: draft(0.2), eval_transcript: [], gaps: [] };
  await esc.escalate(thread, forged);
  assert.equal(xmsg.delivered.length, 1);
  const pkg = JSON.parse(xmsg.delivered[0].text);
  assert.deepEqual(errors(load("escalation"), pkg), []);
  assert.equal(pkg.thread_id, thread);
});
