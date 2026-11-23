// The dispatcher's side of the tier's xmsg (design §5.8, Talk): it receives as `<name>` by
// long-poll and replies on register.sock (X9), sends attested on agent.sock, so its idempotency
// keys are scoped to its own session (X10), and reads recipients on http.sock (X8).
import { execFile } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { request } from "node:http";
import { createConnection, type Socket } from "node:net";
import process from "node:process";

export type SessionPresence = "present" | "absent" | "unknown";

export interface XmsgRecipientList {
  sessions: string[];
  truncated: boolean;
}


// Service bundles copy this transport as one file, so shared discovery stays here.
export interface XmsgEndpoints {
  agentSocket: string;
  registerSocket: string;
  httpSocket: string;
}

export interface XmsgEndpointOverrides extends Partial<XmsgEndpoints> {
  xmsgDir?: string;
}

export const xmsgEndpointFlags = { "--xmsg-dir": "xmsgDir", "--agent-sock": "agentSocket",
  "--register-sock": "registerSocket", "--http-sock": "httpSocket" } as const;

export function xmsgEndpointArguments(flags: Map<string, string>): XmsgEndpointOverrides {
  const result: XmsgEndpointOverrides = {};
  for (const [flag, name] of Object.entries(xmsgEndpointFlags)) {
    const value = flags.get(flag);
    if (value !== undefined) result[name] = value;
  }
  return result;
}

export type XmsgEndpointName = keyof XmsgEndpoints;
export type XmsgEndpointResolver = {
  (overrides?: XmsgEndpointOverrides, required?: readonly XmsgEndpointName[]): Promise<Partial<XmsgEndpoints>>;
  fixed?(overrides?: XmsgEndpointOverrides, required?: readonly XmsgEndpointName[]): Partial<XmsgEndpoints> | undefined;
  invalidate?(paths: Partial<XmsgEndpoints>): void;
};
type ProbeError = Error & { code?: string | number; killed?: boolean; signal?: string | null };
export interface DoctorResult { stdout: string; error?: ProbeError | null }
export interface DoctorOptions {
  env: Record<string, string | undefined>;
  timeout: number;
  maxBuffer: number;
  encoding: "utf8";
  shell: false;
  killSignal: "SIGKILL";
}
export type DoctorProbe = (file: string, args: string[], options: DoctorOptions) => Promise<DoctorResult>;

export class XmsgEndpointError extends Error {}

const names = ["agentSocket", "registerSocket", "httpSocket"] as const;
const environmentNames = {
  agentSocket: "XMSG_AGENT_SOCK",
  registerSocket: "XMSG_REGISTER_SOCK",
  httpSocket: "XMSG_HTTP_SOCK",
} as const;
const fileNames = { agentSocket: "agent.sock", registerSocket: "register.sock", httpSocket: "http.sock" } as const;

function socket(value: unknown, field: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
    throw new XmsgEndpointError(`xmsg: ${field} must be an absolute socket path`);
  }
  return value;
}

export function explicitXmsgEndpoints(overrides: XmsgEndpointOverrides): Partial<XmsgEndpoints> {
  const result: Partial<XmsgEndpoints> = {};
  for (const name of names) {
    const value = overrides[name] !== undefined ? overrides[name] : (overrides.xmsgDir === undefined ? undefined :
      join(socket(overrides.xmsgDir, "xmsgDir"), fileNames[name]));
    if (value !== undefined) result[name] = socket(value, name);
  }
  return result;
}

function legacyEndpoints(env: Record<string, string | undefined>): XmsgEndpoints {
  const directory = join(socket(env.XDG_RUNTIME_DIR, "XDG_RUNTIME_DIR for legacy fallback"), "xmsg");
  return { agentSocket: join(directory, "agent.sock"), registerSocket: join(directory, "register.sock"),
    httpSocket: join(directory, "http.sock") };
}

const probeDoctor: DoctorProbe = (file, args, options) => new Promise((resolve) => {
  execFile(file, args, options, (error, stdout) => resolve({ stdout, error }));
});

