import { createServer, type Server, type Socket } from "node:net";
import { appendFileSync, chmodSync, closeSync, constants, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { METHODS } from "../supervisor/index.ts";
import type { Host } from "./index.ts";
import type { PublicModel } from "./socket.ts";
import type { RootFileService } from "./files.ts";

function bundleVirtualModules(monorepo: string): string | undefined {
  const chunksDir = `${monorepo}/dist/bundle/chunks`;
  if (!existsSync(chunksDir)) return undefined;
  const f = readdirSync(chunksDir).find((name) => name.startsWith("virtual-modules-") && name.endsWith(".js"));
  return f ? `${chunksDir}/${f}` : undefined;
}

// Resolve from the configured/shipped pi, never a second ambient pi installation.
export function piAiPath(pi: string): string {
  if (process.env.GENIE_PI_AI) {
    const envPath = process.env.GENIE_PI_AI;
    if (envPath.endsWith("/node_modules/@earendil-works/pi-ai/dist/compat.js")) {
      const bundled = bundleVirtualModules(resolve(dirname(envPath), "../../../.."));
      if (bundled) return bundled;
    }
    return envPath;
  }
  let bin = pi;
  if (!pi.includes("/")) {
    const found = (process.env.PATH ?? "").split(":").map((d) => `${d}/${pi}`).find(existsSync);
    if (found) bin = found;
  }
  try {
    const monorepo = resolve(dirname(realpathSync(bin)), "../lib/node_modules/pi-monorepo");
    const bundled = bundleVirtualModules(monorepo);
    if (bundled) return bundled;
    const p = `${monorepo}/node_modules/@earendil-works/pi-ai/dist/compat.js`;
    if (existsSync(p)) return p;
    return createRequire(pathToFileURL(realpathSync(bin))).resolve("@earendil-works/pi-ai/compat");
  } catch { throw new Error("cannot resolve the configured pi model SDK"); }
}

const SAFE_OPTIONS = ["temperature", "maxTokens", "reasoning", "thinkingBudgets", "transport", "cacheRetention", "sessionId", "samplingParams", "metadata", "websocketConnectTimeoutMs"];
interface ThreadSocket { server: Server; connections: Set<Socket>; dir: string; upload?: { id: string; file: string; offset: number } }
export interface CustodyOptions {
  model: PublicModel & { apiKey: string };
  sdk: string | (() => string);
  host: (thread: string) => Host;
  files?: (thread: string) => RootFileService;
  session?: (thread: string) => string;
  socketRoot?: string;
}

export class Custody {
  readonly publicModel: PublicModel;
  private sockets = new Map<string, ThreadSocket>();
  private sdk: Promise<any> | undefined;
  private options: CustodyOptions;
  constructor(options: CustodyOptions) {
    this.options = options;
    // Public metadata does not expose either the credential or the upstream destination.
    this.publicModel = { id: options.model.id, api: "genie-custody", baseUrl: "http://root.invalid" };
  }

  open(thread: string): string {
    const existing = this.sockets.get(thread);
    if (existing) return `${existing.dir}/root.sock`;
    if (this.options.socketRoot) mkdirSync(this.options.socketRoot, { recursive: true, mode: 0o700 });
    const dir = mkdtempSync(`${this.options.socketRoot ?? "/tmp"}/genie-custody-`);
    const connections = new Set<Socket>();
    const server = createServer((socket) => {
      connections.add(socket);
      const controller = new AbortController();
      socket.once("close", () => { connections.delete(socket); controller.abort(); });
      socket.on("error", () => {});
      let buf = "", started = false;
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        if (started) return;
        buf += chunk;
        if (new TextEncoder().encode(buf).byteLength > 16 * 1024 * 1024) { socket.destroy(); return; }
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        started = true;
        void this.answer(thread, buf.slice(0, nl), socket, controller.signal);
      });
    });
    server.on("error", () => {});
    server.listen(`${dir}/root.sock`);
    chmodSync(`${dir}/root.sock`, 0o600);
    this.sockets.set(thread, { server, connections, dir });
    return `${dir}/root.sock`;
  }

  private async answer(thread: string, line: string, socket: Socket, signal: AbortSignal): Promise<void> {
    try {
      const request = JSON.parse(line);
      if (request.method === "host") {
        if (!(METHODS as readonly string[]).includes(request.name)) throw new Error("unknown Host method");
        const result = await this.options.host(thread)[request.name as typeof METHODS[number]](request.arg);
        socket.end(`${JSON.stringify({ ok: result ?? null })}\n`);
      } else if (request.method === "file") {
        if (!this.options.files) throw new Error("file service is not configured");
        const result = await this.options.files(thread).execute(request.name, request.arg, signal);
        socket.end(`${JSON.stringify({ ok: result })}\n`);
      } else if (request.method === "session") {
        socket.end(`${JSON.stringify({ ok: this.session(thread, request) })}\n`);
      } else if (request.method === "model") {
        if (!request.context || !Array.isArray(request.context.messages)) throw new Error("invalid model context");
        const rawSdk = await (this.sdk ??= import(pathToFileURL(typeof this.options.sdk === "function" ? this.options.sdk() : this.options.sdk).href));
        const sdk = rawSdk.VIRTUAL_MODULES?.["@earendil-works/pi-ai/compat"] ?? rawSdk;
        const configured = this.options.model;
        const model = {
          id: configured.id, name: configured.id, api: configured.api, provider: "genie", baseUrl: configured.baseUrl,
          reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 16384,
        };
        const options = Object.fromEntries(SAFE_OPTIONS.filter((k) => Object.hasOwn(request.options ?? {}, k)).map((k) => [k, request.options[k]]));
        if (options.samplingParams && typeof options.samplingParams === "object") {
          const reserved = ["model", "messages", "tools", "tool_choice", "stream"];
          options.samplingParams = Object.fromEntries(Object.entries(options.samplingParams).filter(([key]) => !reserved.includes(key)));
        }
        // Credentials, headers and destination are exclusively root configuration.
        const stream = sdk.streamSimple(model, request.context, { ...options, apiKey: configured.apiKey || "root-custody-placeholder", signal, maxRetries: 0 });
        for await (const event of stream) {
          if (signal.aborted) break;
          for (const message of [event.error, event.message, event.partial]) {
            if (message?.errorMessage !== undefined) message.errorMessage = "root model request failed";
            if (message?.diagnostics !== undefined) delete message.diagnostics;
          }
          if (!socket.write(`${JSON.stringify({ event })}\n`)) await new Promise<void>((resolve) => { socket.once("drain", resolve); socket.once("close", resolve); });
        }
        socket.end();
      } else throw new Error("unknown custody operation");
    } catch (error) {
      // Provider exceptions may contain Authorization headers or response bodies.
      const message = line.includes('"model"') ? "root model request failed" : error instanceof Error ? error.message : "root Host request failed";
      if (!socket.destroyed) socket.end(`${JSON.stringify({ error: message })}\n`);
    }
  }

  private session(thread: string, request: any): unknown {
    if (!this.options.session) throw new Error("session service is not configured");
    const file = this.options.session(thread), entry = this.sockets.get(thread)!;
    if (request.op === "read") {
      if (!Number.isSafeInteger(request.offset) || request.offset < 0) throw new Error("invalid session offset");
      let fd: number;
      try { fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW); }
      catch { return { data: "", next: 0, total: 0 }; }
      try {
        const st = fstatSync(fd);
        if (!st.isFile()) throw new Error("invalid session file");
        if (request.offset > st.size) throw new Error("invalid session offset");
        const bytes = new Uint8Array(Math.min(65536, st.size - request.offset));
        const n = readSync(fd, bytes, 0, bytes.length, request.offset);
        return { data: Buffer.from(bytes.subarray(0, n)).toString("base64"), next: request.offset + n, total: st.size };
      } finally { closeSync(fd); }
    }
    if (request.op === "begin") {
      if (entry.upload) rmSync(entry.upload.file, { recursive: false, force: true });
      const id = randomUUID(), staging = `${file}.upload-${id}`;
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(staging, "", { mode: 0o600 }); entry.upload = { id, file: staging, offset: 0 };
      return { id };
    }
    const upload = entry.upload;
    if (!upload || request.id !== upload.id) throw new Error("invalid session upload");
    if (request.op === "chunk") {
      if (request.offset !== upload.offset || typeof request.data !== "string" || request.data.length > 87384) throw new Error("invalid session chunk");
      const data = Buffer.from(request.data, "base64");
      if (data.length > 65536 || data.toString("base64") !== request.data) throw new Error("invalid session chunk");
      appendFileSync(upload.file, data); upload.offset += data.length;
      return { next: upload.offset };
    }
    if (request.op === "commit" && request.size === upload.offset) {
      renameSync(upload.file, file); delete entry.upload;
      return { saved: true };
    }
    throw new Error("invalid session operation");
  }

  async closeThread(thread: string): Promise<void> {
    const entry = this.sockets.get(thread);
    if (!entry) return;
    this.sockets.delete(thread);
    if (entry.upload) rmSync(entry.upload.file, { recursive: false, force: true });
    for (const socket of entry.connections) socket.destroy();
    await new Promise<void>((resolve) => entry.server.close(() => resolve()));
    rmSync(entry.dir, { recursive: true, force: true });
  }

  async close(): Promise<void> { await Promise.all([...this.sockets.keys()].map((thread) => this.closeThread(thread))); }
}
