// The dispatcher's side of the tier's xmsg (design §5.8, Talk): it receives as `<name>` by
// long-poll and replies on register.sock (X9), sends attested on agent.sock, so its idempotency
// keys are scoped to its own session (X10), and reads recipients on http.sock (X8).
import { request } from "node:http";
import { createConnection, type Socket } from "node:net";
import process from "node:process";

// The live Claude sessions on the tier's xmsg instance, by sessionId.
export interface XmsgSessions {
  list(): Promise<string[]>;
}

export interface Inbound {
  id: string;
  text: string;
  inReplyTo?: string;
}

// A refusal by xmsg, by its error code: `not_found` is a session that is not running.
export class XmsgError extends Error {
  readonly code: string;
  constructor(code: string, detail: string) {
    super(`xmsg ${code}: ${detail}`);
    this.code = code;
  }
}

export interface XmsgClient extends XmsgSessions {
  // The next unacknowledged message, or null when none arrives within waitMs. It stays at the
  // head of the queue, and is delivered again, until it is acknowledged.
  poll(waitMs: number): Promise<Inbound | null>;
  ack(id: string): Promise<void>;
  // Resolves to the forwarded message's id. A send repeated with the same key and body returns
  // the first send's id and delivers nothing.
  send(session: string, text: string, key: string): Promise<string>;
  // The text of each reply to a message, waiting up to waitMs for the first.
  replies(id: string, waitMs: number): Promise<string[]>;
  reply(id: string, text: string): Promise<string | void>;
}

const secs = (ms: number) => Math.min(60, Math.ceil(ms / 1000));

// Writes one JSON line and resolves with each JSON line read back, in order.
class Lines {
  private readonly sock: Socket;
  private buf = "";
  private readonly waiting: ((v: any) => void)[] = [];
  private failed: Error | null = null;

  constructor(path: string) {
    this.sock = createConnection(path);
    this.sock.setEncoding("utf8");
    this.sock.on("data", (chunk: string) => {
      this.buf += chunk;
      for (let i; (i = this.buf.indexOf("\n")) >= 0; ) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        this.waiting.shift()?.(JSON.parse(line));
      }
    });
    const fail = (e: Error) => {
      if (!this.failed) this.failed = e;
      for (const w of this.waiting.splice(0)) w(e);
    };
    this.sock.on("error", fail);
    this.sock.on("close", () => fail(new Error(`${path}: connection closed`)));
  }

  async call(frame: object): Promise<any> {
    if (this.failed) throw this.failed;
    const r = await new Promise((resolve) => {
      this.waiting.push(resolve);
      this.sock.write(`${JSON.stringify(frame)}\n`);
    });
    if (r instanceof Error) throw r;
    if ((r as any).status === "error") throw new XmsgError((r as any).error ?? "error", (r as any).detail);
    return r;
  }

  close(): void {
    this.sock.destroy();
  }
}

export class SocketXmsg implements XmsgClient {
  // `dir` is `$XDG_RUNTIME_DIR/xmsg`; `name` the service's, without `svc:`.
  private readonly dir: string;
  private readonly name: string;
  private reg: Lines | null = null;
  address?: string;
  node?: string;

  constructor(dir: string, name: string) {
    this.dir = dir;
    this.name = name;
  }

  // The registration lives as long as this connection; xmsg refuses a second live one.
  async register(): Promise<{ address: string; node: string }> {
    this.reg?.close();
    this.reg = new Lines(`${this.dir}/register.sock`);
    const r = await this.reg.call({ harness: "svc", name: this.name });
    this.address = r.address;
    this.node = r.node;
    return { address: r.address, node: r.node };
  }

  close(): void {
    this.reg?.close();
    this.reg = null;
  }

  private async registered(frame: object): Promise<any> {
    if (!this.reg) throw new Error("xmsg: poll before register");
    return this.reg.call(frame);
  }

  async poll(waitMs: number): Promise<Inbound | null> {
    const r = await this.registered({ action: "poll", waitSecs: secs(waitMs) });
    if (r.action === "timeout") return null;
    if (r.action !== "deliver") throw new Error(`xmsg poll: unexpected ${JSON.stringify(r)}`);
    const ret: Inbound = { id: r.messageId, text: r.text };
    if (r.inReplyTo) ret.inReplyTo = r.inReplyTo;
    return ret;
  }

