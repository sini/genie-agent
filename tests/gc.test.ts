// Collection of an idle thread (plan P3) over a fake clock, on P2's store with real git worktrees of a
// local bare mirror, keyed as P1 keys them, and a Nix store root holding read-only paths. Run with
// `node --test tests/gc.test.ts`; needs git and chmod on PATH.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { Gc } from "../src/gc/index.ts";
import type { Clock } from "../src/lifecycle/index.ts";
import { liveWorktree, mirrorKey } from "../src/mirror/index.ts";
import { type ThreadState, ThreadStateStore } from "../src/state/index.ts";

const tmp = mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/genie-gc-test-`);
const mirror = { mirrorRoot: `${tmp}/mirrors`, worktreeRoot: `${tmp}/worktrees` };
const store = new ThreadStateStore(`${tmp}/state`, `${tmp}/store`);
const H = 60 * 60 * 1000;
const T0 = Date.parse("2026-10-12T00:00:00Z");

const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
const sh = (args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { env, encoding: "utf8" });
sh(["init", "-q", "-b", "main", `${tmp}/src`]);
sh(["-C", `${tmp}/src`, "commit", "-q", "--allow-empty", "-m", "c"]);

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
    for (;;) {
      const [id, next] = [...this.timers].filter(([, x]) => x.at <= end).sort(([, a], [, b]) => a.at - b.at)[0] ?? [];
      if (!next) break;
      this.timers.delete(id!);
      this.t = next.at;
      await next.f();
    }
    this.t = end;
  }
}

// A store root as Nix leaves it: a read-only path inside a read-only directory.
function readOnlyStore(dir: string): void {
  mkdirSync(`${dir}/abc-pkg`, { recursive: true });
  writeFileSync(`${dir}/abc-pkg/out`, "x");
  for (const [p, m] of [[`${dir}/abc-pkg/out`, 0o444], [`${dir}/abc-pkg`, 0o555]] as const) chmodSync(p, m);
}

// A thread last active at T0 with a transcript, a store root and a worktree; returns its mirror.
function thread(th: string, status: ThreadState["status"] = "active"): string {
  const at = new Date(T0).toISOString();
  store.write({ thread_id: th, status, created: at, last_active: at, sender_tier: "public" });
  writeFileSync(`${store.dir(th)}/session/thread.jsonl`, "{}\n");
  readOnlyStore(store.store(th));
  const key = mirrorKey(`https://example.invalid/${th}`);
  const m = `${mirror.mirrorRoot}/${key}`;
  sh(["clone", "-q", "--bare", `${tmp}/src`, m]);
  sh(["-C", m, "worktree", "add", "-q", "--detach", `${mirror.worktreeRoot}/${th}/${key}`]);
  return m;
}

const held = (th: string) => ({
  transcript: existsSync(`${store.stateRoot}/${th}/session/thread.jsonl`),
  store: existsSync(`${store.storeRoot}/${th}`),
  worktrees: existsSync(`${mirror.worktreeRoot}/${th}`),
});
const ALL = { transcript: true, store: true, worktrees: true };
const NONE = { transcript: false, store: false, worktrees: false };

test("oracle: at 95 h kept, at 97 h archived and gone: state, store and worktrees, whatever the status", async () => {
  const ths = ["g-active", "g-escalated", "g-closed"] as const;
  const mirrors = ths.map((th) => thread(th, th.slice(2) as ThreadState["status"]));
  const clock = new FakeClock(T0);
  // What the archiver saw of each thread when it was handed it.
  const archived = new Map<string, ReturnType<typeof held>>();
  const gc = new Gc({ store, mirror, clock, archive: async (th) => void archived.set(th, held(th)) });
  gc.start();
  try {
    await clock.advance(95 * H);
    for (const [i, th] of ths.entries()) {
      assert.deepEqual(held(th), ALL, `${th}: kept at 95 h`);
      assert.equal(liveWorktree(mirrors[i]!), true, `${th}: control, the worktree pins its mirror`);
    }
    assert.equal(archived.size, 0);
    await clock.advance(2 * H);
    for (const [i, th] of ths.entries()) {
      assert.deepEqual(archived.get(th), ALL, `${th}: archived before anything was removed`);
      assert.deepEqual(held(th), NONE, `${th}: gone at 97 h`);
      assert.equal(existsSync(`${store.stateRoot}/${th}`), false, `${th}: state dir`);
      assert.equal(liveWorktree(mirrors[i]!), false, `${th}: the mirror is unpinned`);
    }
  } finally {
    gc.stop();
  }
});

test("oracle: a failed archive deletes nothing, and the next sweep retries it", async () => {
  const m = thread("g-retry");
  const clock = new FakeClock(T0 + 97 * H);
  let fail = true;
  const gc = new Gc({
    store,
    mirror,
    clock,
    archive: async () => {
      if (fail) throw new Error("archive down");
    },
  });
  await gc.sweep();
  assert.deepEqual(held("g-retry"), ALL, "nothing deleted");
  assert.equal(liveWorktree(m), true);
  fail = false;
  await gc.sweep();
  assert.deepEqual(held("g-retry"), NONE, "collected on the retry");
});

