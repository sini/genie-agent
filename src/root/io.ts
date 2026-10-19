// Real xmsg-backed Io adapters for the composition root (GI-2, genie-local-deploy-plan-v0.md):
// - XmsgGuardClient: sends guard envelopes over SocketXmsg with a FIFO concurrency limit
//   (maxConcurrency, default 1) and a timeout that fails closed to { unavailable }.
// - XmsgIo: registers as service `genie` by default (configurable), parses matrix-xmsg forwards
//   (<request> envelope, !trust, reaction controls accept/deeper, approve, solicited lines) into
//   Inbound, matches expert replies and guard verdicts by inReplyTo, and formats drafts and notices
//   back as an xmsg reply to the latest forward for the thread.
import { randomUUID } from "node:crypto";
import { SocketXmsg, type Inbound as RawXmsgInbound, type XmsgClient } from "../dispatcher/xmsg.ts";
import type { XmsgSend } from "../escalation/index.ts";
import { type Envelope, type Verdict, verdictErrors } from "../guard/verdict.ts";
import type { GuardClient, Unavailable } from "../supervisor/guard-client.ts";
import type { Inbound, Intake, Io, Post, PostPayload } from "./index.ts";

export interface XmsgGuardClientOptions {
  target?: string;
  maxConcurrency?: number;
  timeoutMs?: number;
}

interface PendingGuard {
  resolve: (v: Verdict | Unavailable) => void;
  timer: ReturnType<typeof setTimeout>;
}

// Guard client over xmsg: sends each Envelope to `target` (default `genie-guard`), serialized
// through a FIFO concurrency limit (`maxConcurrency`, default 1) so llama-server's slots are not
// oversubscribed, and waits up to `timeoutMs` for the reply pushed to the inbox (`routeReply`) or
// returned by `replies()`, failing closed to `{ unavailable }` on timeout, error, or malformed JSON.
export class XmsgGuardClient implements GuardClient {
  private readonly x: Pick<XmsgClient, "send"> & Partial<Pick<XmsgClient, "replies">>;
  private readonly target: string;
  private readonly maxConcurrency: number;
  private readonly timeoutMs: number;
  private active = 0;
  private peakActiveCount = 0;
  private readonly queue: (() => void)[] = [];
  private readonly pending = new Map<string, PendingGuard>();
  private readonly earlyReplies = new Map<string, string>();
  private seq = 0;

  constructor(
    x: Pick<XmsgClient, "send"> & Partial<Pick<XmsgClient, "replies">>,
    opts: XmsgGuardClientOptions = {},
  ) {
    this.x = x;
    this.target = opts.target ?? "genie-guard";
    this.maxConcurrency = Math.max(1, opts.maxConcurrency ?? 1);
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  get inFlight(): number {
    return this.active;
  }

  get peakConcurrency(): number {
    return this.peakActiveCount;
  }

  // Routes a pushed reply by its inReplyTo message id. Returns true when this client sent the
  // request (consumed as a guard verdict, so it never enters the root intake).
  routeReply(inReplyTo: string, text: string): boolean {
    const p = this.pending.get(inReplyTo);
    if (!p) return false;
    this.pending.delete(inReplyTo);
    clearTimeout(p.timer);
    p.resolve(parseGuardVerdictReply(text));
    return true;
  }

  close(): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.resolve({ unavailable: "guard client closed" });
    }
    this.pending.clear();
  }

  async check(e: Envelope): Promise<Verdict | Unavailable> {
    await this.acquire();
    try {
      return await this.sendAndAwait(e);
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.maxConcurrency) {
      this.active++;
      if (this.active > this.peakActiveCount) this.peakActiveCount = this.active;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.active++;
        if (this.active > this.peakActiveCount) this.peakActiveCount = this.active;
        resolve();
      });
    });
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }

  private async sendAndAwait(e: Envelope): Promise<Verdict | Unavailable> {
    const key = `guard:${++this.seq}:${randomUUID()}`;
    let msgId: string;
    try {
      msgId = await this.x.send(this.target, JSON.stringify(e), key);
    } catch (err) {
      return { unavailable: err instanceof Error ? err.message : String(err) };
    }

    const early = this.earlyReplies.get(msgId);
    if (early !== undefined) {
      this.earlyReplies.delete(msgId);
      return parseGuardVerdictReply(early);
    }

    return new Promise<Verdict | Unavailable>((resolve) => {
      let settled = false;
      const done = (res: Verdict | Unavailable) => {
        if (settled) return;
        settled = true;
        this.pending.delete(msgId);
        clearTimeout(timer);
        resolve(res);
      };

      const timer = setTimeout(() => {
        done({ unavailable: `guard check timed out after ${this.timeoutMs}ms (${msgId})` });
      }, this.timeoutMs);

      this.pending.set(msgId, { resolve: done, timer });
    });
  }
}

