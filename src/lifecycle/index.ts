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
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { type MirrorConfig, removeWorktrees } from "../mirror/index.ts";
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
export const QUESTION_TIMEOUT_MS = 10 * 60 * 1000;
export const CHECKIN_MS = 5 * 60 * 1000;

let cachedCheckinPrompt: string | undefined;
export function defaultCheckinPrompt(): string {
  if (cachedCheckinPrompt === undefined) {
    cachedCheckinPrompt = readFileSync(new URL("../../prompts/tier1-checkin.md", import.meta.url).pathname, "utf8").trim();
  }
  return cachedCheckinPrompt;
}

export interface TurnStatus {
  checkinFired: boolean;
  repliedAfterCheckin: boolean;
}

export interface TurnControllerOptions {
  clock?: Clock;
  questionTimeoutMs?: number;
  checkinMs?: number;
  checkinPrompt?: string;
  onCheckin: (thread: string, message: string) => Promise<unknown> | unknown;
  onDeadline: (thread: string) => Promise<unknown> | unknown;
}

interface TurnState {
  checkinTimer?: unknown;
  deadlineTimer?: unknown;
  checkinFired: boolean;
  repliedAfterCheckin: boolean;
  disarmed: boolean;
  settled: boolean;
}

export class TurnController {
  private states = new Map<string, TurnState>();
  private o: TurnControllerOptions;
  private clock: Clock;

  constructor(o: TurnControllerOptions) {
    this.o = o;
    this.clock = o.clock ?? systemClock;
  }

  begin(thread: string): void {
    this.clearTimers(thread);
    const state: TurnState = {
      checkinFired: false,
      repliedAfterCheckin: false,
      disarmed: false,
      settled: false,
    };
    this.states.set(thread, state);
    const timeoutMs = this.o.questionTimeoutMs ?? QUESTION_TIMEOUT_MS;
    const checkinMs = this.o.checkinMs ?? CHECKIN_MS;
    if (checkinMs > 0 && checkinMs < timeoutMs) {
      state.checkinTimer = this.clock.setTimeout(() => this.fireCheckin(thread), checkinMs);
    }
    if (timeoutMs > 0) {
      state.deadlineTimer = this.clock.setTimeout(() => this.fireDeadline(thread), timeoutMs);
    }
  }

  disarm(thread: string): void {
    const s = this.states.get(thread);
    if (!s) return;
    if (!s.disarmed) {
      s.disarmed = true;
      if (s.checkinFired) s.repliedAfterCheckin = true;
    }
    this.clearTimers(thread);
  }

  settle(thread: string): void {
    const s = this.states.get(thread);
    if (!s) return;
    s.settled = true;
    this.clearTimers(thread);
  }

  status(thread: string): TurnStatus {
    const s = this.states.get(thread);
    return {
      checkinFired: s?.checkinFired ?? false,
      repliedAfterCheckin: s?.repliedAfterCheckin ?? false,
    };
  }

  stop(): void {
    for (const thread of this.states.keys()) this.clearTimers(thread);
    this.states.clear();
  }

  private clearTimers(thread: string): void {
    const s = this.states.get(thread);
    if (!s) return;
    if (s.checkinTimer !== undefined) {
      this.clock.clearTimeout(s.checkinTimer);
      s.checkinTimer = undefined;
    }
    if (s.deadlineTimer !== undefined) {
      this.clock.clearTimeout(s.deadlineTimer);
      s.deadlineTimer = undefined;
    }
  }

  private async fireCheckin(thread: string): Promise<void> {
    const s = this.states.get(thread);
    if (!s || s.disarmed || s.settled || s.checkinFired) return;
    s.checkinFired = true;
    s.checkinTimer = undefined;
    const prompt = this.o.checkinPrompt ?? defaultCheckinPrompt();
    try {
      await this.o.onCheckin(thread, prompt);
    } catch (e) {
      console.error(`thread ${thread}: check-in failed: ${e}`);
    }
  }

