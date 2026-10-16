// A thread's lifecycle (plan C4) as a state-machine table over a fake clock: the supervisor runs the
// recording fake pi (tests/fixtures/supervisor/fake-pi.ts) as real processes on P2's store, and each
// thread holds a real git worktree of a local bare mirror, keyed as P1 keys them. Run with
// `node --test tests/lifecycle.test.ts`; needs git on PATH.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { test } from "node:test";
import {
  CHECKIN_MS,
  type Clock,
  defaultCheckinPrompt,
  Lifecycle,
  QUESTION_TIMEOUT_MS,
  TurnController,
} from "../src/lifecycle/index.ts";
import { liveWorktree, mirrorKey } from "../src/mirror/index.ts";
import { ThreadStateStore } from "../src/state/index.ts";
import { Supervisor } from "../src/supervisor/index.ts";

const tmp = mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/genie-lifecycle-test-`);
process.env.PI_RECORD = tmp;
const fake = new URL("./fixtures/supervisor/fake-pi.ts", import.meta.url).pathname;
const mirror = { mirrorRoot: `${tmp}/mirrors`, worktreeRoot: `${tmp}/worktrees` };
const FACT = "the-launch-code-is-4471";
const H = 60 * 60 * 1000;
const T0 = Date.parse("2026-10-12T00:00:00Z");

const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
const sh = (args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { env, encoding: "utf8" });
sh(["init", "-q", "-b", "main", `${tmp}/src`]);
sh(["-C", `${tmp}/src`, "commit", "-q", "--allow-empty", "-m", "c"]);

// The thread's worktree of a mirror, where P1's worktreeFor puts it; returns the mirror.
function worktree(thread: string): string {
  const key = mirrorKey(`https://example.invalid/${thread}`);
  const m = `${mirror.mirrorRoot}/${key}`;
  sh(["clone", "-q", "--bare", `${tmp}/src`, m]);
  sh(["-C", m, "worktree", "add", "-q", "--detach", `${mirror.worktreeRoot}/${thread}/${key}`]);
  return m;
}

// Timers fire in deadline order as time advances, each awaited before the next.
class FakeClock implements Clock {
  t: number;
  private timers = new Map<number, { at: number; f: () => unknown }>();
  private n = 0;
  constructor(t: number) {
    this.t = t;
  }
  now = () => this.t;
  setTimeout = (f: () => unknown, ms: number) => (this.timers.set(++this.n, { at: this.t + ms, f }), this.n);
  clearTimeout = (id: unknown) => void this.timers.delete(id as number);
  async advance(ms: number) {
    const end = this.t + ms;
    // A timer that re-arms itself at the same instant would spin forever; fail it by name instead.
    for (let fired = 0; ; fired++) {
      if (fired > 1000) throw new Error("fake clock: timers keep firing without the clock moving");
      const [id, next] = [...this.timers].filter(([, x]) => x.at <= end).sort(([, a], [, b]) => a.at - b.at)[0] ?? [];
      if (!next) break;
      this.timers.delete(id!);
      this.t = next.at;
      await next.f();
    }
    this.t = end;
  }
}

// Threads in `hold` start pi with no turn ever settling, as a process that parks before its reply.
const hold = new Set<string>();
function boot(t: number) {
  const store = new ThreadStateStore(`${tmp}/state`, `${tmp}/store`);
  const clock = new FakeClock(t);
  let lc: Lifecycle;
  const supervisor = new Supervisor(
    (th) => ({ command: process.execPath, args: [fake, ...store.sessionArgs(th)], env: hold.has(th) ? { PI_SETTLE: "never" } : {} }),
    (th, r) => lc.event(th, r),
  );
  lc = new Lifecycle({ supervisor, store, mirror, clock, deeper: async () => {} });
  lc.start();
  // A message, then its turn settling (pi's event arrives on the pipe after the response), so the
  // clock does not move before the reply lands.
  const send = async (th: string, text: string) => {
    await lc.message(th, text);
    while (!hold.has(th) && store.pending(th).length) await new Promise((r) => setTimeout(r, 5));
  };
  return { store, clock, supervisor, lc, send, down: () => (lc.stop(), supervisor.shutdown()) };
}
const messages = async (s: Supervisor, thread: string) =>
  JSON.stringify(((await s.command(thread, { type: "get_messages" })).data as { messages: unknown[] }).messages);

