// A tier-1 thread's lifecycle (plan C4, design rows 8 and 21, §4 step 7). One hour after the
// thread's last activity its pi process exits (parked), and the next message starts a fresh one
// on P2's session (resumed). Accept (✅) from the bot (M5a) or 24 hours idle closes it (row 21): the
// process is torn down, every worktree the thread holds is removed from its mirror, which unpins
// the mirror for P7's eviction, and its P2 status becomes `closed`.
//
// Parked is not a stored status: a thread whose status is not `closed` and that has no process is
// parked. Deadlines are never held only in memory. Each timer is a wakeup that rereads P2's
// `last_active`, and `start` re-arms every open thread from disk, so a restart parks and closes on
// the original schedule.
//
// pi writes its session only once a turn settles (P2), so a message sent to a process that parks
// before its reply would be lost. Every message is persisted as pending before it is sent and
// cleared when pi's turn settles; a resume replays what is pending ahead of the new message.
import { existsSync, readdirSync, rmSync } from "node:fs";
import { git, type MirrorConfig } from "../mirror/index.ts";
import type { ThreadStateStore } from "../state/index.ts";
import type { Record, Supervisor } from "../supervisor/index.ts";

export interface Clock {
  now(): number;
  // f may return a promise; a fake clock awaits it, the system clock does not.
  setTimeout(f: () => unknown, ms: number): unknown;
  clearTimeout(t: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (f, ms) => setTimeout(f, ms),
  clearTimeout: (t) => clearTimeout(t as number),
};

export const PARK_MS = 60 * 60 * 1000;
export const CLOSE_MS = 24 * 60 * 60 * 1000;

export interface LifecycleOptions {
  supervisor: Supervisor;
  store: ThreadStateStore;
  mirror: Pick<MirrorConfig, "mirrorRoot" | "worktreeRoot">;
  // 🔍: escalate the thread's latest draft (C5's Escalation.deeper).
  deeper: (thread: string) => Promise<unknown>;
  clock?: Clock;
  parkMs?: number;
  closeMs?: number;
}

export class Lifecycle {
  private timers = new Map<string, unknown>();
  private o: LifecycleOptions;
  private clock: Clock;

  constructor(o: LifecycleOptions) {
    this.o = o;
    this.clock = o.clock ?? systemClock;
  }

  // Arm every open thread from its stored state, on supervisor start.
  start(): void {
    if (!existsSync(this.o.store.stateRoot)) return;
    for (const thread of readdirSync(this.o.store.stateRoot)) this.arm(thread);
  }

  stop(): void {
    for (const t of this.timers.values()) this.clock.clearTimeout(t);
    this.timers.clear();
  }

  // A user message in the thread. A parked thread is resumed: pi starts on its session and is sent
  // the messages it never answered before this one.
  async message(thread: string, text: string): Promise<void> {
    const { store, supervisor } = this.o;
    const st = store.read(thread);
    if (st?.status === "closed") throw new Error(`thread ${thread}: closed`);
    const now = new Date(this.clock.now()).toISOString();
    // A new thread enters at the public tier; C7 owns raising it.
    store.write({ thread_id: thread, status: "active", created: now, sender_tier: "public", ...st, last_active: now });
    const replay = supervisor.pid(thread) === undefined ? store.pending(thread) : [];
    store.setPending(thread, [...store.pending(thread), text]);
    try {
      // followUp: pi queues a prompt sent while a turn runs instead of refusing it.
      for (const message of [...replay, text]) await supervisor.command(thread, { type: "prompt", message, streamingBehavior: "followUp" });
    } finally {
      this.arm(thread);
    }
  }

  // The supervisor's onEvent: a settled turn is the thread's reply, and pi has written its session.
  event(thread: string, r: Record): void {
    if (r.type !== "agent_settled") return;
    const st = this.o.store.read(thread);
    if (!st || st.status === "closed") return;
    this.o.store.write({ ...st, last_active: new Date(this.clock.now()).toISOString() });
    this.o.store.setPending(thread, []);
    this.arm(thread);
  }

  // A thread control from the bot (M5a). ✅ accepts and closes the thread. 🔍 escalates (C5): the
  // expert's answer returns into this thread (§4 step 6), so it stays open.
  async control(thread: string, c: "accept" | "deeper"): Promise<void> {
    if (c === "accept") await this.close(thread);
    else await this.o.deeper(thread);
  }

  // Accept or 24 hours idle. On a failure the status stays open, and the next `start` retries.
  async close(thread: string): Promise<void> {
    const { store, supervisor, mirror } = this.o;
    this.clock.clearTimeout(this.timers.get(thread));
    this.timers.delete(thread);
    await supervisor.teardown(thread);
    // P1 keys a thread's worktrees as <worktreeRoot>/<thread>/<mirror key>, its mirror at
    // <mirrorRoot>/<mirror key>.
    const dir = `${mirror.worktreeRoot}/${thread}`;
    for (const key of existsSync(dir) ? readdirSync(dir) : []) {
      const m = `${mirror.mirrorRoot}/${key}`;
      if (existsSync(m)) await git(["-C", m, "worktree", "remove", "--force", `${dir}/${key}`]);
      else rmSync(`${dir}/${key}`, { recursive: true, force: true });
    }
    rmSync(dir, { recursive: true, force: true });
    const st = store.read(thread);
    if (st) store.write({ ...st, status: "closed" });
  }

  // One timer per open thread, at its next deadline: park while it has a process, else close.
  private arm(thread: string): void {
    this.clock.clearTimeout(this.timers.get(thread));
    this.timers.delete(thread);
    const st = this.o.store.read(thread);
    if (!st || st.status === "closed") return;
    const last = Date.parse(st.last_active);
    const due = last + (this.o.supervisor.pid(thread) !== undefined ? (this.o.parkMs ?? PARK_MS) : (this.o.closeMs ?? CLOSE_MS));
    this.timers.set(
      thread,
      this.clock.setTimeout(() => this.due(thread).catch((e) => console.error(`thread ${thread}: ${e}`)), Math.max(0, due - this.clock.now())),
    );
  }

  private async due(thread: string): Promise<void> {
    this.timers.delete(thread);
    const st = this.o.store.read(thread);
    if (!st || st.status === "closed") return;
    const idle = this.clock.now() - Date.parse(st.last_active);
    if (idle >= (this.o.closeMs ?? CLOSE_MS)) return this.close(thread);
    if (idle >= (this.o.parkMs ?? PARK_MS)) await this.o.supervisor.teardown(thread);
    this.arm(thread);
  }
}