  private async fireDeadline(thread: string): Promise<void> {
    const s = this.states.get(thread);
    if (!s || s.disarmed || s.settled) return;
    s.settled = true;
    this.clearTimers(thread);
    try {
      await this.o.onDeadline(thread);
    } catch (e) {
      console.error(`thread ${thread}: deadline failed: ${e}`);
    }
  }
}

export interface LifecycleOptions {
  supervisor: Supervisor;
  store: ThreadStateStore;
  mirror: Pick<MirrorConfig, "mirrorRoot" | "worktreeRoot">;
  // 🔍: escalate the thread's latest draft (C5's Escalation.deeper).
  deeper: (thread: string) => Promise<unknown>;
  clock?: Clock;
  parkMs?: number;
  closeMs?: number;
  questionTimeoutMs?: number;
  checkinMs?: number;
  checkinPrompt?: string;
  onDeadline?: (thread: string) => Promise<unknown> | unknown;
  replayResume?: (thread: string) => Promise<unknown>;
}

export class Lifecycle {
  private timers = new Map<string, unknown>();
  private turns: TurnController;
  private o: LifecycleOptions;
  private clock: Clock;

  constructor(o: LifecycleOptions) {
    this.o = o;
    this.clock = o.clock ?? systemClock;
    this.turns = new TurnController({
      clock: this.clock,
      questionTimeoutMs: o.questionTimeoutMs,
      checkinMs: o.checkinMs,
      checkinPrompt: o.checkinPrompt,
      onCheckin: async (thread, message) => {
        await this.o.supervisor.command(thread, { type: "prompt", message, streamingBehavior: "steer" });
      },
      onDeadline: async (thread) => {
        try {
          await this.o.onDeadline?.(thread);
        } finally {
          await this.o.supervisor.teardown(thread);
          this.arm(thread);
        }
      },
    });
  }

  // Arm every open thread from its stored state, on supervisor start.
  start(): void {
    if (!existsSync(this.o.store.stateRoot)) return;
    for (const thread of readdirSync(this.o.store.stateRoot)) this.arm(thread);
  }

  stop(): void {
    for (const t of this.timers.values()) this.clock.clearTimeout(t);
    this.timers.clear();
    this.turns.stop();
  }

  disarm(thread: string): void {
    this.turns.disarm(thread);
  }

  turnStatus(thread: string): TurnStatus {
    return this.turns.status(thread);
  }

  // A user message in the thread. A parked thread is resumed: pi starts on its session and is sent
  // the messages it never answered before this one. An expired thread with a tombstone is replayed from the archive first.
  async message(thread: string, text: string): Promise<void> {
    const { store, supervisor } = this.o;
    const tombstone = store.tombstone?.(thread);
    if (tombstone && supervisor.pid(thread) === undefined) {
      if (!this.o.replayResume) throw new Error(`thread ${thread}: tombstoned but replayResume is not configured`);
      const res = await this.o.replayResume(thread);
      if (!res) throw new Error(`thread ${thread}: tombstoned but archive not found`);
      store.clearTombstone?.(thread);
    }
    let st = store.read(thread);
    if (st?.status === "closed") throw new Error(`thread ${thread}: closed`);
    const now = new Date(this.clock.now()).toISOString();
    // A new thread enters at the public tier; C7 owns raising it.
    store.write({ thread_id: thread, status: "active", created: now, sender_tier: "public", ...st, last_active: now });
    const replay = supervisor.pid(thread) === undefined ? store.pending(thread) : [];
    store.setPending(thread, [...store.pending(thread), text]);
    this.turns.begin(thread);
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
    this.turns.settle(thread);
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
    this.turns.settle(thread);
    this.clock.clearTimeout(this.timers.get(thread));
    this.timers.delete(thread);
    await supervisor.teardown(thread);
    await removeWorktrees(mirror, thread);
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
