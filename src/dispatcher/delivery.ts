// Dispatcher delivery (design §5.8, Talk and Park; D1b): a supervisor message is journalled into
// its thread's FIFO buffer before it is acknowledged, the buffer drains to the thread's session
// once xmsg lists it, every send carries a journalled idempotency key, and the session's xmsg
// reply, relayed as the dispatcher's own, ends the turn. Nothing here parks: `parkable` is the
// predicate D3 parks under.
import type { Dispatcher } from "./index.ts";
import { XmsgError, type Inbound, type XmsgClient } from "./xmsg.ts";
import type { Outstanding, Thread } from "./journal.ts";

export const UNAVAILABLE = "expert unavailable";

// The thread an `escalation` package names, as the supervisor stamped it; null for a message that
// does not parse as one.
function packageThread(m: Inbound): string | null {
  try {
    const t = JSON.parse(m.text)?.thread_id;
    return typeof t === "string" && t !== "" ? t : null;
  } catch {
    return null;
  }
}

export interface DeliveryOptions {
  // The thread a supervisor message belongs to, or null to answer it unavailable.
  threadOf?: (m: Inbound) => string | null;
  // Every bound below is configuration (defaulted, reversible).
  readyTimeoutMs?: number;
  readyPollMs?: number;
  replyTimeoutMs?: number;
  idleMs?: number;
  sendAttempts?: number;
  now?: () => number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Delivery {
  private readonly d: Dispatcher;
  private readonly x: XmsgClient;
  private readonly o: Required<DeliveryOptions>;
  private readonly chains = new Map<string, Promise<void>>();
  private stopped = false;

  constructor(d: Dispatcher, x: XmsgClient, o: DeliveryOptions = {}) {
    this.d = d;
    this.x = x;
    this.o = {
      readyTimeoutMs: 30_000,
      readyPollMs: 250,
      replyTimeoutMs: 15 * 60_000,
      idleMs: 10 * 60_000,
      sendAttempts: 3,
      now: Date.now,
      threadOf: packageThread,
      ...o,
    };
  }

  // After a restart: re-arm the reply long-poll of every outstanding message and drain every
  // journalled buffer.
  start(): void {
    for (const [id, t] of Object.entries(this.d.journal.threads)) {
      for (const o of t.outstanding) void this.awaitReply(t, o);
      if (t.buffer.length) this.kick(id);
    }
  }

  // Stop acting, as a kill would; the journal is what survives.
  stop(): void {
    this.stopped = true;
  }

  // One long-poll round. The message is acknowledged only once it is journalled, so a crash
  // between the two leaves it at the head of xmsg's queue to be delivered again.
  async pump(waitMs = 30_000): Promise<boolean> {
    const m = await this.x.poll(waitMs);
    if (!m) return false;
    await this.receive(m);
    await this.x.ack(m.id);
    return true;
  }

  async run(): Promise<void> {
    while (!this.stopped) await this.pump();
  }

  private async receive(m: Inbound): Promise<void> {
    const known = Object.values(this.d.journal.threads).some(
      (t) => t.buffer.some((b) => b.id === m.id) || t.outstanding.some((o) => o.id === m.id),
    );
    // ponytail: a message redelivered after its reply was relayed (a crash between the journal
    // write and the ack, then a whole turn before the restart's poll) is relayed again; the key
    // still holds the session to one turn. Keep answered ids if that window matters.
    if (known) return;
    const threadId = this.o.threadOf(m);
    // Not a package: answered and acknowledged, with no thread and nothing journalled.
    if (threadId === null) return this.x.reply(m.id, UNAVAILABLE);
    const t = this.d.thread(threadId);
    t.buffer.push({ id: m.id, body: m.text, key: `${m.id}#${++t.seq}` });
    this.d.save();
    this.kick(threadId);
  }

  // One drain per thread at a time, so its buffer leaves in order.
  private kick(threadId: string): void {
    const next = (this.chains.get(threadId) ?? Promise.resolve()).then(() => this.drain(threadId));
    this.chains.set(
      threadId,
      next.catch((e) => console.error(`dispatcher: thread ${threadId}: ${e}`)),
    );
  }

  // Resolves once every drain kicked so far has finished.
  async settled(): Promise<void> {
    while (true) {
      const all = [...this.chains.values()];
      await Promise.all(all);
      if ([...this.chains.values()].every((c, i) => c === all[i])) return;
    }
  }

  private async ready(t: Thread): Promise<boolean> {
    const until = this.o.now() + this.o.readyTimeoutMs;
    while (!this.stopped) {
      if ((await this.x.list()).includes(t.session)) return true;
      if (this.o.now() >= until) return false;
      await sleep(this.o.readyPollMs);
    }
    return false;
  }

  private async drain(threadId: string): Promise<void> {
    const t = this.d.journal.threads[threadId];
    let attempts = 0;
    while (!this.stopped && t.buffer.length) {
      let ok = attempts < this.o.sendAttempts;
      // A parked thread resumes, and no message goes until xmsg lists the session: the resume's
      // rc 0 is not the signal.
      if (ok && t.state === "parked") {
        await this.d.escalate(threadId);
        ok = await this.ready(t);
      }
      if (this.stopped) return;
      if (!ok) {
        for (const b of t.buffer.splice(0)) await this.x.reply(b.id, UNAVAILABLE);
        this.d.save();
        return;
      }
      const b = t.buffer[0];
      let sent: string;
      try {
        sent = await this.x.send(t.session, b.body, b.key);
      } catch (e) {
        attempts++;
        // The session is gone: park it and resume it. Any other failure retries the same key.
        if (e instanceof XmsgError && e.code === "not_found") await this.d.park(threadId);
        continue;
      }
      if (this.stopped) return;
      attempts = 0;
      const o = { id: b.id, sent, deadline: this.o.now() + this.o.replyTimeoutMs };
      t.buffer.shift();
      t.outstanding.push(o);
      this.d.save();
      void this.awaitReply(t, o);
    }
  }

  // The session's first reply ends the turn and is relayed as the dispatcher's own. With none by
  // the deadline the turn ends "expert unavailable", and a later reply is dropped.
  private async awaitReply(t: Thread, o: Outstanding): Promise<void> {
    let text: string | undefined;
    while (!this.stopped && text === undefined) {
      const left = o.deadline - this.o.now();
      if (left <= 0) break;
      const r = await this.x.replies(o.sent, left);
      if (r.length && this.o.now() <= o.deadline) text = r[0];
    }
    if (this.stopped) return;
    await this.x.reply(o.id, text ?? UNAVAILABLE);
    t.outstanding = t.outstanding.filter((x) => x !== o);
    if (text !== undefined) t.lastReply = this.o.now();
    this.d.save();
  }

  // The park predicate: nothing buffered or outstanding, and the idle threshold elapsed since the
  // last reply. herdr's `idle` is not consulted: a session reads idle for about 1 s after a send.
  parkable(threadId: string): boolean {
    const t = this.d.journal.threads[threadId];
    if (!t || t.state !== "live" || t.buffer.length || t.outstanding.length) return false;
    return t.lastReply === null || this.o.now() - t.lastReply >= this.o.idleMs;
  }
}
