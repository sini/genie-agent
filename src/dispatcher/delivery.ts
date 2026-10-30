// Dispatcher delivery (design §5.8, Talk and Park; D1b, D3): a supervisor message is journalled into
// its thread's FIFO buffer before it is acknowledged, the buffer drains to the thread's session
// once xmsg lists it, every send carries a journalled idempotency key, and the session's xmsg
// reply, relayed as the dispatcher's own, ends the turn. Under D1b's park predicate, pane close
// parks idle threads, and 96h GC hands expired transcripts to the archiver (D3).
import type { Dispatcher } from "./index.ts";
import { XmsgError, type Inbound, type XmsgClient } from "./xmsg.ts";
import type { Outstanding, Thread } from "./journal.ts";
import { type Clock, systemClock } from "./clock.ts";
import { DispatcherGc } from "./gc.ts";
import { parseExpertReply } from "./reply.ts";

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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchAvailableRepos(text: string, availableRepos: string[]): string[] {
  const matched: string[] = [];
  for (const name of availableRepos) {
    if (!name) continue;
    const re = new RegExp(`(?:^|[^A-Za-z0-9._-])${escapeRegExp(name)}(?:$|[^A-Za-z0-9._-])`);
    if (re.test(text)) matched.push(name);
  }
  return matched;
}

export function packageRepos(m: Inbound, availableRepos: string[] = []): string[] {
  const explicit: string[] = [];
  try {
    const parsed = JSON.parse(m.text);
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.repo === "string" && parsed.repo.trim() !== "") {
        explicit.push(parsed.repo.trim());
      }
      if (Array.isArray(parsed.repos)) {
        for (const r of parsed.repos) {
          if (typeof r === "string" && r.trim() !== "") explicit.push(r.trim());
        }
      }
      if (Array.isArray(parsed.eval_transcript)) {
        for (const item of parsed.eval_transcript) {
          const r = item?.request?.repo;
          if (typeof r === "string" && r.trim() !== "") explicit.push(r.trim());
        }
      }
      if (explicit.length > 0) return [...new Set(explicit)];
      if (typeof parsed.cleaned_question === "string" && availableRepos.length > 0) {
        return matchAvailableRepos(parsed.cleaned_question, availableRepos);
      }
      return [];
    }
  } catch {
    // Non-JSON custom message format (e.g., "<thread>:<body>"): check if body names an available repo.
    if (availableRepos.length > 0) {
      const idx = m.text.indexOf(":");
      const body = idx >= 0 ? m.text.slice(idx + 1) : m.text;
      return matchAvailableRepos(body, availableRepos);
    }
  }
  return [];
}

export interface DeliveryOptions {
  // The thread a supervisor message belongs to, or null to answer it unavailable.
  threadOf?: (m: Inbound) => string | null;
  // The repository names/specs a supervisor message requests for the thread's working copy.
  reposOf?: (m: Inbound) => string[];
  // Every bound below is configuration (defaulted, reversible).
  readyTimeoutMs?: number;
  readyPollMs?: number;
  replyTimeoutMs?: number;
  idleMs?: number;
  sendAttempts?: number;
  now?: () => number;
  clock?: Clock;
  archive?: (threadId: string, session: string) => Promise<void>;
  ttlMs?: number;
  sweepMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Delivery {
  private readonly d: Dispatcher;
  private readonly x: XmsgClient;
  private readonly o: Required<Omit<DeliveryOptions, "clock" | "archive" | "ttlMs" | "sweepMs">>;
  private readonly chains = new Map<string, Promise<void>>();
  private readonly clock: Clock;
  private readonly timeouts = new Map<Outstanding, unknown>();
  readonly gc?: DispatcherGc;
  private stopped = false;

  constructor(d: Dispatcher, x: XmsgClient, o: DeliveryOptions = {}) {
    this.d = d;
    this.x = x;
    this.clock = o.clock ?? (o.now ? { now: o.now, setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t as number) } : systemClock);
    this.o = {
      readyTimeoutMs: 30_000,
      readyPollMs: 250,
      replyTimeoutMs: 15 * 60_000,
      idleMs: 60 * 60_000, // the owner's 1 h live window after the last response (design row 21)
      sendAttempts: 3,
      now: () => this.clock.now(),
      threadOf: packageThread,
      reposOf: (m) => packageRepos(m, this.d.availableSourceRepos()),
      ...o,
    };
    if (o.archive) {
      this.gc = new DispatcherGc({
        dispatcher: this.d,
        delivery: this,
        archive: o.archive,
        clock: this.clock,
        ttlMs: o.ttlMs,
        idleMs: this.o.idleMs,
        sweepMs: o.sweepMs,
      });
    }
  }