export function createXmsgEndpointResolver(options: {
  env?: Record<string, string | undefined>;
  probe?: DoctorProbe;
  log?: (line: string) => void;
} = {}): XmsgEndpointResolver {
  const env = { ...(options.env ?? process.env) };
  const probe = options.probe ?? probeDoctor;
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  let doctor: { epoch: object; result: Promise<Partial<XmsgEndpoints> | string> } | undefined;
  const epochs = new WeakMap<Partial<XmsgEndpoints>, object>();
  let loggedFallback = false;
  async function discover(): Promise<Partial<XmsgEndpoints> | string> {
    let result: DoctorResult;
    try {
      result = await probe("xmsg", ["doctor", "--json"], {
        env, timeout: 3000, maxBuffer: 64 * 1024, encoding: "utf8", shell: false, killSignal: "SIGKILL",
      });
    } catch { throw new XmsgEndpointError("xmsg: doctor invocation failed"); }
    if (result.error?.code === "ENOENT") return "CLI unavailable";
    if (result.error?.killed || result.error?.signal || result.error?.code === "ETIMEDOUT" ||
        result.error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      throw new XmsgEndpointError("xmsg: doctor exceeded its execution or output bound");
    }
    let report: unknown;
    try { report = JSON.parse(result.stdout); } catch {
      throw new XmsgEndpointError("xmsg: doctor returned invalid JSON");
    }
    if (!report || typeof report !== "object" || Array.isArray(report)) {
      throw new XmsgEndpointError("xmsg: doctor returned an invalid endpoint report");
    }
    const value = report as Record<string, unknown>;
    if (value.endpoints_usable === false) throw new XmsgEndpointError("xmsg: doctor refused endpoint resolution");
    if (value.endpoints_usable !== true) {
      if (["agent_socket", "register_socket", "leaf_register_socket", "http_socket", "endpoints_usable"]
        .some((key) => key in value)) throw new XmsgEndpointError("xmsg: doctor returned an invalid endpoint report");
      return "doctor has no endpoint information";
    }
    const resultPaths: Partial<XmsgEndpoints> = {};
    const fields = { agentSocket: value.agent_socket,
      registerSocket: value.register_socket ?? value.leaf_register_socket, httpSocket: value.http_socket };
    for (const name of names) if (fields[name] !== undefined && fields[name] !== null) {
      resultPaths[name] = socket(fields[name], `doctor ${name}`);
    }
    return resultPaths;
  }
  function selected(overrides: XmsgEndpointOverrides, required: readonly XmsgEndpointName[]) {
    const result = explicitXmsgEndpoints(overrides);
    for (const name of required) if (result[name] === undefined && env[environmentNames[name]] !== undefined) {
      result[name] = socket(env[environmentNames[name]], environmentNames[name]);
    }
    return result;
  }
  const resolve: XmsgEndpointResolver = async (overrides = {}, required = names) => {
    const result = selected(overrides, required);
    if (required.some((name) => result[name] === undefined)) {
      const entry = doctor ??= { epoch: {}, result: discover() };
      const discovered = await entry.result;
      if (typeof discovered !== "string") {
        for (const name of names) if (result[name] === undefined && discovered[name] !== undefined) result[name] = discovered[name];
        if (required.some((name) => result[name] === undefined)) {
          throw new XmsgEndpointError("xmsg: doctor omitted a required endpoint");
        }
      } else {
        const legacy = legacyEndpoints(env);
        for (const name of names) result[name] ??= legacy[name];
        if (!loggedFallback) { log(`genie: xmsg legacy socket fallback (${discovered})`); loggedFallback = true; }
      }
      epochs.set(result, entry.epoch);
    }
    return result;
  };
  resolve.fixed = (overrides = {}, required = names) => {
    const result = selected(overrides, required);
    return required.every((name) => result[name] !== undefined) ? result : undefined;
  };
  resolve.invalidate = (paths) => {
    if (doctor && epochs.get(paths) === doctor.epoch) doctor = undefined;
  };
  return resolve;
}

let processResolver: XmsgEndpointResolver | undefined;
const currentResolver = () => processResolver ??= createXmsgEndpointResolver();
export const resolveXmsgEndpoints: XmsgEndpointResolver = Object.assign(
  (overrides?: XmsgEndpointOverrides, required?: readonly XmsgEndpointName[]) => currentResolver()(overrides, required),
  {
    fixed: (overrides?: XmsgEndpointOverrides, required?: readonly XmsgEndpointName[]) => currentResolver().fixed!(overrides, required),
    invalidate: (paths: Partial<XmsgEndpoints>) => processResolver?.invalidate?.(paths),
  },
);

// The live Claude sessions on the tier's xmsg instance, by sessionId.
export interface XmsgSessions {
  list(name?: string): Promise<string[]>;
  listDetailed?(name?: string): Promise<XmsgRecipientList>;
}

export async function checkSessionPresence(
  x: XmsgSessions,
  sessionId: string,
  name?: string,
): Promise<SessionPresence> {
  if (x.listDetailed) {
    let truncated = false;
    if (name !== undefined) {
      const named = await x.listDetailed(name);
      if (named.sessions.includes(sessionId)) return "present";
      truncated = named.truncated;
    }
    const all = await x.listDetailed();
    if (all.sessions.includes(sessionId)) return "present";
    return all.truncated || truncated ? "unknown" : "absent";
  }
  const sessions = await x.list();
  return sessions.includes(sessionId) ? "present" : "absent";
}