  async ack(id: string): Promise<void> {
    await this.registered({ action: "ack", messageId: id });
  }

  // One attested call: the server reads the caller's identity off this connection's peer.
  private async agent(frame: object): Promise<any> {
    const c = new Lines(`${this.dir}/agent.sock`);
    try {
      return await c.call(frame);
    } finally {
      c.close();
    }
  }

  async send(to: string, text: string, key: string): Promise<string> {
    const r = await this.agent({ action: "send", to, text, idempotency_key: key });
    // Reads address from result (AM-4)
    const _address: string = r.address;
    return r.message_id;
  }

  async reply(id: string, text: string): Promise<string | void> {
    const r = await this.registered({ action: "reply", messageId: id, text });
    return typeof r?.messageId === "string" ? r.messageId : undefined;
  }

  private http(path: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const req = request({ socketPath: `${this.dir}/http.sock`, path, agent: false }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => {
          try {
            const j = JSON.parse(body);
            if (res.statusCode !== 200) reject(new XmsgError(j.error ?? String(res.statusCode), j.detail ?? body));
            else resolve(j);
          } catch (e) {
            reject(new Error(`xmsg ${path}: ${res.statusCode} ${body}`));
          }
        });
      });
      req.on("error", reject);
      req.end();
    });
  }

  async list(): Promise<string[]> {
    const r = await this.http("/v1/recipients?kind=instance");
    const recipients: { address: string }[] = r.recipients ?? [];
    return recipients.flatMap((s) => {
      const bare = s.address.split("@")[0];
      return bare === s.address ? [s.address] : [s.address, bare];
    });
  }

  async replies(id: string, waitMs: number): Promise<string[]> {
    const r = await this.http(`/v1/messages/${encodeURIComponent(id)}/replies?wait=${secs(waitMs)}`);
    return r.map((x: { text: string }) => x.text);
  }
}

// Waits with exponential backoff: starts at `startMs`, doubles up to `maxMs`.
export async function backoff<T>(
  action: () => Promise<T>,
  opts: {
    startMs: number;
    maxMs: number;
    shouldRetry: (e: unknown) => boolean;
    onWait: (e: unknown) => void;
    sleep?: (ms: number) => Promise<void>;
    signal?: AbortSignal;
  },
): Promise<T> {
  const defaultSleep = (ms: number) =>
    new Promise<void>((resolve, reject) => {
      if (opts.signal?.aborted) return reject(new Error("aborted"));
      const timer = setTimeout(resolve, ms);
      opts.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });
  const sleep = opts.sleep ?? defaultSleep;
  for (let wait = opts.startMs; ; wait = Math.min(wait * 2, opts.maxMs)) {
    if (opts.signal?.aborted) throw new Error("aborted");
    try {
      return await action();
    } catch (e) {
      if (opts.signal?.aborted || !opts.shouldRetry(e)) throw e;
      opts.onWait(e);
      await sleep(wait);
    }
  }
}

// Whether an error is an xmsg connection failure (absent, refused, or closed): waiting may fix it.
export function isConnectionError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (e instanceof XmsgError) return false;
  const code = (e as any).code;
  if (code === "ENOENT" || code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EPIPE") return true;
  return e.message.includes("connection closed") || e.message === "xmsg: poll before register";
}

// Registers with xmsg, retrying on connection errors (absent socket, refused, or closed).
// Backoff `startMs` (default 1 s) doubling to `maxMs` (default 30 s).
export async function awaitRegister(
  x: { register(): Promise<unknown> },
  sleep?: (ms: number) => Promise<void>,
  log?: (line: string) => void,
  signal?: AbortSignal,
  opts?: { service?: string; startMs?: number; maxMs?: number },
): Promise<void> {
  const service = opts?.service ?? "genie-guard";
  const l = log ?? ((line: string) => process.stderr.write(`${line}\n`));
  await backoff(
    async () => {
      await x.register();
    },
    {
      startMs: opts?.startMs ?? 1_000,
      maxMs: opts?.maxMs ?? 30_000,
      shouldRetry: isConnectionError,
      onWait: (e) => l(`${service}: waiting for xmsg: ${e instanceof Error ? e.message : e}`),
      sleep,
      signal,
    },
  );
}

