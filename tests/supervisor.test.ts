// The tier-1 supervisor (plan C3) against a recording fake pi (tests/fixtures/supervisor/fake-pi.ts)
// run as real OS processes: real PIDs, real pipes, pi's RPC framing; only the model is absent.
// Run with `node --test tests/supervisor.test.ts`.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { type Record, Supervisor } from "../src/supervisor/index.ts";

const record = mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/genie-supervisor-test-`);
process.env.PI_RECORD = record;
const fake = new URL("./fixtures/supervisor/fake-pi.ts", import.meta.url).pathname;
const FACT = "the-launch-code-is-4471";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const messages = async (s: Supervisor, thread: string) =>
  JSON.stringify(((await s.command(thread, { type: "get_messages" })).data as { messages: unknown[] }).messages);

test("oracle: a fact planted in thread A is absent from thread B; teardown of A frees A and leaves B", async () => {
  const events: [string, Record][] = [];
  const s = new Supervisor(() => ({ command: process.execPath, args: [fake] }), (t, r) => events.push([t, r]));
  try {
    assert.equal((await s.command("A", { type: "prompt", message: FACT })).success, true);
    await s.command("B", { type: "prompt", message: "what is the launch code?" });

    // Positive control: the fact reached A's session.
    assert.match(await messages(s, "A"), new RegExp(FACT));
    assert.doesNotMatch(await messages(s, "B"), new RegExp(FACT));

    // Two threads, two processes, each the one answering on its own pipes.
    const [a, b] = [s.pid("A")!, s.pid("B")!];
    assert.notEqual(a, b);
    for (const [t, pid] of [["A", a], ["B", b]] as const)
      assert.equal(((await s.command(t, { type: "get_state" })).data as { pid: number }).pid, pid);
    assert.match(readFileSync(`${record}/${a}.jsonl`, "utf8"), new RegExp(FACT));
    assert.doesNotMatch(readFileSync(`${record}/${b}.jsonl`, "utf8"), new RegExp(FACT));
    // Each process's events come back under its own thread.
    assert.deepEqual(events.map(([t, r]) => `${t}:${r.type}`), ["A:agent_settled", "B:agent_settled"]);

    await s.teardown("A");
    assert.equal(alive(a), false);
    assert.equal(s.pid("A"), undefined);
    assert.equal(alive(b), true);
    assert.match(await messages(s, "B"), /launch code/);

    // A's next message starts a fresh process with an empty session.
    assert.equal(await messages(s, "A"), "[]");
    assert.notEqual(s.pid("A"), a);
  } finally {
    await s.shutdown();
  }
});

test("a process that dies rejects its pending command and is respawned on the next", async () => {
  const s = new Supervisor(() => ({ command: process.execPath, args: [fake] }));
  try {
    await s.command("A", { type: "get_state" });
    const pid = s.pid("A")!;
    const pending = s.command("A", { type: "prompt", message: "x" }).catch((e: Error) => e);
    process.kill(pid, "SIGKILL");
    const got = await pending;
    // The kill may land after the fake answered; either way the process is gone and replaced.
    if (got instanceof Error) assert.match(got.message, /thread A: pi exited/);
    while (s.pid("A") === pid) await new Promise((r) => setTimeout(r, 10));
    assert.equal(await messages(s, "A"), "[]");
    assert.notEqual(s.pid("A"), pid);
  } finally {
    await s.shutdown();
  }
});

test("a launch that cannot start rejects rather than hanging", async () => {
  const s = new Supervisor(() => ({ command: "/nonexistent/pi", args: [] }));
  await assert.rejects(s.command("A", { type: "get_state" }), /thread A: pi failed/);
});