export interface Inbound {
  id: string;
  text: string;
  inReplyTo?: string;
  // Raw transport metadata; callers must validate its shape before using it.
  origin?: unknown;
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
  reply(id: string, text: string, key?: string): Promise<string | void>;
}

const secs = (ms: number) => Math.min(60, Math.ceil(ms / 1000));

// How long past a frame's own long-poll wait a reply may take before the connection counts as
// dead. A socket that accepts but never answers (a daemon swapped out from under it) otherwise
// hangs the caller forever, and no reconnect backoff ever runs.
export const REPLY_GRACE_MS = 15_000;

// Writes one JSON line and resolves with each JSON line read back, in order.
class Lines {
  private readonly sock: Socket;
  private readonly path: string;
  private buf = "";
  private readonly waiting: ((v: any) => void)[] = [];
  private failed: Error | null = null;
  private readonly fail: (e: Error) => void;
  private readonly graceMs: number;

  constructor(path: string, graceMs = REPLY_GRACE_MS) {
    this.path = path;
    this.graceMs = graceMs;
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
    this.fail = (e: Error) => {
      if (!this.failed) this.failed = e;
      for (const w of this.waiting.splice(0)) w(e);
    };
    this.sock.on("error", this.fail);
    this.sock.on("close", () => this.fail(new Error(`${path}: connection closed`)));
  }

  async call(frame: object): Promise<any> {
    if (this.failed) throw this.failed;
    const waitSecs = (frame as { waitSecs?: unknown }).waitSecs;
    const deadlineMs = (typeof waitSecs === "number" ? waitSecs * 1000 : 0) + this.graceMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const r = await new Promise((resolve) => {
      this.waiting.push(resolve);
      // Replies are matched by order, so a late one can't be told apart: drop the connection.
      timer = setTimeout(() => {
        const e = Object.assign(new Error(`${this.path}: no reply within ${deadlineMs} ms`), { code: "ETIMEDOUT" });
        this.fail(e);
        this.sock.destroy();
      }, deadlineMs);
      this.sock.write(`${JSON.stringify(frame)}\n`);
    }).finally(() => clearTimeout(timer));
    if (r instanceof Error) throw r;
    if ((r as any).status === "error") throw new XmsgError((r as any).error ?? "error", (r as any).detail);
    return r;
  }

  close(): void {
    this.sock.destroy();
  }
}

export class SocketXmsg implements XmsgClient {
  private endpoints?: Promise<Partial<XmsgEndpoints>>;
  private currentPaths?: Partial<XmsgEndpoints>;
  private readonly resolve: XmsgEndpointResolver;
  private readonly overrides: XmsgEndpointOverrides;
  private readonly required: readonly XmsgEndpointName[];
  private registering?: Promise<{ address: string; node: string }>;
  private readonly name: string;
  private reg: Lines | null = null;
  address?: string;
  node?: string;
  registrationLimits: { max_body_bytes?: number; reply_ttl_secs?: number; idempotency_ttl_secs?: number } = {};

  private readonly graceMs: number;

  constructor(paths: string | XmsgEndpointOverrides, name: string,
    optionsOrGrace: number | { resolve?: XmsgEndpointResolver; required?: readonly XmsgEndpointName[]; graceMs?: number } = REPLY_GRACE_MS) {
    const options = typeof optionsOrGrace === "number" ? { graceMs: optionsOrGrace } : optionsOrGrace;
    this.resolve = options.resolve ?? resolveXmsgEndpoints;
    this.overrides = typeof paths === "string" ? { xmsgDir: paths } : { ...paths };
    this.required = [...(options.required ?? names)];
    // Discovery belongs to registration/backoff, not construction or messages.
    const fixed = this.resolve.fixed?.(this.overrides, this.required);
    if (fixed !== undefined) { this.currentPaths = fixed; this.endpoints = Promise.resolve(fixed); }
    this.name = name;
    this.graceMs = options.graceMs ?? REPLY_GRACE_MS;
  }

  private async socketPath(name: XmsgEndpointName): Promise<string> {
    const value = (await this.endpoints)?.[name];
    if (value === undefined) throw new XmsgEndpointError(`xmsg: ${name} is unavailable for this client`);
    return value;
  }

  private disconnected(connection: Lines, paths: Partial<XmsgEndpoints>): void {
    if (this.reg !== connection) return;
    this.resolve.invalidate?.(paths);
    this.endpoints = undefined;
    this.currentPaths = undefined;
  }