test("oracle: active ⇒ parked at 1 h ⇒ resumed on a message with its context intact", async () => {
  const { clock, supervisor, send, down } = boot(T0);
  try {
    await send("t-park", FACT);
    const pid = supervisor.pid("t-park")!;
    await clock.advance(H - 1);
    assert.equal(supervisor.pid("t-park"), pid, "still active just before 1 h");
    await clock.advance(1);
    assert.equal(supervisor.pid("t-park"), undefined, "parked at 1 h");
    await send("t-park", "what was the code?");
    assert.notEqual(supervisor.pid("t-park"), pid);
    assert.match(await messages(supervisor, "t-park"), new RegExp(`${FACT}.*what was the code`));
  } finally {
    await down();
  }
});

test("oracle: a park before the first reply keeps the pending message, and the resume replays it", async () => {
  const { clock, supervisor, store, lc, send, down } = boot(T0);
  try {
    hold.add("t-early");
    await lc.message("t-early", FACT);
    await clock.advance(H);
    assert.equal(supervisor.pid("t-early"), undefined, "parked at 1 h with no reply");
    hold.delete("t-early");
    // Control: pi's session holds nothing of the first life; only the pending record does.
    assert.equal(existsSync(`${store.dir("t-early")}/session/thread.jsonl`), false);
    assert.deepEqual(store.pending("t-early"), [FACT]);
    await send("t-early", "are you there?");
    assert.match(await messages(supervisor, "t-early"), new RegExp(`${FACT}.*are you there`));
    assert.deepEqual(store.pending("t-early"), []);
  } finally {
    await down();
  }
});

// Each row: how the thread is closed, and the clock time it must still be open at.
const closes: [string, (lc: Lifecycle, clock: FakeClock, th: string) => Promise<void>][] = [
  ["accept", (lc, _, th) => lc.control(th, "accept")],
  [
    "24 h idle",
    async (_, clock, th) => {
      await clock.advance(24 * H - 1);
      assert.equal(store().read(th)!.status, "active", "still open just before 24 h");
      await clock.advance(1);
    },
  ],
];
const store = () => new ThreadStateStore(`${tmp}/state`, `${tmp}/store`);

test("oracle: accept and 24 h idle each close the thread and remove its worktrees", async () => {
  for (const [i, [why, close]] of closes.entries()) {
    const { clock, supervisor, lc, send, down } = boot(T0);
    const th = `t-close${i}`;
    try {
      const m = worktree(th);
      await send(th, FACT);
      assert.equal(liveWorktree(m), true, `${why}: control, the worktree pins its mirror`);
      await close(lc, clock, th);
      assert.equal(store().read(th)!.status, "closed", why);
      assert.equal(supervisor.pid(th), undefined, why);
      assert.equal(liveWorktree(m), false, `${why}: the mirror is unpinned`);
      assert.equal(existsSync(`${mirror.worktreeRoot}/${th}`), false, why);
      await assert.rejects(lc.message(th, "again"), /closed/, why);
    } finally {
      await down();
    }
  }
});

test("oracle: 🔍 does not close the thread: it stays open and its worktrees stay", async () => {
  const { supervisor, lc, send, down } = boot(T0);
  try {
    const m = worktree("t-deeper");
    await send("t-deeper", FACT);
    const pid = supervisor.pid("t-deeper");
    await lc.control("t-deeper", "deeper");
    assert.equal(store().read("t-deeper")!.status, "active");
    assert.equal(supervisor.pid("t-deeper"), pid);
    assert.equal(liveWorktree(m), true);
    await send("t-deeper", "and then?");
    assert.match(await messages(supervisor, "t-deeper"), new RegExp(`${FACT}.*and then`));
  } finally {
    await down();
  }
});

test("oracle: a supervisor restart mid-idle still closes on the original schedule", async () => {
  const first = boot(T0);
  const m = worktree("t-restart");
  await first.send("t-restart", FACT);
  await first.clock.advance(H / 2);
  await first.down();
  const { clock, lc, down } = boot(T0 + H / 2);
  try {
    await clock.advance(24 * H - H / 2 - 1);
    assert.equal(store().read("t-restart")!.status, "active", "still open just before 24 h");
    assert.equal(liveWorktree(m), true);
    await clock.advance(1);
    assert.equal(store().read("t-restart")!.status, "closed");
    assert.equal(liveWorktree(m), false);
  } finally {
    await down();
  }
});

const recordedPrompts = (pid: number) =>
  readFileSync(`${tmp}/${pid}.jsonl`, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.type === "prompt");

