// Collection of an idle thread (plan P3, design §6): 96 hours after its `last_active`, whatever its
// status, a thread's transcript is handed to the archiver, then its worktrees, its Nix store root and
// its state directory are removed. C4 closes a thread at 24 h idle, so an open thread reaches 96 h
// only if its close never ran or failed; collection does not depend on it.
//
// Order: the archive is awaited first, and nothing is removed unless it succeeded. The state
// directory goes last, because it is how a thread is found: until it is gone the thread is still
// listed, still past its TTL, and collected again by the next sweep, so a failed removal is retried
// and never forgotten. What goes before it (worktrees, store) is recreated on demand by a resume.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { type Clock, systemClock } from "../lifecycle/index.ts";
import { type MirrorConfig, removeWorktrees } from "../mirror/index.ts";
import type { ThreadStateStore } from "../state/index.ts";

export const IDLE_TTL_MS = 96 * 60 * 60 * 1000;
export const SWEEP_MS = 60 * 60 * 1000;

// The TTL clock, shared with D3: whether an entry last active at lastActive has expired.
export const expired = (lastActive: string, clock: Clock, ttlMs = IDLE_TTL_MS): boolean =>
  clock.now() - Date.parse(lastActive) >= ttlMs;

export interface GcOptions {
  store: ThreadStateStore;
  mirror: Pick<MirrorConfig, "mirrorRoot" | "worktreeRoot">;
  // P4's archiver; a rejection keeps the thread whole for the next sweep.
  archive(thread: string): Promise<void>;
  clock?: Clock;
  ttlMs?: number;
  sweepMs?: number;
}

export class Gc {
  private o: GcOptions;
  private clock: Clock;
  private timer: unknown;

  constructor(o: GcOptions) {
    this.o = o;
    this.clock = o.clock ?? systemClock;
  }

  start(): void {
    this.timer = this.clock.setTimeout(() => this.sweep().catch((e) => console.error(`gc: ${e}`)).then(() => this.start()), this.o.sweepMs ?? SWEEP_MS);
  }

  stop(): void {
    this.clock.clearTimeout(this.timer);
  }

  // Collects every expired thread; one that fails is logged and left for the next sweep.
  async sweep(): Promise<void> {
    const { stateRoot } = this.o.store;
    for (const thread of existsSync(stateRoot) ? readdirSync(stateRoot).filter((t) => !t.startsWith(".")) : []) {
      await this.collect(thread).catch((e) => console.error(`gc ${thread}: ${e}`));
    }
  }

  private isExpired(thread: string): boolean {
    if (thread.startsWith(".")) return false;
    // A directory with no state.json carries no age and is left alone.
    if (!existsSync(`${this.o.store.stateRoot}/${thread}/state.json`)) return false;
    return expired(this.o.store.read(thread)!.last_active, this.clock, this.o.ttlMs);
  }

  private async collect(thread: string): Promise<void> {
    if (!this.isExpired(thread)) return;
    const st = this.o.store.read(thread);
    const tier = st?.sender_tier ?? "public";
    await this.o.archive(thread);
    // Write the tombstone right after archive PUT succeeds, before any rmSync.
    // If removal throws or crashes, the thread is tombstoned so next message resumes from archive.
    this.o.store.setTombstone(thread, { archived: true, tier });
    await removeWorktrees(this.o.mirror, thread);
    // A message that arrived during the awaits made the thread live again: keep its state.
    // ponytail: its worktrees are already gone and are re-added on demand; a per-thread lock with
    // C4 is owed if that ever costs more than a refetch.
    if (!this.isExpired(thread)) {
      this.o.store.clearTombstone(thread);
      return;
    }
    // Store paths are read-only; make them writable so the store can be deleted.
    const store = `${this.o.store.storeRoot}/${thread}`;
    if (existsSync(store)) execFileSync("chmod", ["-R", "u+w", store]);
    rmSync(store, { recursive: true, force: true });
    rmSync(`${this.o.store.stateRoot}/${thread}`, { recursive: true, force: true });
  }
}
