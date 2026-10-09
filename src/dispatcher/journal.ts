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

// A message held for a parked thread until its session is ready (D1b drains it).
export interface Buffered {
  id: string;
  body: unknown;
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
  // Supervisor message ids forwarded and not yet replied to.
  outstanding: string[];
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

// A missing journal is a first start. An unreadable one throws: an empty map would relaunch every
// known thread fresh.
export function loadJournal(dir: string): Journal {
  if (!existsSync(file(dir))) return { version: 1, threads: {}, tokens: {} };
  const j = JSON.parse(readFileSync(file(dir), "utf8")) as Journal;
  if (j.version !== 1) throw new Error(`${file(dir)}: unknown journal version ${j.version}`);
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