test("oracle: check-in fires once at 5m and turn continues until 10m deadline (C13 Oracle 1)", async () => {
  const { clock, supervisor, lc, down } = boot(T0);
  const th = "t-c13-oracle1";
  try {
    hold.add(th);
    await lc.message(th, FACT);
    const pid = supervisor.pid(th)!;
    assert.ok(pid !== undefined);

    // Just before 5m: no check-in yet
    await clock.advance(CHECKIN_MS - 1);
    assert.equal(lc.turnStatus(th).checkinFired, false);
    assert.equal(recordedPrompts(pid).length, 1);

    // At 5m (300_000 ms): check-in fires once via steer prompt
    await clock.advance(1);
    assert.equal(lc.turnStatus(th).checkinFired, true);
    assert.equal(lc.turnStatus(th).repliedAfterCheckin, false);
    const promptsAt5m = recordedPrompts(pid);
    assert.equal(promptsAt5m.length, 2);
    assert.equal(promptsAt5m[1].message, defaultCheckinPrompt());
    assert.equal(promptsAt5m[1].streamingBehavior, "steer");
    assert.equal(supervisor.pid(th), pid, "turn continues running after 5m check-in");

    // Just before 10m (600_000 ms): still only one check-in sent and process still alive
    await clock.advance(QUESTION_TIMEOUT_MS - CHECKIN_MS - 1);
    assert.equal(recordedPrompts(pid).length, 2, "check-in fires at most once per question");
    assert.equal(supervisor.pid(th), pid, "still running just before 10m deadline");

    // If tier 1 replies after the check-in (before 10m), disarm records repliedAfterCheckin
    lc.disarm(th);
    assert.deepEqual(lc.turnStatus(th), { checkinFired: true, repliedAfterCheckin: true });
    await clock.advance(1);
    assert.equal(supervisor.pid(th), pid, "disarmed turn is not torn down at 10m");
  } finally {
    hold.delete(th);
    await down();
  }
});

test("mutant (C13 Oracle 1): disabling the check-in timer makes Oracle 1 go RED", async () => {
  const clock = new FakeClock(T0);
  const checkins: string[] = [];
  // Mutant: checkinMs disabled (0)
  const mutantTurns = new TurnController({
    clock,
    checkinMs: 0,
    onCheckin: (_th, msg) => void checkins.push(msg),
    onDeadline: () => {},
  });
  mutantTurns.begin("t-mutant-1");
  await clock.advance(CHECKIN_MS);
  assert.throws(
    () => {
      assert.equal(mutantTurns.status("t-mutant-1").checkinFired, true);
      assert.equal(checkins.length, 1);
    },
    /AssertionError/,
    "mutant with disabled check-in timer must fail Oracle 1",
  );
  mutantTurns.stop();
});

test("oracle: fast question that replies before check-in time receives 0 check-in messages (C13 Oracle 2)", async () => {
  const { clock, supervisor, lc, down } = boot(T0);
  const th = "t-c13-oracle2";
  try {
    hold.add(th);
    await lc.message(th, FACT);
    const pid = supervisor.pid(th)!;

    // Reply arrives at 1m (before 5m check-in)
    await clock.advance(60_000);
    lc.disarm(th);

    // Advance past 5m check-in and 10m deadline
    await clock.advance(QUESTION_TIMEOUT_MS);
    assert.deepEqual(lc.turnStatus(th), { checkinFired: false, repliedAfterCheckin: false });
    assert.equal(recordedPrompts(pid).length, 1, "fast question must receive 0 check-in messages");
    assert.equal(recordedPrompts(pid)[0].message, FACT);
    assert.equal(supervisor.pid(th), pid, "completed turn is not torn down by 10m deadline");
  } finally {
    hold.delete(th);
    await down();
  }
});

test("mutant (C13 Oracle 2): failing to disarm on reply or firing check-in unconditionally makes Oracle 2 go RED", async () => {
  const clock = new FakeClock(T0);
  const checkins: string[] = [];
  const mutantTurns = new TurnController({
    clock,
    onCheckin: (_th, msg) => void checkins.push(msg),
    onDeadline: () => {},
  });
  mutantTurns.begin("t-mutant-2");
  await clock.advance(60_000);
  // Mutant: reply does not call disarm("t-mutant-2")
  await clock.advance(CHECKIN_MS);
  assert.throws(
    () => {
      assert.equal(checkins.length, 0, "expected 0 check-in messages for fast question");
    },
    /AssertionError/,
    "mutant that fails to disarm on reply must fail Oracle 2",
  );
  mutantTurns.stop();
});