  // After a restart: re-arm the reply long-poll of every outstanding message and drain every
  // journalled buffer (replies long-poll stays only for restart recovery, §6 D6).
  start(): void {
    for (const [id, t] of Object.entries(this.d.journal.threads)) {
      for (const o of t.outstanding) void this.awaitRecoveryReply(t, o);
      if (t.buffer.length) this.kick(id);
    }
    this.gc?.start();
  }

  // Stop acting, as a kill would; the journal is what survives.
  stop(): void {
    this.stopped = true;
    for (const timer of this.timeouts.values()) {
      clearTimeout(timer as any);
    }
    this.timeouts.clear();
    this.gc?.stop();
  }

  isStopped(): boolean {
    return this.stopped;
  }

  async sweep(): Promise<void> {
    if (this.gc) {
      await this.gc.sweep();
    } else {
      for (const id of Object.keys(this.d.journal.threads)) {
        if (this.parkable(id)) await this.d.park(id);
      }
    }
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
    // Pushed replies are matched by in_reply_to to the outstanding send that caused them (AM-3; §6 D6).
    if (m.inReplyTo) {
      for (const t of Object.values(this.d.journal.threads)) {
        const o = t.outstanding.find((x) => x.sent === m.inReplyTo);
        if (o) {
          const check = parseExpertReply(m.text);
          if (!check.ok) {
            try {
              await this.x.send(
                t.session,
                `expert reply rejected (schemas/expert-reply.json): ${check.error}; reply again to message_id=${o.sent} with a valid JSON object {"answer","confidence","gaps","tier":"expert","escalate"?:boolean}`,
                `${m.id}#err`,
              );
            } catch {
              // Ignore send failure so the malformed reply is still acked while o remains outstanding.
            }
            return;
          }
          const timer = this.timeouts.get(o);
          if (timer !== undefined) {
            clearTimeout(timer as any);
            this.timeouts.delete(o);
          }
          await this.x.reply(o.id, JSON.stringify(check.value));
          t.outstanding = t.outstanding.filter((x) => x !== o);
          t.lastReply = this.o.now();
          this.d.save();
          return;
        }
      }
      return;
    }

    const known = Object.values(this.d.journal.threads).some(
      (t) => t.buffer.some((b) => b.id === m.id) || t.outstanding.some((o) => o.id === m.id),
    );
    // ponytail: a message redelivered after its reply was relayed (a crash between the journal
    // write and the ack, then a whole turn before the restart's poll) is relayed again; the key
    // still holds the session to one turn. Keep answered ids if that window matters.
    if (known) return;
    const threadId = this.o.threadOf(m);
    // Not a package: answered and acknowledged, with no thread and nothing journalled.
    if (threadId === null) {
      await this.x.reply(m.id, UNAVAILABLE);
      return;
    }
    const t = this.d.thread(threadId, this.o.reposOf(m));
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
    const maxPolls = Math.max(1, Math.ceil(this.o.readyTimeoutMs / Math.max(1, this.o.readyPollMs)));
    for (let polls = 0; !this.stopped && polls <= maxPolls; polls++) {
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
      this.awaitTimeout(t, o);
    }
  }

  // Waits for the deadline; if no pushed reply has arrived to resolve this turn, ends it unavailable.
  private awaitTimeout(t: Thread, o: Outstanding): void {
    const left = Math.max(0, o.deadline - this.o.now());
    const timer = setTimeout(async () => {
      this.timeouts.delete(o);
      if (this.stopped) return;
      if (t.outstanding.includes(o)) {
        await this.x.reply(o.id, UNAVAILABLE);
        t.outstanding = t.outstanding.filter((x) => x !== o);
        this.d.save();
      }
    }, left);
    this.timeouts.set(o, timer);
  }

  // Recovery after restart: the replies long-poll stays only for recovery after a restart (§6 D6).
  private async awaitRecoveryReply(t: Thread, o: Outstanding): Promise<void> {
    let text: string | undefined;
    while (!this.stopped && text === undefined) {
      if (!t.outstanding.includes(o)) return; // already resolved by pushed reply
      const left = o.deadline - this.o.now();
      if (left <= 0) break;
      const r = await this.x.replies(o.sent, left);
      if (this.o.now() <= o.deadline) {
        for (const candidate of r) {
          const check = parseExpertReply(candidate);
          if (check.ok) {
            text = JSON.stringify(check.value);
            break;
          }
        }
      }
    }
    if (this.stopped) return;
    if (!t.outstanding.includes(o)) return; // already resolved by pushed reply
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
