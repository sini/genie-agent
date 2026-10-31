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
  DEFAULT_MAX_CONCURRENT_TURNS,
  DEFAULT_MAX_QUEUE_WAIT_SECS,
  defaultCheckinPrompt,
  Lifecycle,
  MAX_QUEUE_WAIT_MS,
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

test("oracle: settling with 0 reply calls runs onDeadline once then settles; settling after disarm runs 0 (C13.1 Oracles a & b)", async () => {
  const store = new ThreadStateStore(`${tmp}/state`, `${tmp}/store`);
  const clock = new FakeClock(T0);
  const deadlines: string[] = [];
  let lc: Lifecycle;
  const supervisor = new Supervisor(
    (th) => ({ command: process.execPath, args: [fake, ...store.sessionArgs(th)], env: hold.has(th) ? { PI_SETTLE: "never" } : {} }),
    (th, r) => void lc.event(th, r),
  );
  lc = new Lifecycle({
    supervisor,
    store,
    mirror,
    clock,
    deeper: async () => {},
    onDeadline: (th) => void deadlines.push(th),
  });
  lc.start();
  try {
    // (a) Turn settles with 0 reply calls (never disarmed) -> onDeadline runs once, pending cleared
    const thA = "t-c131-a";
    hold.add(thA);
    await lc.message(thA, FACT);
    assert.deepEqual(store.pending(thA), [FACT]);
    await supervisor.command(thA, { type: "settle" });
    while (store.pending(thA).length) await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(deadlines, [thA], "settling with 0 reply calls must invoke onDeadline once");
    assert.deepEqual(store.pending(thA), [], "settle bookkeeping must still clear pending");

    // Advancing past 5m and 10m fires nothing more
    await clock.advance(QUESTION_TIMEOUT_MS);
    assert.deepEqual(deadlines, [thA]);

    // (b) Turn settles after reply (disarmed) -> onDeadline is not called
    const thB = "t-c131-b";
    hold.add(thB);
    await lc.message(thB, FACT);
    lc.disarm(thB);
    await supervisor.command(thB, { type: "settle" });
    while (store.pending(thB).length) await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(deadlines, [thA], "settling after disarm must not invoke onDeadline");
    assert.deepEqual(store.pending(thB), []);
  } finally {
    hold.delete("t-c131-a");
    hold.delete("t-c131-b");
    lc.stop();
    await supervisor.shutdown();
  }
});

test("mutant (C13.1 Oracles a & b): old settle path ignoring unanswered return value makes Oracle (a) go RED", () => {
  const clock = new FakeClock(T0);
  const turns = new TurnController({
    clock,
    onCheckin: () => {},
    onDeadline: () => {},
  });
  // Production: settle() returns true when never disarmed, false when disarmed
  turns.begin("t-unans");
  assert.equal(turns.settle("t-unans"), true);
  turns.begin("t-ans");
  turns.disarm("t-ans");
  assert.equal(turns.settle("t-ans"), false);

  // Mutant: old settle path treats settle() as void/false and never triggers onDeadline on agent_settled
  const mutantDeadlines: string[] = [];
  const oldSettleEvent = (th: string) => {
    turns.settle(th);
    // Old path omitted: if (unanswered) onDeadline(th)
  };
  turns.begin("t-mutant-old");
  oldSettleEvent("t-mutant-old");
  assert.throws(
    () => {
      assert.deepEqual(mutantDeadlines, ["t-mutant-old"]);
    },
    /AssertionError/,
    "old settle path must fail C13.1 Oracle (a) RED",
  );
  turns.stop();
});

test("oracle (GL1 cap): a burst of 5 runs at most 2 turns concurrently", async () => {
  assert.equal(DEFAULT_MAX_CONCURRENT_TURNS, 2);
  const storeInst = new ThreadStateStore(`${tmp}/state-cap`, `${tmp}/store-cap`);
  const clock = new FakeClock(T0);
  let lc!: Lifecycle;
  const supervisor = new Supervisor(
    (th) => ({ command: process.execPath, args: [fake, ...storeInst.sessionArgs(th)], env: { PI_SETTLE: "never" } }),
    (th, r) => void lc.event(th, r),
  );
  lc = new Lifecycle({
    supervisor,
    store: storeInst,
    mirror,
    clock,
    deeper: async () => {},
  });
  lc.start();
  const threads = ["t-cap-1", "t-cap-2", "t-cap-3", "t-cap-4", "t-cap-5"];
  let maxActive = 0;
  try {
    for (const th of threads) {
      await lc.message(th, FACT);
      maxActive = Math.max(maxActive, lc.activeTurns().length, supervisor.threads().length);
    }
    const initialActive = lc.activeTurns();
    const initialQueued = lc.queuedThreads();
    for (const th of threads) {
      maxActive = Math.max(maxActive, lc.activeTurns().length);
      lc.disarm(th);
      await supervisor.command(th, { type: "settle" });
      while (storeInst.pending(th).length) await new Promise((r) => setTimeout(r, 5));
      maxActive = Math.max(maxActive, lc.activeTurns().length);
    }
    assert.equal(maxActive, 2, "at most 2 turns may run concurrently during a burst of 5");
    assert.deepEqual(initialActive, ["t-cap-1", "t-cap-2"]);
    assert.deepEqual(initialQueued, ["t-cap-3", "t-cap-4", "t-cap-5"]);
  } finally {
    lc.stop();
    await supervisor.shutdown();
  }
});