export function parseGuardVerdictReply(raw: string): Verdict | Unavailable {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { unavailable: `unparseable guard reply: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
    return { unavailable: String((parsed as { error: unknown }).error) };
  }
  const errs = verdictErrors(parsed);
  if (errs.length > 0) {
    return { unavailable: `invalid guard verdict: ${errs.join("; ")}` };
  }
  return parsed as Verdict;
}

import type { Tier } from "../state/index.ts";
import { parseEnvelope } from "../tier/index.ts";

const REQUEST_OPEN_RE = /^<request(?:\s+screened="false"(?:\s+note="[^"]*")?)?>$/;

// Parse a matrix-xmsg forward or control payload into a composition-root Inbound item, returning
// also the thread id and header tier (when known) so XmsgIo can record the forward message id for replies.
export function parseMatrixForward(
  text: string,
): { item: Inbound; thread?: string; tier?: Tier; screened?: boolean } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // 1. Matrix envelope (matrix-xmsg src/context.rs:487, build_envelope_with_screening):
  //    Header: `[matrix] room=<room> thread=<thread> user=<mapped> (<tier>)`
  //    Blank line, `<request>` or `<request screened="false" note="…">` (context.rs:373),
  //    JSON line, `</request>`, blank line, `<context ...>` blocks.
  //    The sender tier is read strictly from the header's `(<tier>)`, never from the body.
  if (trimmed.startsWith("[matrix] ")) {
    const lines = trimmed.split("\n");
    const header = lines[0];
    const m = /^\[matrix\]\s+room=\S+\s+thread=(\S+)\s+user=.+\s+\((trusted|public)\)$/.exec(header);
    if (!m) return null;
    const thread = m[1];
    let tier: Tier;
    try {
      tier = parseEnvelope(trimmed).request.tier;
    } catch {
      return null;
    }
    const reqOpenIdx = lines.findIndex((l, idx) => idx > 0 && REQUEST_OPEN_RE.test(l));
    const reqCloseIdx = lines.indexOf("</request>", reqOpenIdx + 1);
    if (reqOpenIdx === -1 || reqCloseIdx === -1) return null;
    const unscreened = lines[reqOpenIdx].includes('screened="false"');
    const item: Inbound = unscreened
      ? { thread, envelope: trimmed, screened: false }
      : { thread, envelope: trimmed };
    return { item, thread, tier, screened: !unscreened };
  }

  // 2. JSON control payloads forwarded by matrix-xmsg (`!trust`, `!deeper`, reactions ✅/🔍/🔓, `!approve`)
  if (trimmed.startsWith("{")) {
    let obj: Record<string, unknown>;
    try {
      const v = JSON.parse(trimmed);
      if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
      obj = v as Record<string, unknown>;
    } catch {
      return null;
    }

    const thread =
      typeof obj.thread_id === "string" && obj.thread_id
        ? obj.thread_id
        : typeof obj.thread === "string" && obj.thread
          ? obj.thread
          : undefined;

    if (obj.control === "trust") {
      if (
        !thread ||
        typeof obj.sender !== "string" ||
        typeof obj.sender_id !== "string" ||
        (obj.tier !== "trusted" && obj.tier !== "public") ||
        typeof obj.event_id !== "string"
      ) {
        return null;
      }
      return {
        thread,
        tier: obj.tier,
        item: {
          thread,
          control: "trust",
          sender: obj.sender,
          sender_id: obj.sender_id,
          tier: obj.tier,
          event_id: obj.event_id,
        },
      };
    }

    if (obj.control === "accept" || obj.control === "deeper") {
      if (!thread) return null;
      return {
        thread,
        item: {
          thread,
          control: obj.control,
        },
      };
    }

    if (obj.control === "approve") {
      return {
        thread,
        item: {
          ...(thread ? { thread } : {}),
          control: "approve",
          ...(typeof obj.sender === "string" ? { sender: obj.sender } : {}),
          ...(typeof obj.sender_id === "string" ? { sender_id: obj.sender_id } : {}),
          ...(typeof obj.tier === "string" ? { tier: obj.tier } : {}),
          ...(typeof obj.target === "string" ? { target: obj.target } : {}),
        },
      };
    }
  }

  return null;
}

export interface XmsgIoOptions {
  xmsgDir?: string;
  service?: string;
  pollWaitMs?: number;
  requestTimeoutMs?: number;
  guard?: XmsgGuardClientOptions | null;
  guardEnable?: boolean;
}

interface PendingRequest {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// Real Io adapter over SocketXmsg: registers as `service` (default `"genie"`), polls the service
// inbox, routes guard verdicts and expert replies by `inReplyTo`, parses matrix-xmsg forwards into
// `Inbound`, and replies to the thread's latest forward on `post()` and `request()`. When `guardEnable`
// is false (G11), no `XmsgGuardClient` is constructed.
export class XmsgIo implements Io {
  readonly client: XmsgClient & { register(): Promise<unknown>; close(): void };
  readonly guard?: XmsgGuardClient;
  readonly intake: Intake;
  readonly post: Post;
  readonly xmsg: XmsgSend;
  readonly request: (thread: string, payload: unknown) => Promise<string>;

  private readonly pollWaitMs: number;
  private readonly requestTimeoutMs: number;
  private readonly latestForwardByThread = new Map<string, string>();
  private readonly escalationThreadByMsgId = new Map<string, string>();
  private readonly solicitedThreadByRequestId = new Map<string, string>();
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly earlyRequestReplies = new Map<string, string>();
  private readonly buffered: Inbound[] = [];
  private closed = false;
  private pumping: Promise<void> | null = null;
  private notifyIntake: (() => void) | null = null;

  constructor(
    opts: XmsgIoOptions = {},
    client?: XmsgClient & { register(): Promise<unknown>; close(): void },
  ) {
    const dir = opts.xmsgDir ?? `${process.env.XDG_RUNTIME_DIR ?? "/run"}/xmsg`;
    const service = opts.service ?? "genie";
    const guardEnable = opts.guardEnable ?? (opts.guard !== null);
    if (guardEnable && opts.guard !== undefined && (opts.guard === null || ("target" in opts.guard && !opts.guard.target))) {
      throw new Error("xmsg.guard.target is required when guard.enable is true");
    }
    this.client = client ?? new SocketXmsg(dir, service);
    this.pollWaitMs = opts.pollWaitMs ?? 1_000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
    this.guard = guardEnable ? new XmsgGuardClient(this.client, opts.guard ?? undefined) : undefined;

    this.xmsg = {
      send: async (to: string, text: string, key: string): Promise<string> => {
        let threadId: string | undefined;
        try {
          const parsed = JSON.parse(text);
          if (typeof parsed?.thread_id === "string" && parsed.thread_id) {
            threadId = parsed.thread_id;
          }
        } catch {
          // non-JSON send
        }
        if (!threadId && key.includes("#")) {
          threadId = key.slice(0, key.lastIndexOf("#"));
        }
        const msgId = await this.client.send(to, text, key);
        if (threadId) {
          this.escalationThreadByMsgId.set(msgId, threadId);
        }
        return msgId;
      },
    };

    this.post = {
      post: async (thread: string, message: PostPayload): Promise<string | void> => {
        const fwdId = this.latestForwardByThread.get(thread);
        if (!fwdId) {
          throw new Error(`xmsg post: no forward message id recorded for thread ${thread}`);
        }
        await this.client.reply(fwdId, JSON.stringify(message));
        return fwdId;
      },
    };

    this.request = async (thread: string, payload: unknown): Promise<string> => {
      const fwdId = this.latestForwardByThread.get(thread);
      if (!fwdId) {
        throw new Error(`xmsg request: no forward message id recorded for thread ${thread}`);
      }
      this.startPump();
      const reqMsgId = await this.client.reply(fwdId, JSON.stringify(payload));
      const corrId = typeof reqMsgId === "string" && reqMsgId ? reqMsgId : fwdId;
      const early = this.earlyRequestReplies.get(corrId);
      if (early !== undefined) {
        this.earlyRequestReplies.delete(corrId);
        return early;
      }
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingRequests.delete(corrId);
          reject(new Error(`xmsg request timed out after ${this.requestTimeoutMs}ms (${corrId})`));
        }, this.requestTimeoutMs);
        this.pendingRequests.set(corrId, { resolve, reject, timer });
      });
    };

    this.intake = {
      next: async (): Promise<Inbound[] | null> => {
        while (!this.closed) {
          if (this.buffered.length > 0) {
            return this.buffered.splice(0, 1);
          }
          await this.waitForNext();
        }
        if (this.buffered.length > 0) {
          return this.buffered.splice(0, 1);
        }
        return null;
      },
    };
  }

  async register(): Promise<void> {
    await this.client.register();
    this.startPump();
  }

  bindSolicitedRequest(requestMessageId: string, thread: string): void {
    this.solicitedThreadByRequestId.set(requestMessageId, thread);
  }

  close(): void {
    this.closed = true;
    this.guard?.close();
    for (const p of this.pendingRequests.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("xmsg io closed"));
    }
    this.pendingRequests.clear();
    this.earlyRequestReplies.clear();
    this.wakeIntake();
    this.client.close();
  }

  private wakeIntake(): void {
    const n = this.notifyIntake;
    this.notifyIntake = null;
    if (n) n();
  }

  private waitForNext(): Promise<void> {
    if (this.buffered.length > 0 || this.closed) return Promise.resolve();
    this.startPump();
    return new Promise<void>((resolve) => {
      this.notifyIntake = resolve;
    });
  }

  private startPump(): void {
    if (this.pumping || this.closed) return;
    this.pumping = this.pumpLoop().finally(() => {
      this.pumping = null;
    });
  }

  private async pumpLoop(): Promise<void> {
    while (!this.closed) {
      let msg: RawXmsgInbound | null = null;
      try {
        msg = await this.client.poll(this.pollWaitMs);
      } catch {
        if (this.closed) break;
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      if (!msg) continue;
      await this.handleRaw(msg);
      try {
        await this.client.ack(msg.id);
      } catch {
        if (this.closed) break;
      }
    }
    this.wakeIntake();
  }

  private async handleRaw(m: RawXmsgInbound): Promise<void> {
    if (m.inReplyTo) {
      // 1. Pushed guard verdict reply
      if (this.guard?.routeReply(m.inReplyTo, m.text)) {
        return;
      }

      // 2. Pushed expert reply to an escalation send
      const escThread = this.escalationThreadByMsgId.get(m.inReplyTo);
      if (escThread) {
        this.buffered.push({ thread: escThread, expert: m.text });
        this.wakeIntake();
        return;
      }

      // 3. Pushed matrix-xmsg reply to a context/resync request
      const reqWaiter = this.pendingRequests.get(m.inReplyTo);
      if (reqWaiter) {
        this.pendingRequests.delete(m.inReplyTo);
        clearTimeout(reqWaiter.timer);
        reqWaiter.resolve(m.text);
        return;
      }
      const trimmedReply = m.text.trimStart();
      if (
        trimmedReply.startsWith("<context") ||
        trimmedReply.startsWith('{"context"') ||
        trimmedReply.startsWith('{"resync"')
      ) {
        this.earlyRequestReplies.set(m.inReplyTo, m.text);
        return;
      }

      // 4. Solicited thread line relayed by matrix-xmsg as a reply to open_thread's request_message_id
      const parsedSolicited = parseMatrixForward(m.text);
      const solThread = parsedSolicited?.thread ?? this.solicitedThreadByRequestId.get(m.inReplyTo);
      if (parsedSolicited && solThread) {
        this.latestForwardByThread.set(solThread, m.id);
        this.buffered.push(parsedSolicited.item);
        this.wakeIntake();
        return;
      }
      if (solThread && m.text.trim()) {
        this.latestForwardByThread.set(solThread, m.id);
        this.buffered.push({ thread: solThread, envelope: m.text });
        this.wakeIntake();
        return;
      }
    }

    const parsed = parseMatrixForward(m.text);
    if (!parsed) return;
    if (parsed.thread && "envelope" in parsed.item) {
      this.latestForwardByThread.set(parsed.thread, m.id);
    } else if (parsed.thread && !this.latestForwardByThread.has(parsed.thread)) {
      this.latestForwardByThread.set(parsed.thread, m.id);
    }
    this.buffered.push(parsed.item);
    this.wakeIntake();
  }
}