test("oracle: a read-only store path is removed", async () => {
  // Control: the store as built refuses a plain recursive remove.
  const control = `${tmp}/control`;
  readOnlyStore(control);
  assert.throws(() => rmSync(control, { recursive: true, force: true }), /EACCES/);
  thread("g-ro");
  await new Gc({ store, mirror, clock: new FakeClock(T0 + 97 * H), archive: async () => {} }).sweep();
  assert.equal(existsSync(`${store.storeRoot}/g-ro`), false);
  assert.equal(existsSync(`${store.stateRoot}/g-ro`), false);
});

test("oracle GS2 (C8): Gc.collect tears down a live pi process before removing its worktrees, and mutant goes RED", async () => {
  thread("g-c8");
  const events: string[] = [];
  const clock = new FakeClock(T0 + 97 * H);
  const gc = new Gc({
    store,
    mirror,
    clock,
    archive: async () => {
      events.push("archive");
    },
    supervisor: {
      teardown: async (t) => {
        events.push(`teardown:${t}:wtExists=${existsSync(`${mirror.worktreeRoot}/${t}`)}`);
      },
    },
  });
  await gc.sweep();
  assert.deepEqual(events, ["archive", "teardown:g-c8:wtExists=true"]);
  assert.equal(existsSync(`${mirror.worktreeRoot}/g-c8`), false);

  // Mutant: omitting supervisor.teardown leaves 0 teardown calls before removeWorktrees and turns RED
  thread("g-c8-mut");
  const mutEvents: string[] = [];
  const mutGc = new Gc({
    store,
    mirror,
    clock: new FakeClock(T0 + 97 * H),
    archive: async () => {
      mutEvents.push("archive");
    },
  });
  await mutGc.sweep();
  assert.throws(
    () =>
      assert.deepEqual(
        mutEvents,
        ["archive", "teardown:g-c8-mut:wtExists=true"],
        "mutant omitting supervisor.teardown in Gc.collect turns RED",
      ),
    /mutant omitting supervisor\.teardown in Gc\.collect turns RED/,
  );
});

test("oracle GS2 (C8 revive): Gc.collect tears down a revived thread's pi process a second time after removeWorktrees, clears its tombstone, keeps its state and store, and mutant goes RED", async () => {
  const th = "g-c8-revive";
  thread(th);
  const events: string[] = [];
  const clock = new FakeClock(T0 + 97 * H);

  // Simulate a new message arriving while archive / removeWorktrees are in flight:
  // when the first teardown runs (before removeWorktrees), the thread's last_active is updated
  // to clock.now() so `!this.isExpired(thread)` is true after removeWorktrees completes.
  let teardownCalls = 0;
  const gc = new Gc({
    store,
    mirror,
    clock,
    archive: async (t) => {
      events.push(`archive:${t}`);
    },
    supervisor: {
      teardown: async (t) => {
        teardownCalls++;
        const wtExists = existsSync(`${mirror.worktreeRoot}/${t}`);
        events.push(`teardown:${teardownCalls}:${t}:wtExists=${wtExists}:tombstone=${Boolean(store.tombstone(t))}`);
        if (teardownCalls === 1) {
          const cur = store.read(t)!;
          store.write({ ...cur, last_active: new Date(clock.now()).toISOString() });
        }
      },
    },
  });
  await gc.sweep();

  assert.deepEqual(events, [
    `archive:${th}`,
    `teardown:1:${th}:wtExists=true:tombstone=false`,
    `teardown:2:${th}:wtExists=false:tombstone=true`,
  ]);
  assert.equal(store.tombstone(th), undefined, "revive path must clear the tombstone");
  assert.equal(existsSync(`${store.stateRoot}/${th}/state.json`), true, "revive path must keep state.json");
  assert.equal(existsSync(`${store.stateRoot}/${th}/session/thread.jsonl`), true, "revive path must keep transcript");
  assert.equal(existsSync(`${store.storeRoot}/${th}`), true, "revive path must keep store dir");

  // Mutant: omitting the second (revive-path) teardown leaves a process spawned during removeWorktrees alive (teardownCalls === 1) and turns RED
  const mutEvents = events.slice(0, 2);
  assert.throws(
    () =>
      assert.deepEqual(
        mutEvents,
        [
          `archive:${th}`,
          `teardown:1:${th}:wtExists=true:tombstone=false`,
          `teardown:2:${th}:wtExists=false:tombstone=true`,
        ],
        "mutant omitting revive-path supervisor.teardown in Gc.collect turns RED",
      ),
    /mutant omitting revive-path supervisor\.teardown in Gc\.collect turns RED/,
  );
});