test("oracle (GL1 FIFO): queued turns acquire slots in strict FIFO arrival order", async () => {
  const storeInst = new ThreadStateStore(`${tmp}/state-order-fifo`, `${tmp}/store-order-fifo`);
  const clock = new FakeClock(T0);
  let lc!: Lifecycle;
  const supervisor = new Supervisor(
    (th) => ({ command: process.execPath, args: [fake, ...storeInst.sessionArgs(th)], env: { PI_SETTLE: "never" } }),
    (th, r) => void lc.event(th, r),
  );
  lc = new Lifecycle({
    supervisor,
    store: storeInst,
    mirror,
    clock,
    maxConcurrentTurns: 2,
    deeper: async () => {},
  });
  lc.start();
  const acquired: string[] = [];
  try {
    // Occupy both slots with t1 and t2
    await lc.message("t-ord-1", "q1");
    await lc.message("t-ord-2", "q2");
    assert.deepEqual(lc.activeTurns(), ["t-ord-1", "t-ord-2"]);

    // Queue t3, t4, t5 in arrival order
    for (const th of ["t-ord-3", "t-ord-4", "t-ord-5"]) {
      await lc.message(th, `question for ${th}`);
      assert.equal(supervisor.pid(th), undefined, `${th} must not spawn while queued`);
    }
    assert.deepEqual(lc.queuedThreads(), ["t-ord-3", "t-ord-4", "t-ord-5"]);

    // Release slots one by one and record which queued thread acquires each freed slot
    for (const finisher of ["t-ord-1", "t-ord-2"]) {
      const before = new Set(lc.activeTurns());
      lc.disarm(finisher);
      await supervisor.command(finisher, { type: "settle" });
      while (storeInst.pending(finisher).length) await new Promise((r) => setTimeout(r, 5));
      for (const a of lc.activeTurns()) {
        if (!before.has(a) && !acquired.includes(a)) acquired.push(a);
      }
    }
    // Settle the first acquired thread to release the slot for the last queued thread
    const thirdFinisher = acquired[0]!;
    const beforeLast = new Set(lc.activeTurns());
    lc.disarm(thirdFinisher);
    await supervisor.command(thirdFinisher, { type: "settle" });
    while (storeInst.pending(thirdFinisher).length) await new Promise((r) => setTimeout(r, 5));
    for (const a of lc.activeTurns()) {
      if (!beforeLast.has(a) && !acquired.includes(a)) acquired.push(a);
    }
    assert.deepEqual(acquired, ["t-ord-3", "t-ord-4", "t-ord-5"]);
  } finally {
    lc.stop();
    await supervisor.shutdown();
  }
});

