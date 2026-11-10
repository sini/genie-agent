import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { type Proposal, type Action, validateProposalFields } from "./index.ts";
import { errors, load } from "../tier1/schema.ts";
declare module "node:fs" {
  export function writeSync(
    fd: number,
    data: Uint8Array,
    offset: number,
    length: number,
  ): number;
}
export interface BridgePrincipal {
  service: string;
  node: string;
}
export interface BridgeInbound {
  id: string;
  text: string;
  origin?: unknown;
}
export interface BrokerBridgeConfig {
  stateRoot: string;
  allowlist: readonly BridgePrincipal[];
  maxBodyBytes: number;
  maxRecords?: number;
  maxQueued?: number;
  retentionMs?: number;
  replyTimeoutMs?: number;
  checkContract?: () => void;
  propose: (principal: BridgePrincipal, proposal: Proposal) => Promise<Action>;
  reply: (originalID: string, text: string, key: string) => Promise<unknown>;
}
interface RecordEntry {
  version: 1;
  key: string;
  id: string;
  principal: BridgePrincipal;
  fingerprint: string;
  created: number;
  acknowledged?: boolean;
  uncertain?: boolean;
  state: "pending" | "writing" | "completed";
  proposal?: Proposal;
  result?: string;
}
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const schema = load("proposal");
const kinds = new Set(["gist", "gist_read", "gist_update", "gist_comment"]);
function principal(value: unknown): BridgePrincipal | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.service !== "string" ||
    typeof v.node !== "string" ||
    v.id !== undefined ||
    !v.service ||
    !v.node ||
    v.service.length > 128 ||
    v.node.length > 255
  )
    return null;
  return { service: v.service, node: v.node };
}
export class BrokerBridge {
  private records = new Map<string, RecordEntry>();
  private queue: string[] = [];
  private queued = new Set<string>();
  private recovery: Iterator<string> | null = null;
  private running: Promise<void> | null = null;
  private started = false;
  private closing = false;
  private maxRecords: number;
  private maxQueued: number;
  private retention: number;
  private replyTimeout: number;
  private c: BrokerBridgeConfig;
  constructor(c: BrokerBridgeConfig) {
    this.c = c;
    this.maxRecords = c.maxRecords ?? 1000;
    this.maxQueued = c.maxQueued ?? 100;
    this.retention = c.retentionMs ?? 604800000;
    this.replyTimeout = c.replyTimeoutMs ?? 5000;
    for (const n of [
      c.maxBodyBytes,
      this.maxRecords,
      this.maxQueued,
      this.retention,
      this.replyTimeout,
    ])
      if (!Number.isSafeInteger(n) || n <= 0)
        throw new Error("invalid broker bridge budget");
    if (
      c.maxBodyBytes < 512 ||
      c.maxBodyBytes > 65536 ||
      this.maxQueued > this.maxRecords ||
      this.replyTimeout > 60000
    )
      throw new Error("invalid broker bridge budget");
    for (const p of c.allowlist)
      if (!principal(p)) throw new Error("invalid broker bridge principal");
  }
  private persist(r: RecordEntry) {
    const file = join(this.c.stateRoot, r.key + ".json");
    const tmp = file + ".tmp";
    const fd = openSync(tmp, "w", 0o600);
    try {
      const bytes = new TextEncoder().encode(JSON.stringify(r));
      for (let offset = 0; offset < bytes.length;) {
        const written = writeSync(fd, bytes, offset, bytes.length - offset);
        if (
          !Number.isInteger(written) ||
          written <= 0 ||
          written > bytes.length - offset
        )
          throw new Error("broker ledger write incomplete");
        offset += written;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
    const d = openSync(this.c.stateRoot, "r");
    try {
      fsyncSync(d);
    } finally {
      closeSync(d);
    }
    this.records.set(r.key, r);
  }
  private result(key: string, reason: string): string {
    return JSON.stringify({
      thread: "broker-bridge-" + key,
      acted: false,
      reason,
      redactions: [],
    });
  }
  private bounded(r: RecordEntry, a: Action): string {
    let s: string;
    try {
      s = JSON.stringify(a);
    } catch {
      return this.result(r.key, "broker result unavailable");
    }
    if (new TextEncoder().encode(s).byteLength > this.c.maxBodyBytes)
      return this.result(r.key, "broker result too large");
    return s;
  }
  async start(): Promise<void> {
    if (this.started) return;
    mkdirSync(this.c.stateRoot, { recursive: true, mode: 0o700 });
    for (const file of readdirSync(this.c.stateRoot).sort()) {
      if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
      const r = JSON.parse(
        readFileSync(join(this.c.stateRoot, file), "utf8"),
      ) as RecordEntry;
      if (
        r.version !== 1 ||
        r.key + ".json" !== file ||
        !principal(r.principal) ||
        !["pending", "writing", "completed"].includes(r.state)
      )
        throw new Error("invalid broker bridge ledger");
      if (
        r.state === "completed" &&
        r.acknowledged &&
        !r.uncertain &&
        Date.now() - r.created >= this.retention
      ) {
        unlinkSync(join(this.c.stateRoot, file));
        continue;
      }
      if (this.records.size >= this.maxRecords)
        throw new Error("broker bridge ledger capacity");
      if (r.state === "writing") {
        r.uncertain = true;
        r.state = "completed";
        r.result = this.result(
          r.key,
          "write outcome uncertain; no automatic retry",
        );
        delete r.proposal;
        this.persist(r);
      } else this.records.set(r.key, r);
    }
    this.recovery = this.records.keys();
    this.refill();
    this.started = true;
    this.kick();
  }
  private refill() {
    while (this.recovery && this.queue.length < this.maxQueued) {
      const next = this.recovery.next();
      if (next.done) {
        this.recovery = null;
        break;
      }
      this.enqueue(next.value, false);
    }
  }
  private enqueue(key: string, kick = true) {
    if (!this.queued.has(key)) {
      if (this.queue.length >= this.maxQueued)
        throw new Error("broker bridge queue capacity");
      this.queued.add(key);
      this.queue.push(key);
    }
    if (kick) this.kick();
  }
  private kick() {
    if (!this.running && this.queue.length) {
      this.running = new Promise<void>((resolve) => setTimeout(resolve, 0))
        .then(() => this.work())
        .finally(() => {
          this.running = null;
          if (this.queue.length) this.kick();
        });
    }
  }
  async accept(input: BridgeInbound): Promise<boolean> {
    const framed = input.text.startsWith("[External message via ");
    const direct =
      /^\s*\{[\s\S]*?"kind"\s*:\s*"gist(?:_read|_update|_comment)?"/.test(
        input.text,
      );
    if (!framed && !direct) return false;
    if (!this.started || this.closing)
      throw new Error("broker bridge unavailable");
    if (typeof input.id !== "string" || !input.id || input.id.length > 4096)
      throw new Error("invalid broker bridge delivery ID");
    const p = principal(input.origin);
    const authority = p ?? { service: "invalid", node: "invalid" };
    const key = hash(
      JSON.stringify([p ? authority : (input.origin ?? null), input.id]),
    );
    const fingerprint = hash(input.text);
    const old = this.records.get(key);
    if (old) {
      if (old.fingerprint !== fingerprint)
        throw new Error("broker bridge delivery conflict");
      this.enqueue(key);
      return true;
    }
    this.prune();
    if (
      this.records.size >= this.maxRecords ||
      this.queue.length >= this.maxQueued
    )
      throw new Error("broker bridge queue capacity");
    let reason: string | undefined;
    try {
      this.c.checkContract?.();
    } catch {
      reason = "broker bus contract changed; restart required";
    }
    let proposal: Proposal | undefined;
    if (reason) {
      /* Persist a refusal so intake can ACK and continue routing replies. */
    } else if (
      !p ||
      !this.c.allowlist.some(
        (a) => a.service === p.service && a.node === p.node,
      )
    )
      reason = "broker caller not authorized";
    else if (
      new TextEncoder().encode(input.text).byteLength > this.c.maxBodyBytes
    )
      reason = "broker request too large";
    else {
      const match =
        /^\[External message via [^\]\r\n]+; gateway correlation gw-[a-f0-9]{64}\]\n([\s\S]*)$/.exec(
          input.text,
        );
      try {
        if (!match) throw new Error();
        const value = JSON.parse(match[1]);
        if (
          !value ||
          !kinds.has(value.kind) ||
          errors(schema, value).length ||
          validateProposalFields(value) !== null
        )
          throw new Error();
        proposal = value;
      } catch {
        reason = "invalid broker proposal";
      }
    }
    const r: RecordEntry = {
      version: 1,
      key,
      id: input.id,
      principal: authority,
      fingerprint,
      created: Date.now(),
      state: reason ? "completed" : "pending",
      ...(proposal ? { proposal } : {}),
      ...(reason ? { result: this.result(key, reason) } : {}),
    };
    this.persist(r);
    this.enqueue(key);
    return true;
  }
  private async attemptReply(r: RecordEntry): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.c.reply(r.id, r.result!, `broker-${r.key}`),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.replyTimeout);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  private async work() {
    while (this.queue.length) {
      const key = this.queue.shift()!;
      this.queued.delete(key);
      const r = this.records.get(key)!;
      if (r.state !== "completed") {
        try {
          this.c.checkContract?.();
        } catch {
          this.refill();
          continue;
        }
        if (
          !this.c.allowlist.some(
            (a) =>
              a.service === r.principal.service && a.node === r.principal.node,
          )
        ) {
          r.result = this.result(key, "broker caller not authorized");
        } else if (!r.proposal) {
          r.result = this.result(key, "invalid broker proposal");
        } else {
          const write = r.proposal.kind !== "gist_read";
          if (write) {
            r.state = "writing";
            this.persist(r);
          }
          try {
            r.result = this.bounded(
              r,
              await this.c.propose(r.principal, r.proposal),
            );
          } catch {
            r.uncertain = write;
            r.result = this.result(
              key,
              write
                ? "write outcome uncertain; no automatic retry"
                : "broker read unavailable",
            );
          }
        }
        r.state = "completed";
        delete r.proposal;
        this.persist(r);
      }
      if (
        new TextEncoder().encode(r.result!).byteLength > this.c.maxBodyBytes
      ) {
        this.refill();
        continue;
      }
      try {
        await this.attemptReply(r);
      } catch {
        /* Durable result is replayed after redelivery or restart. */
      }
      this.refill();
    }
  }
  private prune() {
    for (const [key, r] of this.records)
      if (
        r.state === "completed" &&
        r.acknowledged &&
        !r.uncertain &&
        !this.queued.has(key) &&
        Date.now() - r.created >= this.retention
      ) {
        unlinkSync(join(this.c.stateRoot, key + ".json"));
        this.records.delete(key);
      }
  }
  async acknowledge(input: BridgeInbound): Promise<void> {
    const p = principal(input.origin);
    const key = hash(JSON.stringify([p ?? input.origin ?? null, input.id]));
    const r = this.records.get(key);
    if (!r || r.fingerprint !== hash(input.text))
      throw new Error("broker bridge ACK mismatch");
    r.acknowledged = true;
    this.persist(r);
  }
  async close(): Promise<void> {
    this.closing = true;
    while (this.running) await this.running;
  }
}
