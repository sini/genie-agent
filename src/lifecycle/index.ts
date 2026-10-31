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
export const DEFAULT_MAX_CONCURRENT_TURNS = 2;
export const DEFAULT_MAX_QUEUE_WAIT_SECS = 180;
export const MAX_QUEUE_WAIT_MS = DEFAULT_MAX_QUEUE_WAIT_SECS * 1000;

import { pathToFileURL } from "node:url";

const repo = process.env.GENIE_REPO_ROOT
  ? pathToFileURL(`${process.env.GENIE_REPO_ROOT}/`)
  : import.meta.url
    ? new URL("../../", import.meta.url)
    : pathToFileURL(`${process.cwd()}/`);

let cachedCheckinPrompt: string | undefined;
export function defaultCheckinPrompt(): string {
  if (cachedCheckinPrompt === undefined) {
    cachedCheckinPrompt = readFileSync(new URL("prompts/tier1-checkin.md", repo).pathname, "utf8").trim();
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

  settle(thread: string): boolean {
    const s = this.states.get(thread);
    if (!s) return false;
    const unanswered = !s.disarmed && !s.settled;
    s.settled = true;
    this.clearTimers(thread);
    return unanswered;
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
  maxConcurrentTurns?: number;
  maxQueueWaitSecs?: number;
  queueOrder?: "fifo" | "lifo";
  onDeadline?: (thread: string) => Promise<unknown> | unknown;
  onQueueTimeout?: (thread: string) => Promise<unknown> | unknown;
  replayResume?: (thread: string) => Promise<unknown>;
  resync?: (thread: string) => Promise<string | void>;
}

interface QueuedTurn {
  thread: string;
  messages: string[];
  timer?: unknown;
}

export class Lifecycle {
  private timers = new Map<string, unknown>();
  private seenThreads = new Set<string>();
  private activeSlots = new Set<string>();
  private dispatching = new Set<string>();
  private queue: QueuedTurn[] = [];
  private turns: TurnController;
  private o: LifecycleOptions;
  private clock: Clock;
  private maxConcurrentTurns: number;
  private maxQueueWaitMs: number;

  constructor(o: LifecycleOptions) {
    this.o = o;
    this.clock = o.clock ?? systemClock;
    this.maxConcurrentTurns = o.maxConcurrentTurns ?? DEFAULT_MAX_CONCURRENT_TURNS;
    this.maxQueueWaitMs = (o.maxQueueWaitSecs ?? DEFAULT_MAX_QUEUE_WAIT_SECS) * 1000;
    const origTeardown = this.o.supervisor.teardown.bind(this.o.supervisor);
    this.o.supervisor.teardown = async (thread: string) => {
      this.removeQueued(thread);
      this.dispatching.delete(thread);
      this.turns.settle(thread);
      await origTeardown(thread);
      await this.releaseSlot(thread);
    };
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
    for (const thread of readdirSync(this.o.store.stateRoot)) {
      this.seenThreads.add(thread);
      this.arm(thread);
    }
  }

  stop(): void {
    for (const t of this.timers.values()) this.clock.clearTimeout(t);
    this.timers.clear();
    for (const q of this.queue) {
      if (q.timer !== undefined) this.clock.clearTimeout(q.timer);
    }
    this.queue = [];
    this.activeSlots.clear();
    this.dispatching.clear();
    this.turns.stop();
  }

  activeTurns(): string[] {
    return [...this.activeSlots];
  }

  queuedThreads(): string[] {
    return this.queue.map((q) => q.thread);
  }

  disarm(thread: string): void {
    this.turns.disarm(thread);
  }

  turnStatus(thread: string): TurnStatus {
    return this.turns.status(thread);
  }

  // A user message in the thread. A parked thread is resumed: pi starts on its session and is sent
  // the messages it never answered before this one. An expired thread with a tombstone is replayed from the archive first.
  // When a thread restarts with missing or corrupted local session state, resyncs from matrix-xmsg first (GI-8, §5.3).
  // Under GL1, at most `maxConcurrentTurns` (default 2) tier-1 turns run concurrently; excess turns wait in a
  // strict FIFO queue, starting their 600 s TurnController timer at slot acquisition, or fast-escalate after
  // `maxQueueWaitSecs` (default 180 s).
  async message(thread: string, text: string, opts?: { isDelta?: boolean; hadState?: boolean }): Promise<void> {
    const { store, supervisor } = this.o;
    const tombstone = store.tombstone?.(thread);
    if (tombstone && supervisor.pid(thread) === undefined) {
      if (!this.o.replayResume) throw new Error(`thread ${thread}: tombstoned but replayResume is not configured`);
      const res = await this.o.replayResume(thread);
      if (!res) throw new Error(`thread ${thread}: tombstoned but archive not found`);
      store.clearTombstone?.(thread);
    }
    const isRunning = supervisor.pid(thread) !== undefined;
    const existingQueued = this.queue.find((q) => q.thread === thread);
    const sessionFile = `${store.stateRoot}/${thread}/session/thread.jsonl`;
    const stateFile = `${store.stateRoot}/${thread}/state.json`;
    const hadState = opts?.hadState ?? existsSync(stateFile);
    const isRestart = !isRunning && !existingQueued && (hadState || this.seenThreads.has(thread) || Boolean(opts?.isDelta));
    let hasState = false;
    if (existsSync(sessionFile) && existsSync(stateFile)) {
      try {
        const rawSession = readFileSync(sessionFile, "utf8").trim();
        if (rawSession.length > 0) {
          for (const line of rawSession.split("\n")) {
            JSON.parse(line);
          }
          JSON.parse(readFileSync(stateFile, "utf8"));
          hasState = true;
        }
      } catch {
        hasState = false;
      }
    }
    this.seenThreads.add(thread);

    const st = store.read(thread);
    if (st?.status === "closed") throw new Error(`thread ${thread}: closed`);

    let resyncedText: string | undefined;
    if (isRestart && !hasState && this.o.resync) {
      const r = await this.o.resync(thread);
      if (typeof r === "string" && r.length > 0) {
        resyncedText = r;
      }
      store.setPending(thread, []);
    }

    const now = new Date(this.clock.now()).toISOString();
    // A new thread enters at the public tier; C7 owns raising it.
    store.write({ thread_id: thread, status: "active", created: now, sender_tier: "public", ...st, last_active: now });
    const replay = !isRunning && !existingQueued ? store.pending(thread) : [];
    const toSend = [...(resyncedText !== undefined ? [resyncedText] : replay), text];
    store.setPending(thread, [...store.pending(thread), ...(resyncedText !== undefined ? [resyncedText] : []), text]);

    if (existingQueued) {
      existingQueued.messages.push(...toSend);
      this.arm(thread);
      return;
    }

    if (this.activeSlots.has(thread) || this.activeSlots.size < this.maxConcurrentTurns) {
      this.activeSlots.add(thread);
      await this.dispatchSlot(thread, toSend);
      return;
    }

    const entry: QueuedTurn = { thread, messages: toSend };
    if (this.maxQueueWaitMs > 0) {
      entry.timer = this.clock.setTimeout(() => this.fireQueueTimeout(thread), this.maxQueueWaitMs);
    }
    this.queue.push(entry);
    this.arm(thread);
  }

  private async dispatchSlot(thread: string, toSend: string[]): Promise<void> {
    this.turns.begin(thread);
    let ok = false;
    try {
      // followUp: pi queues a prompt sent while a turn runs instead of refusing it.
      for (let i = 0; i < toSend.length; i++) {
        if (i < toSend.length - 1) this.dispatching.add(thread);
        else this.dispatching.delete(thread);
        await this.o.supervisor.command(thread, { type: "prompt", message: toSend[i], streamingBehavior: "followUp" });
      }
      ok = true;
    } finally {
      this.dispatching.delete(thread);
      this.arm(thread);
      if (!ok && this.o.supervisor.pid(thread) === undefined) {
        this.turns.settle(thread);
        await this.releaseSlot(thread);
      }
    }
  }

  private async releaseSlot(thread: string): Promise<void> {
    this.activeSlots.delete(thread);
    while (this.activeSlots.size < this.maxConcurrentTurns && this.queue.length > 0) {
      const next = this.o.queueOrder === "lifo" ? this.queue.pop()! : this.queue.shift()!;
      if (next.timer !== undefined) {
        this.clock.clearTimeout(next.timer);
        next.timer = undefined;
      }
      const st = this.o.store.read(next.thread);
      if (!st || st.status === "closed") continue;
      this.activeSlots.add(next.thread);
      try {
        await this.dispatchSlot(next.thread, next.messages);
      } catch (e) {
        console.error(`thread ${next.thread}: queued turn dispatch failed: ${e}`);
      }
    }
  }

  private removeQueued(thread: string): QueuedTurn | undefined {
    const idx = this.queue.findIndex((q) => q.thread === thread);
    if (idx < 0) return undefined;
    const [entry] = this.queue.splice(idx, 1);
    if (entry.timer !== undefined) {
      this.clock.clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    return entry;
  }

  private async fireQueueTimeout(thread: string): Promise<void> {
    const entry = this.removeQueued(thread);
    if (!entry) return;
    const st0 = this.o.store.read(thread);
    if (!st0 || st0.status === "closed") return;
    this.o.store.setPending(thread, []);
    try {
      await this.o.onQueueTimeout?.(thread);
    } catch (e) {
      console.error(`thread ${thread}: queue timeout failed: ${e}`);
    }
    const st = this.o.store.read(thread);
    if (!st || st.status === "closed") return;
    this.o.store.write({ ...st, last_active: new Date(this.clock.now()).toISOString() });
    this.arm(thread);
  }

  // The supervisor's onEvent: a settled turn is the thread's reply, and pi has written its session.
  // When a turn settles whose controller was never disarmed by entry to reply/escalate, run the same
  // onDeadline action (notice + escalation) and then the existing settle bookkeeping (C13.1).
  async event(thread: string, r: Record): Promise<void> {
    if (r.type !== "agent_settled") return;
    if (this.dispatching.has(thread)) return;
    const unanswered = this.turns.settle(thread);
    try {
      const st0 = this.o.store.read(thread);
      if (!st0 || st0.status === "closed") return;
      if (unanswered) {
        try {
          await this.o.onDeadline?.(thread);
        } catch (e) {
          console.error(`thread ${thread}: deadline failed: ${e}`);
        }
      }
      const st = this.o.store.read(thread);
      if (!st || st.status === "closed") return;
      this.o.store.write({ ...st, last_active: new Date(this.clock.now()).toISOString() });
      this.arm(thread);
    } finally {
      await this.releaseSlot(thread);
      const st = this.o.store.read(thread);
      if (st && st.status !== "closed") {
        this.o.store.setPending(thread, []);
      }
    }
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
    this.removeQueued(thread);
    this.dispatching.delete(thread);
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
