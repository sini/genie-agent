// The dispatcher's journal (design §5.8, State): everything it must not lose across a kill, in one
// JSON file under the tier's state directory, replaced atomically on every change.
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";

// A supervisor message held for its thread until the session is ready, in arrival order.
export interface Buffered {
  // The supervisor's message id, which the relayed reply answers.
  id: string;
  body: string;
  // The idempotency key (X10), fixed when the message is journalled so every retry reuses it.
  key: string;
}

// A message forwarded to the thread's session and not yet answered.
export interface Outstanding {
  id: string;
  // The forwarded message's id on the tier's xmsg, whose replies end the turn.
  sent: string;
  // Epoch ms; a reply after it is dropped and the turn ends "expert unavailable".
  deadline: number;
}

export interface Thread {
  // The Claude session id: the xmsg sessionId, the --resume key and the transcript name at once.
  session: string;
  // The herdr agent name and the claude `-n` name.
  name: string;
  token: string;
  // The token's own CLAUDE_CONFIG_DIR; --resume needs that account's transcripts.
  configDir: string;
  state: "live" | "parked";
  pane: string | null;
  // False until a launch under `session` has returned: a restart in that window launches the same
  // uuid fresh rather than resuming a session that never ran.
  launched: boolean;
  buffer: Buffered[];
  outstanding: Outstanding[];
  // Epoch ms of the last relayed reply; the park predicate's idle clock starts here.
  lastReply: number | null;
  // Epoch ms when the thread was created/first journalled.
  createdAt?: number;
  // Optional repository names/specs requested for this thread's working copy.
  repos?: string[];
  // The count of messages journalled for the thread, the idempotency key's sequence number.
  seq: number;
}

export type TokenState =
  | { state: "available" }
  | { state: "exhausted-until"; t: string }
  | { state: "removed" };

export interface Journal {
  version: 1;
  threads: Record<string, Thread>;
  tokens: Record<string, TokenState>;
}

const file = (dir: string) => `${dir}/journal.json`;

// Boundary and sink taint patterns (GX1 F1, F5):
// - THREAD_ID_RE allows Matrix room/event IDs (!room:thread-1, $event) and plain thread names,
//   while rejecting ".", "..", any ".." segment, leading "-", "/", "\\", whitespace, and control chars.
export const THREAD_ID_RE = /^(?!-)(?!\.+$)(?!.*\.\.)[A-Za-z0-9_.:$!-]{1,128}$/;
export const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const AGENT_NAME_RE = /^genie-[A-Za-z0-9_.-]{1,64}$/;
export const TOKEN_ID_RE = /^(?!-)(?!\.+$)(?!.*\.\.)[A-Za-z0-9._-]+$/;

export function isValidConfigDir(p: unknown): p is string {
  return (
    typeof p === "string" &&
    p.length > 0 &&
    p.startsWith("/") &&
    !p.includes("\0") &&
    !p.split("/").includes("..")
  );
}

export function validateJournalEntry(id: string, t: Thread): string | null {
  if (!THREAD_ID_RE.test(id)) return `invalid thread id ${JSON.stringify(id)}`;
  if (!t || typeof t !== "object") return "entry is not an object";
  if (typeof t.session !== "string" || !SESSION_UUID_RE.test(t.session)) {
    return `invalid session uuid ${JSON.stringify(t.session)}`;
  }
  if (typeof t.name !== "string" || !AGENT_NAME_RE.test(t.name)) {
    return `invalid agent name ${JSON.stringify(t.name)}`;
  }
  if (!isValidConfigDir(t.configDir)) {
    return `invalid configDir ${JSON.stringify(t.configDir)}`;
  }
  if (typeof t.token !== "string" || !TOKEN_ID_RE.test(t.token)) {
    return `invalid token id ${JSON.stringify(t.token)}`;
  }
  return null;
}

// A missing journal is a first start. An unreadable one throws: an empty map would relaunch every
// known thread fresh.
export function loadJournal(dir: string): Journal {
  if (!existsSync(file(dir))) return { version: 1, threads: {}, tokens: {} };
  const j = JSON.parse(readFileSync(file(dir), "utf8")) as Journal;
  if (j.version !== 1) throw new Error(`${file(dir)}: unknown journal version ${j.version}`);
  if (j.threads && typeof j.threads === "object") {
    for (const [id, t] of Object.entries(j.threads)) {
      // N1 legacy migration runs before validation so pre-GT3 journals (t.token === t.configDir)
      // migrate cleanly to "tier-token" before TOKEN_ID_RE is checked.
      if (
        t &&
        typeof t === "object" &&
        t.token &&
        t.token === t.configDir &&
        typeof t.configDir === "string" &&
        t.configDir.startsWith("/")
      ) {
        const legacyId = t.token;
        t.token = "tier-token";
        if (j.tokens && legacyId in j.tokens) {
          j.tokens["tier-token"] ??= j.tokens[legacyId];
          delete j.tokens[legacyId];
        } else if (j.tokens) {
          j.tokens["tier-token"] ??= { state: "available" };
        }
      }
      const err = validateJournalEntry(id, t);
      if (err !== null) {
        console.error(`journal: refusing invalid thread entry ${JSON.stringify(id)}: ${err}`);
        delete j.threads[id];
      }
    }
  }
  return j;
}

// Write-then-rename, with the file and the directory fsync'd, so a crash leaves the old journal or
// the new one and never a torn one.
export function saveJournal(dir: string, j: Journal): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file(dir)}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(j));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file(dir));
  const dfd = openSync(dir, "r");
  try {
    fsyncSync(dfd);
  } finally {
    closeSync(dfd);
  }
}
