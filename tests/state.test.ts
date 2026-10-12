// The thread-state store (plan P2): a thread's first life runs in its own OS process
// (tests/fixtures/state/writer.ts) through the supervisor and the recording fake pi; its second life
// is a fresh store and supervisor over the same paths. Run with `node --test tests/state.test.ts`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { Supervisor } from "../src/supervisor/index.ts";
import { type ThreadState, ThreadStateStore } from "../src/state/index.ts";

const tmp = mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/genie-state-test-`);
process.env.PI_RECORD = tmp;
const [stateRoot, storeRoot] = [`${tmp}/state`, `${tmp}/store`];
const writer = new URL("./fixtures/state/writer.ts", import.meta.url).pathname;
const fake = new URL("./fixtures/supervisor/fake-pi.ts", import.meta.url).pathname;
const FACT = "the-launch-code-is-4471";
const KEY = { repo: "https://github.com/sini/x", rev: "abc", attr: "a", flags: [] };

const messages = async (s: Supervisor, thread: string) =>
  JSON.stringify(((await s.command(thread, { type: "get_messages" })).data as { messages: unknown[] }).messages);

test("oracle: restart, then resume ⇒ the same transcript, tier and cache", async () => {
  const state: ThreadState = {
    thread_id: "$ev1",
    status: "escalated",
    created: "2026-10-12T00:00:00Z",
    last_active: "2026-10-12T01:00:00Z",
    sender_tier: "trusted",
  };
  const value = { ok: true, value: "42" };
  execFileSync(process.execPath, [writer, stateRoot, storeRoot, "$ev1", FACT, JSON.stringify(state), JSON.stringify(value)]);

  const store = new ThreadStateStore(stateRoot, storeRoot);
  const s = new Supervisor((t) => ({ command: process.execPath, args: [fake, ...store.sessionArgs(t)] }));
  try {
    assert.match(await messages(s, "$ev1"), new RegExp(FACT));
    assert.deepEqual(store.read("$ev1"), state);
    assert.deepEqual(store.cacheGet("$ev1", KEY), value);
    // Control: another thread over the same paths has none of it.
    assert.equal(await messages(s, "$ev2"), "[]");
    assert.equal(store.read("$ev2"), undefined);
    assert.equal(store.cacheGet("$ev2", KEY), undefined);
    assert.equal(store.cacheGet("$ev1", { ...KEY, flags: ["--impure"] }), undefined);
  } finally {
    await s.shutdown();
  }
});

test("the thread store is a separate path from the thread state", () => {
  const store = new ThreadStateStore(stateRoot, storeRoot);
  assert.equal(store.store("$ev1"), `${storeRoot}/$ev1`);
  assert.equal(store.dir("$ev1"), `${stateRoot}/$ev1`);
});

test("a torn write leaves the last whole state", () => {
  const store = new ThreadStateStore(stateRoot, storeRoot);
  const before = store.read("$ev1");
  assert.notEqual(before, undefined);
  writeFileSync(`${store.dir("$ev1")}/.state.json.tmp`, '{"thread_id": "$ev1", "sta');
  assert.deepEqual(new ThreadStateStore(stateRoot, storeRoot).read("$ev1"), before);
});

test("a thread id that names another directory is refused", () => {
  const store = new ThreadStateStore(stateRoot, storeRoot);
  for (const bad of ["../escape", "..", ".", "", "a/b", "/abs", "a\0b"]) {
    assert.throws(() => store.dir(bad), /refused thread id/, bad);
    assert.throws(() => store.store(bad), /refused thread id/, bad);
    assert.throws(() => store.write({ thread_id: bad } as ThreadState), /refused thread id/, bad);
  }
});