test("oracle (GL1 timer at acquisition): the 600s TurnController timer starts when a turn acquires its slot, not at intake", async () => {
  const storeInst = new ThreadStateStore(`${tmp}/state-timer-acq`, `${tmp}/store-timer-acq`);
  const clock = new FakeClock(T0);
  const deadlines: { thread: string; at: number }[] = [];
  let lc!: Lifecycle;
  const supervisor = new Supervisor(
    (th) => ({ command: process.execPath, args: [fake, ...storeInst.sessionArgs(th)], env: { PI_SETTLE: "never" } }),
    (th, r) => void lc.event(th, r),
  );
  lc = new Lifecycle({
    supervisor,
    store: storeInst,
    mirror,
    clock,
    maxConcurrentTurns: 2,
    maxQueueWaitSecs: 180,
    deeper: async () => {},
    onDeadline: (th) => void deadlines.push({ thread: th, at: clock.now() }),
  });
  lc.start();
  try {
    // At T0: t1 and t2 occupy both slots; t3 arrives at T0 and enters the queue
    await lc.message("t-acq-1", "q1");
    await lc.message("t-acq-2", "q2");
    await lc.message("t-acq-3", "q3");
    assert.equal(supervisor.pid("t-acq-3"), undefined);

    // Wait 120s in the queue (< 180s maxQueueWaitSecs)
    const waitMs = 120_000;
    await clock.advance(waitMs);
    assert.equal(supervisor.pid("t-acq-3"), undefined, "still queued at T0 + 120s");

    // At T0 + 120s: t1 settles, so t3 acquires its slot at T0 + 120s
    lc.disarm("t-acq-1");
    await supervisor.command("t-acq-1", { type: "settle" });
    while (storeInst.pending("t-acq-1").length) await new Promise((r) => setTimeout(r, 5));
    const pid3 = supervisor.pid("t-acq-3")!;
    assert.ok(pid3 !== undefined, "t3 acquired slot and spawned pi at T0 + 120s");

    // Settle t2 as well so we isolate t3's timers
    lc.disarm("t-acq-2");
    await supervisor.command("t-acq-2", { type: "settle" });
    while (storeInst.pending("t-acq-2").length) await new Promise((r) => setTimeout(r, 5));

    // At T0 + 300s (300s since intake, but only 180s since slot acquisition): check-in must NOT have fired
    await clock.advance(CHECKIN_MS - waitMs);
    assert.equal(clock.now(), T0 + CHECKIN_MS);
    assert.equal(lc.turnStatus("t-acq-3").checkinFired, false, "check-in must not fire 300s after intake");
    assert.equal(recordedPrompts(pid3).length, 1);

    // At T0 + 120s + 300s = T0 + 420s: check-in fires at 300s after slot acquisition
    await clock.advance(waitMs);
    assert.equal(clock.now(), T0 + waitMs + CHECKIN_MS);
    assert.equal(lc.turnStatus("t-acq-3").checkinFired, true, "check-in must fire 300s after slot acquisition");
    assert.equal(recordedPrompts(pid3).length, 2);

    // At T0 + 600s (600s since intake, but only 480s since slot acquisition): deadline must NOT have fired
    await clock.advance(QUESTION_TIMEOUT_MS - CHECKIN_MS - waitMs);
    assert.equal(clock.now(), T0 + QUESTION_TIMEOUT_MS);
    assert.deepEqual(deadlines, [], "queued turn must NOT time out 600s after intake");
    assert.equal(supervisor.pid("t-acq-3"), pid3, "t3 must still be running at T0 + 600s");

    // At T0 + 120s + 600s = T0 + 720s: 600s deadline fires at 600s after slot acquisition
    await clock.advance(waitMs);
    assert.equal(clock.now(), T0 + waitMs + QUESTION_TIMEOUT_MS);
    assert.deepEqual(deadlines, [{ thread: "t-acq-3", at: T0 + waitMs + QUESTION_TIMEOUT_MS }]);
    assert.equal(supervisor.pid("t-acq-3"), undefined, "t3 torn down at T0 + 120s + 600s");
  } finally {
    lc.stop();
    await supervisor.shutdown();
  }
});

test("oracle (GL1 escalate-not-drop): a queued turn waiting past maxQueueWaitSecs fast-escalates and is never dropped", async () => {
  assert.equal(DEFAULT_MAX_QUEUE_WAIT_SECS, 180);
  assert.equal(MAX_QUEUE_WAIT_MS, 180_000);
  const storeInst = new ThreadStateStore(`${tmp}/state-qwait`, `${tmp}/store-qwait`);
  const clock = new FakeClock(T0);
  const fastEscalated: { thread: string; at: number; note: string }[] = [];
  let lc!: Lifecycle;
  const supervisor = new Supervisor(
    (th) => ({ command: process.execPath, args: [fake, ...storeInst.sessionArgs(th)], env: { PI_SETTLE: "never" } }),
    (th, r) => void lc.event(th, r),
  );
  lc = new Lifecycle({
    supervisor,
    store: storeInst,
    mirror,
    clock,
    maxConcurrentTurns: 2,
    maxQueueWaitSecs: 180,
    deeper: async () => {},
    onQueueTimeout: (th) => {
      fastEscalated.push({ thread: th, at: clock.now(), note: "tier-1 busy" });
      const st = storeInst.read(th);
      if (st) storeInst.write({ ...st, status: "escalated" });
    },
  });
  lc.start();
  try {
    await lc.message("t-qw-1", "q1");
    await lc.message("t-qw-2", "q2");
    await lc.message("t-qw-3", "q3");
    assert.deepEqual(lc.queuedThreads(), ["t-qw-3"]);

    // Just before 180s: still waiting in queue
    await clock.advance(MAX_QUEUE_WAIT_MS - 1);
    assert.deepEqual(fastEscalated, []);
    assert.deepEqual(lc.queuedThreads(), ["t-qw-3"]);

    // At 180s: queue-wait fast-escalation fires once with "tier-1 busy", clearing pending and removing from queue
    await clock.advance(1);
    assert.deepEqual(fastEscalated, [{ thread: "t-qw-3", at: T0 + MAX_QUEUE_WAIT_MS, note: "tier-1 busy" }]);
    assert.deepEqual(lc.queuedThreads(), []);
    assert.deepEqual(storeInst.pending("t-qw-3"), []);
    assert.equal(storeInst.read("t-qw-3")?.status, "escalated");
    assert.equal(supervisor.pid("t-qw-3"), undefined);

    // When t-qw-1 settles later, t-qw-3 is not started on tier-1 (already escalated)
    lc.disarm("t-qw-1");
    await supervisor.command("t-qw-1", { type: "settle" });
    while (storeInst.pending("t-qw-1").length) await new Promise((r) => setTimeout(r, 5));
    assert.equal(supervisor.pid("t-qw-3"), undefined);
  } finally {
    lc.stop();
    await supervisor.shutdown();
  }
});
