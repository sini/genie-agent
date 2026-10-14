// Dispatcher park and GC (plan D3, design §5.8 Talk and Park, §6):
// `pane close` runs under D1b's park predicate; at 96h idle, the transcript goes to the
// archiver (I17) and the entry is dropped, reusing P3's TTL clock.
import { existsSync, rmSync } from "node:fs";
import { type Clock, systemClock } from "./clock.ts";
import type { Dispatcher } from "./index.ts";
import type { Delivery } from "./delivery.ts";
import type { Thread } from "./journal.ts";

export const IDLE_TTL_MS = 96 * 60 * 60 * 1000;
export const SWEEP_MS = 60 * 60 * 1000;

// The TTL clock, shared with P3: whether an entry last active at lastActive has expired.
export const expired = (lastActive: string | number, clock: Clock, ttlMs = IDLE_TTL_MS): boolean =>
  clock.now() - (typeof lastActive === "number" ? lastActive : Date.parse(lastActive)) >= ttlMs;

export interface DispatcherGcOptions {
  dispatcher: Dispatcher;
  delivery: Delivery;
  // Archiver handoff: receiving thread id and session uuid (transcript name)
  archive: (threadId: string, session: string) => Promise<void>;
  clock?: Clock;
  ttlMs?: number;
  sweepMs?: number;
  idleMs?: number;
}

export class DispatcherGc {
  private readonly d: Dispatcher;
  private readonly del: Delivery;
  private readonly o: DispatcherGcOptions;
  private readonly clock: Clock;
  private timer: unknown;

  constructor(o: DispatcherGcOptions) {
    this.o = o;
    this.d = o.dispatcher;
    this.del = o.delivery;
    this.clock = o.clock ?? systemClock;
  }

  start(): void {
    this.timer = this.clock.setTimeout(
      () => this.sweep().catch((e) => console.error(`dispatcher gc: ${e}`)).then(() => this.start()),
      this.o.sweepMs ?? SWEEP_MS,
    );
  }

  stop(): void {
    this.clock.clearTimeout(this.timer);
  }

  isExpired(t: Thread): boolean {
    if (!t) return false;
    if (t.outstanding.length > 0 || t.buffer.length > 0) return false;
    const lastActive = t.lastReply ?? t.createdAt;
    if (lastActive === null || lastActive === undefined) return false;
    return expired(lastActive, this.clock, this.o.ttlMs ?? IDLE_TTL_MS);
  }

  async sweep(): Promise<void> {
    // 1. Park live threads under D1b's park predicate.
    for (const id of Object.keys(this.d.journal.threads)) {
      if (this.del.parkable(id)) {
        await this.d.park(id);
      }
    }

    // 2. GC threads idle past 96h TTL.
    for (const [id, t] of Object.entries(this.d.journal.threads)) {
      if (this.isExpired(t)) {
        await this.collect(id, t).catch((e) => console.error(`dispatcher gc ${id}: ${e}`));
      }
    }
  }

  private async collect(id: string, t: Thread): Promise<void> {
    if (t.state === "live" && t.pane !== null) {
      await this.d.park(id);
    }
    await this.o.archive(id, t.session);
    // Re-check after the await in case a message arrived during the await
    const cur = this.d.journal.threads[id];
    if (!cur || !this.isExpired(cur)) return;

    // Transcript leaves the tier's home
    const transcriptFile = `${t.configDir}/transcripts/${t.session}.jsonl`;
    if (existsSync(transcriptFile)) {
      rmSync(transcriptFile, { recursive: true, force: true });
    }
    delete this.d.journal.threads[id];
    this.d.save();
  }
}