  // The registration lives as long as this connection; xmsg refuses a second live one.
  register(): Promise<{ address: string; node: string }> {
    if (this.registering) return this.registering;
    const pending = this.registerAttempt().finally(() => { if (this.registering === pending) this.registering = undefined; });
    this.registering = pending;
    return pending;
  }

  private async registerAttempt(): Promise<{ address: string; node: string }> {
    const previous = this.reg;
    this.reg = null;
    previous?.close();
    const paths = await (this.endpoints ??= this.resolve(this.overrides, this.required));
    this.currentPaths = paths;
    const registerSocket = paths.registerSocket;
    if (registerSocket === undefined) throw new XmsgEndpointError("xmsg: registerSocket is unavailable for this client");
    const connection = new Lines(registerSocket, this.graceMs);
    this.reg = connection;
    let r: any;
    try { r = await connection.call({ harness: "svc", name: this.name }); }
    catch (error) { if (isConnectionError(error)) this.disconnected(connection, paths); throw error; }
    this.address = r.address;
    this.node = r.node;
    this.registrationLimits = { max_body_bytes: r.max_body_bytes, reply_ttl_secs: r.reply_ttl_secs, idempotency_ttl_secs: r.idempotency_ttl_secs };
    return { address: r.address, node: r.node };
  }

  close(): void {
    const previous = this.reg;
    this.reg = null;
    previous?.close();
  }

  private async registered(frame: object): Promise<any> {
    const connection = this.reg;
    const paths = this.currentPaths;
    if (!connection) throw new Error("xmsg: poll before register");
    try { return await connection.call(frame); }
    catch (error) { if (paths && isConnectionError(error)) this.disconnected(connection, paths); throw error; }
  }

  async poll(waitMs: number): Promise<Inbound | null> {
    const r = await this.registered({ action: "poll", waitSecs: secs(waitMs) });
    if (r.action === "timeout") return null;
    if (r.action !== "deliver") throw new Error(`xmsg poll: unexpected ${JSON.stringify(r)}`);
    const ret: Inbound = { id: r.messageId, text: r.text };
    if (r.inReplyTo) ret.inReplyTo = r.inReplyTo;
    if (r.origin !== undefined) ret.origin = r.origin;
    return ret;
  }

  async ack(id: string): Promise<void> {
    await this.registered({ action: "ack", messageId: id });
  }

  // One attested call: the server reads the caller's identity off this connection's peer.
  private async agent(frame: object): Promise<any> {
    const c = new Lines(await this.socketPath("agentSocket"), this.graceMs);
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

  async reply(id: string, text: string, key?: string): Promise<string | void> {
    const r = await this.registered({ action: "reply", messageId: id, text, ...(key === undefined ? {} : { idempotencyKey: key }) });
    return typeof r?.messageId === "string" ? r.messageId : undefined;
  }

  private async http(path: string): Promise<any> {
    const httpSocket = await this.socketPath("httpSocket");
    return new Promise((resolve, reject) => {
      const req = request({ socketPath: httpSocket, path, agent: false }, (res) => {
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

  async listDetailed(name?: string): Promise<XmsgRecipientList> {
    const query = name === undefined ? "kind=instance" : `kind=instance&name=${encodeURIComponent(name)}`;
    const r = await this.http(`/v1/recipients?${query}`);
    const recipients: { address: string }[] = r.recipients ?? [];
    const sessions = recipients.flatMap((s) => {
      const bare = s.address.split("@")[0];
      return bare === s.address ? [s.address] : [s.address, bare];
    });
    return { sessions, truncated: r.truncated === true };
  }

  async list(name?: string): Promise<string[]> {
    return (await this.listDetailed(name)).sessions;
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

// Whether an error is an xmsg connection failure (absent, refused, closed, or silent): waiting may fix it.
export function isConnectionError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (e instanceof XmsgError) return false;
  const code = (e as any).code;
  if (code === "ENOENT" || code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EPIPE" || code === "ETIMEDOUT") return true;
  return e.message.includes("connection closed") || e.message === "xmsg: poll before register";
}

// Registers with xmsg, retrying on connection errors (absent socket, refused, or closed).
// Backoff `startMs` (default 1 s) doubling to `maxMs` (default 30 s).
export async function awaitRegister(
  x: { register(): Promise<unknown> },
  sleep?: (ms: number) => Promise<void>,
  log?: (line: string) => void,
  signal?: AbortSignal,
  opts?: { service?: string; startMs?: number; maxMs?: number; initialError?: unknown },
): Promise<void> {
  const service = opts?.service ?? "genie-guard";
  const l = log ?? ((line: string) => process.stderr.write(`${line}\n`));
  let initialError = opts?.initialError;
  await backoff(
    async () => {
      if (initialError !== undefined) {
        const error = initialError;
        initialError = undefined;
        throw error;
      }
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

