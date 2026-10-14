// The thread-state store (plan P2, design §6): per thread, on a path that is a Longhorn PVC in
// prod, the tier (schemas/thread-state.json), the eval-result cache keyed (repo, rev, attr, flags),
// and the transcript. The transcript is pi's own session file: the store owns the directory pi is
// launched with (`--session-dir`, under a fixed `--session-id`), so a fresh pi process resumes the
// thread's conversation (design row 21) and there is no second transcript format. The thread's Nix
// store, mounted only into its eval Jobs, is a separate root, so state is never inside it.
// Collection is P3's, src/gc, and the archive P4's; parking and closing are C4's, src/lifecycle.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";

export type Tier = "public" | "trusted";

export interface Tombstone {
  archived: true;
  tier: Tier;
}

export interface BlockedExpertReply {
  tier: Tier;
}

// One record of schemas/thread-state.json.
export interface ThreadState {
  thread_id: string;
  status: "active" | "escalated" | "closed";
  created: string;
  last_active: string;
  sender_tier: Tier;
}

// The thread's latest escalation package and the sequence number of its draft (C5); body is the
// package as guarded and stamped, kept so a resend repeats it byte for byte.
export interface EscalationRecord {
  seq: number;
  pkg: unknown;
  body?: string;
}

// The thread tier's state beside sender_tier (C7, src/tier): the senders whose text the thread has
// carried, those present at its last `!trust`, and the tier of the thread's first sender.
export interface TrustState {
  initiator: Tier;
  participants: string[];
  sanctioned: string[];
}

export interface CacheKey {
  repo: string;
  rev: string;
  attr: string;
  flags: string[];
}

// pi names a session file after its id; one session per thread directory, so the id is fixed.
const SESSION_ID = "thread";

// A thread id becomes a path component under both roots, so it may not name another directory.
export function checkThread(thread: string): string {
  if (!thread || thread === "." || thread.includes("..") || thread.includes("/") || thread.includes("\0"))
    throw new Error(`thread state: refused thread id ${JSON.stringify(thread)}`);
  return thread;
}

// Write the whole file or none of it: a temp file in the same directory, fsynced, then renamed.
function writeAtomic(dir: string, name: string, data: string): void {
  const tmp = `${dir}/.${name}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, `${dir}/${name}`);
  const dfd = openSync(dir, "r");
  try {
    fsyncSync(dfd);
  } finally {
    closeSync(dfd);
  }
}

function readJson<T>(file: string): T | undefined {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : undefined;
}

export class ThreadStateStore {
  readonly stateRoot: string;
  readonly storeRoot: string;

  constructor(stateRoot: string, storeRoot: string) {
    this.stateRoot = stateRoot;
    this.storeRoot = storeRoot;
  }

  // The thread's state directory, created on first use.
  dir(thread: string): string {
    const d = `${this.stateRoot}/${checkThread(thread)}`;
    mkdirSync(`${d}/session`, { recursive: true, mode: 0o700 });
    return d;
  }

  // The thread's Nix store root, for its eval Jobs only.
  store(thread: string): string {
    const d = `${this.storeRoot}/${checkThread(thread)}`;
    mkdirSync(d, { recursive: true, mode: 0o700 });
    return d;
  }

  // The pi arguments that bind a process to this thread's transcript, for C3's `Launch`.
  sessionArgs(thread: string): string[] {
    return ["--session-dir", `${this.dir(thread)}/session`, "--session-id", SESSION_ID];
  }

  read(thread: string): ThreadState | undefined {
    return readJson<ThreadState>(`${this.dir(thread)}/state.json`);
  }

  write(state: ThreadState): void {
    writeAtomic(this.dir(state.thread_id), "state.json", JSON.stringify(state));
  }

  // The thread's user messages pi has not answered, which its session does not yet hold (C4).
  pending(thread: string): string[] {
    return readJson<string[]>(`${this.dir(thread)}/pending.json`) ?? [];
  }

  setPending(thread: string, messages: string[]): void {
    writeAtomic(this.dir(thread), "pending.json", JSON.stringify(messages));
  }

  escalation(thread: string): EscalationRecord | undefined {
    return readJson<EscalationRecord>(`${this.dir(thread)}/escalation.json`);
  }

  setEscalation(thread: string, rec: EscalationRecord): void {
    writeAtomic(this.dir(thread), "escalation.json", JSON.stringify(rec));
  }

  trust(thread: string): TrustState | undefined {
    return readJson<TrustState>(`${this.dir(thread)}/trust.json`);
  }

  setTrust(thread: string, trust: TrustState): void {
    writeAtomic(this.dir(thread), "trust.json", JSON.stringify(trust));
  }

  cacheGet(thread: string, key: CacheKey): unknown {
    return readJson<Record<string, unknown>>(`${this.dir(thread)}/cache.json`)?.[cacheKey(key)];
  }

  // ponytail: read-modify-write of one file, sound for the one supervisor process that owns the
  // PVC; a lock is owed if a second writer ever shares stateRoot.
  cachePut(thread: string, key: CacheKey, value: unknown): void {
    const d = this.dir(thread);
    const cache = readJson<Record<string, unknown>>(`${d}/cache.json`) ?? {};
    cache[cacheKey(key)] = value;
    writeAtomic(d, "cache.json", JSON.stringify(cache));
  }

  // A local tombstone left by GC collection (plan P5, design §6): marks an archived thread so only
  // tombstoned threads replay from S3. Single deterministic path under ${stateRoot}/.tombstones/${thread}.json.
  private tombstonePath(thread: string): string {
    return `${this.stateRoot}/.tombstones/${checkThread(thread)}.json`;
  }

  tombstone(thread: string): Tombstone | undefined {
    return readJson<Tombstone>(this.tombstonePath(thread));
  }

  setTombstone(thread: string, tombstone: Tombstone): void {
    const d = `${this.stateRoot}/.tombstones`;
    mkdirSync(d, { recursive: true, mode: 0o700 });
    writeAtomic(d, `${checkThread(thread)}.json`, JSON.stringify(tombstone));
  }

  clearTombstone(thread: string): void {
    const f = this.tombstonePath(thread);
    if (existsSync(f)) rmSync(f, { recursive: false, force: true });
  }

  // Blocked expert replies (plan C8, design §4 step 6, §5.8): dropped from context and transcript,
  // recorded with a tier label only for the permanent archive (P4).
  blockedExpertReplies(thread: string): BlockedExpertReply[] {
    return readJson<BlockedExpertReply[]>(`${this.dir(thread)}/blocked_expert_replies.json`) ?? [];
  }

  addBlockedExpertReply(thread: string, tier: Tier): void {
    const current = this.blockedExpertReplies(thread);
    writeAtomic(this.dir(thread), "blocked_expert_replies.json", JSON.stringify([...current, { tier }]));
  }
}

const cacheKey = ({ repo, rev, attr, flags }: CacheKey) => JSON.stringify([repo, rev, attr, flags]);
