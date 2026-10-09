// The dispatcher's side of the tier's xmsg (design §5.8, Talk): it receives as `svc:<name>` by
// long-poll on register.sock (X9), sends and replies attested on agent.sock, so its idempotency
// keys are scoped to its own session (X10), and reads sessions and replies on http.sock (X8).
import { request } from "node:http";
import { createConnection, type Socket } from "node:net";

// The live Claude sessions on the tier's xmsg instance, by sessionId.
export interface XmsgSessions {
  list(): Promise<string[]>;
}

export interface Inbound {
  id: string;
  text: string;
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
  reply(id: string, text: string): Promise<void>;
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
      this.failed = e;
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
    this.sock.end();
  }
}

export class SocketXmsg implements XmsgClient {
  // `dir` is `$XDG_RUNTIME_DIR/xmsg`; `name` the service's, without `svc:`.
  private readonly dir: string;
  private readonly name: string;
  private reg: Lines | null = null;

  constructor(dir: string, name: string) {
    this.dir = dir;
    this.name = name;
  }

  // The registration lives as long as this connection; xmsg refuses a second live one.
  async register(): Promise<void> {
    this.reg = new Lines(`${this.dir}/register.sock`);
    await this.reg.call({ harness: "svc", name: this.name });
  }

  close(): void {
    this.reg?.close();
  }

  private async registered(frame: object): Promise<any> {
    if (!this.reg) throw new Error("xmsg: poll before register");
    return this.reg.call(frame);
  }

  async poll(waitMs: number): Promise<Inbound | null> {
    const r = await this.registered({ action: "poll", waitSecs: secs(waitMs) });
    if (r.action === "timeout") return null;
    if (r.action !== "deliver") throw new Error(`xmsg poll: unexpected ${JSON.stringify(r)}`);
    return { id: r.messageId, text: r.text };
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

  async send(session: string, text: string, key: string): Promise<string> {
    // The turn ends on the reply, read by long-poll, so none is pushed back into the queue.
    const r = await this.agent({ action: "send", ref: session, text, push_replies: false, idempotency_key: key });
    return r.delivery.messageId;
  }

  async reply(id: string, text: string): Promise<void> {
    await this.agent({ action: "reply", messageId: id, text });
  }

  private http(path: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const req = request({ socketPath: `${this.dir}/http.sock`, path }, (res) => {
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
    return (await this.http("/v1/sessions")).map((s: { sessionId: string }) => s.sessionId);
  }

  async replies(id: string, waitMs: number): Promise<string[]> {
    const r = await this.http(`/v1/messages/${encodeURIComponent(id)}/replies?wait=${secs(waitMs)}`);
    return r.map((x: { text: string }) => x.text);
  }
}
