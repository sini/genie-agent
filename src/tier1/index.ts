// Tier 1's tool surface (plan C1, design rows 25 and 26), as a pi extension: exactly the thirteen
// tools below. The C1 five and room_context act through the supervisor's Host; read, grep, find
// and ls are pi's built-ins, confined to the thread's worktrees; clone asks the mirror fetcher (P1)
// for a worktree; the web tools reach only public addresses, and guard-in screens what they return
// through the Host, so tier 1 holds no guard client.
// Nothing else runs: every other tool call is blocked, and so is pi's RPC `bash` command.
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { checkUrl } from "../mirror/index.ts";
import { DEFAULT_SCREEN_MAX_BYTES } from "../supervisor/guard-client.ts";
import { errors, forModel, fromModel, load, type Schema } from "./schema.ts";
import { fetchText, pin, refusedList, type Resolver, search, systemResolver } from "./web.ts";

export { DEFAULT_SCREEN_MAX_BYTES };

export const DEFAULT_MAX_SCRATCH_BYTES = 1024 ** 3; // 1 GiB (GC1 OQ-1, F9)
export const DEFAULT_MAX_SCRATCH_FILES = 4096; // 4,096 files (GC1 OQ-1, F9)

// Operating memory index at memoryPath, as tier 1's system prompt carries it.
// Rewrites relative markdown links to `/memory/<slug>` so tier 1 can pass them directly to read/grep/find/ls.
// Refuses if missing: no silent fallback (Amendment 2).
export function memoryPrompt(memoryPath = "/memory/MEMORY.md"): string {
  try {
    const content = readFileSync(memoryPath, "utf8").replace(
      /\]\((?!https?:\/\/|\/)([^)]+)\)/g,
      "](/memory/$1)",
    );
    return `# Operating Memory Index\n\nOperating-memory files are mounted read-only under \`/memory\`. Pass \`/memory/<slug>\` (for example, \`/memory/workflow/orchestrator-operating-rules.md\`) to \`read\`, \`grep\`, \`find\`, or \`ls\`.\n\n${content}\n`;
  } catch {
    throw new Error(`memory index not found: ${memoryPath}`);
  }
}

export const READ_BUILTINS = ["read", "grep", "find", "ls"] as const;
export const WRITE_BUILTINS = ["write", "edit"] as const;
export const BUILTINS = [...READ_BUILTINS, ...WRITE_BUILTINS] as const;
export const TOOLS = [
  "eval",
  "recall",
  "escalate",
  "reply",
  "propose",
  ...BUILTINS,
  "clone",
  "git",
  "gh_read",
  "web_fetch",
  "web_search",
  "room_context",
] as const;

// The supervisor's side of each tool's effect (C3 implements it). Arguments arrive validated.
export interface Host {
  eval(request: unknown): Promise<unknown>;
  recall(request: { query: string; bank?: "support" | "memory" } | string): Promise<unknown>;
  escalate(escalation: unknown): Promise<unknown>;
  reply(draft: unknown): Promise<unknown>;
  propose(proposal: unknown): Promise<unknown>;
  // The thread's worktree of url from the mirror fetcher (P1's worktreeFor), which runs git
  // outside tier 1.
  clone(url: string): Promise<{ path: string; rev: string }>;
  // Read-only git history queries over the thread's pinned bare mirror (GC1 §2.3, GAP-8).
  git(request: unknown): Promise<unknown>;
  // Read-only GitHub inspection tool over api.github.com (GC1 §2.4, GAP-10).
  gh_read(request: unknown): Promise<unknown>;
  // A web result as the model may see it, screened by guard-in (C3.2's webScreen): the text, the
  // guard's rewrite of it, or a throw that withholds it.
  screen(text: string): Promise<string>;
  // On-demand Matrix room/event/thread context from matrix-xmsg (GI-8, matrix-context-design.md §5.2),
  // sent as a reply to the thread's latest forward and screened by guard-in before returning.
  room_context(request: unknown): Promise<string>;
}

export const QUESTION_TIMEOUT_MS = 600_000;
export const CHECKIN_MS = 300_000;

export interface Config {
  // The thread's worktree root, `<worktreeRoot>/<thread>`: every clone lands under it.
  root: string;
  // Read-only memory mount path (default: /memory)
  memoryRoot?: string;
  searxngUrl: string;
  // CIDRs of the cluster's pod and service networks, refused like the private ranges.
  cluster: string[];
  fetchMaxBytes?: number;
  screenMaxBytes?: number;
  searchResults?: number;
  timeoutMs?: number;
  // Per-question turn deadline (default: 600_000 ms) and check-in (default: 300_000 ms).
  questionTimeoutMs?: number;
  checkinMs?: number;
  // FIFO turn-slot semaphore cap (default: 2) and max queue wait in seconds before fast-escalation (default: 180) (GL1).
  maxConcurrentTurns?: number;
  maxQueueWaitSecs?: number;
  // Optional per-thread scratch write-delta quota (GC1 OQ-1, F9, Q4; default 1 GiB and 4,096 files).
  maxScratchBytes?: number;
  maxScratchFiles?: number;
  // Addresses web_fetch may reach although refused. Tests only.
  exempt?: string[];
  // Test-only source mutant hooks.
  mutants?: {
    // M-write-confine-allow-memory-and-dotdot: replaces confineWrite with read-mode confine.
    writeConfineAllowMemoryAndDotdot?: boolean;
  };
}

export interface Deps {
  host: Host;
  resolve?: Resolver;
}

// The subset of pi's ExtensionAPI (@earendil-works/pi-coding-agent, dist/core/extensions/types.d.ts)
// this extension uses.
type Result = { content: { type: "text"; text: string }[]; details: undefined };
export interface ToolCall {
  toolName: string;
  input: Record<string, unknown>;
}
export interface Pi {
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: Schema;
    executionMode?: "sequential";
    execute(id: string, params: any): Promise<Result>;
  }): void;
  on(event: "tool_call", handler: (e: ToolCall) => Promise<{ block: true; reason: string } | undefined>): void;
  on(event: "user_bash", handler: () => Promise<never>): void;
  on(
    event: "session_start",
    handler: (e: unknown, ctx: { ui: { input(title: string, placeholder?: string): Promise<string | undefined> } }) => Promise<void>,
  ): void;
  setActiveTools(names: string[]): void;
}

const text = (t: string): Result => ({ content: [{ type: "text", text: t }], details: undefined });
const object = (properties: Schema): Schema => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const nonEmpty = { type: "string", minLength: 1 };


// Characters pi's path normalisation rewrites (dist/utils/paths.js normalizePath): a path holding
// one would be checked as one file and opened as another.
const UNICODE_SPACES = /[  -   　]/;

// The real path `raw` names inside root or memoryRoot, or a refusal.
// Relative paths resolve against root (the worktree) only — never falling back to memoryRoot.
// Absolute `/memory` and `/memory/...` paths map to memoryRoot without requiring a worktree.
// Symlinks and `..` are resolved before the containment check.
export function confine(root: string, raw: unknown, memoryRoot = "/memory"): string {
  const p = raw === undefined || raw === "" ? "." : raw;
  if (typeof p !== "string") throw new Error("the path is not a string");
  if (/^[A-Za-z][A-Za-z0-9+.-]*:|^\/\//.test(p)) throw new Error(`${p} is a URL, not a path`);
  if (/^[~@]/.test(p) || /[\x00-\x1f\x7f]/.test(p) || UNICODE_SPACES.test(p)) throw new Error(`${p} is not a plain path`);

  let top: string | undefined;
  if (root) {
    try {
      top = realpathSync(root);
    } catch {
      top = undefined;
    }
  }
  let memTop: string | undefined;
  if (memoryRoot) {
    try {
      memTop = realpathSync(memoryRoot);
    } catch {
      memTop = undefined;
    }
  }

  if (!isAbsolute(p)) {
    if (top === undefined) {
      throw new Error("no worktree yet: clone a repository first; operating-memory files are under /memory/...");
    }
    const candidate = resolve(top, p);
    if (candidate !== top && !candidate.startsWith(`${top}/`)) {
      throw new Error(`${p} is outside the thread's worktrees and memory mount`);
    }
    let real: string;
    try {
      real = realpathSync(candidate);
    } catch {
      throw new Error(`${p} does not exist`);
    }
    if (real !== top && !real.startsWith(`${top}/`)) {
      throw new Error(`${p} is outside the thread's worktrees and memory mount`);
    }
    if (UNICODE_SPACES.test(real)) throw new Error(`${p} is not a plain path`);
    return real;
  }

  let candidate: string;
  if (p === "/memory" || p.startsWith("/memory/")) {
    if (memTop === undefined) {
      throw new Error(`${p} is outside the thread's worktrees and memory mount`);
    }
    const rel = p.slice("/memory".length).replace(/^\/+/, "");
    candidate = rel ? resolve(memTop, rel) : memTop;
    if (candidate !== memTop && !candidate.startsWith(`${memTop}/`)) {
      throw new Error(`${p} is outside the thread's worktrees and memory mount`);
    }
  } else {
    candidate = resolve(p);
  }

  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    throw new Error(`${p} does not exist`);
  }
  const inWorktree = top !== undefined && (real === top || real.startsWith(`${top}/`));
  const inMemory = memTop !== undefined && (real === memTop || real.startsWith(`${memTop}/`));
  if (!inWorktree && !inMemory) throw new Error(`${p} is outside the thread's worktrees and memory mount`);
  if (UNICODE_SPACES.test(real)) throw new Error(`${p} is not a plain path`);
  return real;
}

// Write-mode confinement for `write` and `edit` inside `<worktreeRoot>/<thread>` (GC1 §2.6, F5):
// 1. Explicitly refuses `/memory` and `/memory/...` before any filesystem access.
// 2. Resolves `top = realpathSync(root)` and `candidate = isAbsolute(p) ? resolve(p) : resolve(top, p)`,
//    requiring `candidate !== top && candidate.startsWith(`${top}/`)`.
// 3. Walks up `dirname(candidate)` to the nearest existing ancestor `anc`, computes `realAnc = realpathSync(anc)`,
//    and requires `realAnc === top || realAnc.startsWith(`${top}/`)`.
// 4. Reconstructs `realTarget = resolve(realAnc, relative(anc, candidate))`. If `lstatSync(realTarget)` exists,
//    refuses symlinks (`isSymbolicLink()`) and requires `realpathSync(realTarget).startsWith(`${top}/`)`.
//    For `edit` (`requireExisting: true`), requires `existsSync(realTarget)`.
export function confineWrite(
  root: string,
  raw: unknown,
  opts?: {
    memoryRoot?: string;
    requireExisting?: boolean;
    mutants?: { writeConfineAllowMemoryAndDotdot?: boolean };
  },
): string {
  if (opts?.mutants?.writeConfineAllowMemoryAndDotdot) {
    return confine(root, raw, opts.memoryRoot ?? "/memory");
  }
  const p = raw;
  if (typeof p !== "string" || p.length === 0) throw new Error("the path is not a string");
  if (p === "/memory" || p.startsWith("/memory/")) {
    throw new Error("/memory is read-only");
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:|^\/\//.test(p)) throw new Error(`${p} is a URL, not a path`);
  if (/^[~@]/.test(p) || /[\x00-\x1f\x7f]/.test(p) || UNICODE_SPACES.test(p)) {
    throw new Error(`${p} is not a plain path`);
  }
  if (!root) throw new Error("no worktree root configured");
  let top: string;
  try {
    top = realpathSync(root);
  } catch {
    throw new Error("no worktree root exists yet");
  }
  const candidate = isAbsolute(p) ? resolve(p) : resolve(top, p);
  if (candidate === top || !candidate.startsWith(`${top}/`)) {
    throw new Error(`${p} is outside the thread's worktree`);
  }
  let anc = dirname(candidate);
  while (!existsSync(anc)) {
    const parent = dirname(anc);
    if (parent === anc) throw new Error(`${p} has no existing ancestor`);
    anc = parent;
  }
  let realAnc: string;
  try {
    realAnc = realpathSync(anc);
  } catch {
    throw new Error(`${p} ancestor does not resolve`);
  }
  if (realAnc !== top && !realAnc.startsWith(`${top}/`)) {
    throw new Error(`${p} is outside the thread's worktree`);
  }
  const realTarget = resolve(realAnc, relative(anc, candidate));
  if (realTarget === top || !realTarget.startsWith(`${top}/`)) {
    throw new Error(`${p} is outside the thread's worktree`);
  }
  const st = lstatSync(realTarget, { throwIfNoEntry: false });
  if (st) {
    if (st.isSymbolicLink()) throw new Error(`${p} is a symlink`);
    const realExisting = realpathSync(realTarget);
    if (!realExisting.startsWith(`${top}/`)) {
      throw new Error(`${p} is outside the thread's worktree`);
    }
  } else if (opts?.requireExisting) {
    throw new Error(`${p} does not exist`);
  }
  if (UNICODE_SPACES.test(realTarget)) throw new Error(`${p} is not a plain path`);
  return realTarget;
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

// Slice one screened window [offset, end) of at most maxBytes from buf, cutting at the last
// newline within the window when one exists before EOF (or at a UTF-8 codepoint boundary otherwise).
export function sliceWebPage(
  buf: Uint8Array,
  offset: number,
  maxBytes = DEFAULT_SCREEN_MAX_BYTES,
): { page: string; end: number; total: number; paged: boolean } {
  const total = buf.length;
  if (offset === 0 && total <= maxBytes) {
    return { page: utf8Decoder.decode(buf), end: total, total, paged: false };
  }
  if (offset >= total) {
    return { page: "", end: total, total, paged: true };
  }
  const maxEnd = Math.min(offset + maxBytes, total);
  let end = maxEnd;
  if (maxEnd < total) {
    const lastNl = buf.subarray(offset, maxEnd).lastIndexOf(0x0a);
    if (lastNl !== -1) {
      end = offset + lastNl + 1;
    } else {
      while (end > offset && (buf[end] & 0xc0) === 0x80) end--;
      if (end === offset) end = maxEnd;
    }
  }
  return { page: utf8Decoder.decode(buf.subarray(offset, end)), end, total, paged: true };
}

export function tier1(cfg: Config, deps: Deps): (pi: Pi) => void {
  const fetchOptions = {
    resolve: deps.resolve ?? systemResolver,
    refused: refusedList(cfg.cluster),
    exempt: cfg.exempt,
    maxBytes: cfg.fetchMaxBytes ?? 1 << 20,
    timeoutMs: cfg.timeoutMs ?? 15_000,
  };
  const screenMaxBytes = cfg.screenMaxBytes ?? DEFAULT_SCREEN_MAX_BYTES;
  const webFetchCache = new Map<string, Uint8Array>();
  const webFetchSchema: Schema = {
    type: "object",
    additionalProperties: false,
    required: ["url"],
    properties: {
      url: nonEmpty,
      offset: {
        type: "integer",
        minimum: 0,
        description: "Byte offset for paging a long document (default: 0).",
      },
    },
  };

  const roomContextSchema: Schema = {
    type: "object",
    additionalProperties: false,
    required: ["scope"],
    properties: {
      scope: {
        type: "string",
        enum: ["room", "event", "thread"],
        description:
          'Query scope: "room" for recent room messages, "event" for a specific event by id, or "thread" for messages in a specific thread.',
      },
      before: {
        type: "string",
        minLength: 1,
        description:
          'For scope "room": event id cursor to list messages before (default: the triggering message).',
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 20,
        description: 'For scope "room": maximum number of messages to return (1-20, default: 10).',
      },
      sender: {
        type: "string",
        minLength: 1,
        description:
          'For scope "room": filter messages by sender display name or Matrix user id.',
      },
      event: {
        type: "string",
        minLength: 1,
        description: 'For scope "event": the event id to fetch.',
      },
      thread: {
        type: "string",
        minLength: 1,
        description: 'For scope "thread": the thread root event id to fetch.',
      },
      offset: {
        type: "integer",
        minimum: 0,
        description:
          'For scope "thread": message offset for paging a truncated thread (default: 0).',
      },
    },
  };

  // Per-process write-delta ledger for `write` and `edit` (GC1 OQ-1, F9, Q4: resets when pi restarts on park/resume by design).
  const scratchLedger = new Map<string, number>();
  const maxScratchFiles = cfg.maxScratchFiles ?? DEFAULT_MAX_SCRATCH_FILES;
  const maxScratchBytes = cfg.maxScratchBytes ?? DEFAULT_MAX_SCRATCH_BYTES;

  // A C1 tool: the repo's schema validates the arguments, then the Host acts.
  const c1 = (name: keyof Omit<Host, "clone" | "screen" | "room_context">, description: string, schema: Schema, arg: (v: any) => unknown) => ({
    name,
    label: name,
    description,
    parameters: forModel(schema),
    async execute(_id: string, params: unknown) {
      const value = fromModel(schema, params);
      const bad = errors(schema, value);
      if (bad.length) throw new Error(`invalid ${name} arguments: ${bad.join("; ")}`);
      return text(JSON.stringify(await deps.host[name](arg(value) as any)));
    },
  });
  const whole = (v: unknown) => v;

  const tools = [
    c1("eval", "Evaluate one attribute of one repository at one rev or a relative worktreeSubdir (nix eval). Set secrets: \"stub\" when agenix/sops secrets block pure-eval; pass apply for a pure Nix function. Returns {exit, stdout_tail, stderr_tail, limit_hit}.", load("eval-request"), whole),
    c1(
      "recall",
      'Search a memory bank: "support" (default) holds the support memory (curated answers); "memory" holds the operating memory (tool usage, debugging techniques, gen/den reference). A question about how to do something with a tool or the gen libraries should recall "memory".',
      {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: nonEmpty,
          bank: {
            type: "string",
            enum: ["support", "memory"],
            description: 'Target bank: "support" (default) for the support memory (curated answers), or "memory" for the operating memory (tool usage, debugging techniques, gen/den reference). A question about how to do something with a tool or the gen libraries should recall "memory".',
          },
        },
      },
      (v) => (v.bank !== undefined ? { query: v.query, bank: v.bank } : v.query),
    ),
    c1("escalate", "Hand this thread to the expert tier.", load("escalation"), whole),
    c1("reply", "Post the final draft answer. Call exactly once, last.", load("draft"), whole),
    c1("propose", "Propose a gist or a pull request to the broker. A pull request needs repo and branch, plus inline files or worktreeSubdir.", load("proposal"), whole),
    c1("git", "Run a read-only git query (log, show, diff, blame, grep) against a repository already cloned in this thread.", load("git-request"), whole),
    c1("gh_read", "Read public GitHub issues, pull requests, diffs, check runs, gists, or workflow runs.", load("gh-read"), whole),
    {
      name: "clone",
      label: "clone",
      description: "Check out a public git repository (https://) for this thread. Returns the worktree path for read, grep, find, ls, write and edit.",
      parameters: object({ url: nonEmpty }),
      // A checkout moves files under the confinement root, so no read races it.
      executionMode: "sequential" as const,
      async execute(_id: string, params: { url: string }) {
        const u = checkUrl(params.url);
        await pin(u, fetchOptions);
        const { path, rev } = await deps.host.clone(params.url);
        return text(JSON.stringify({ path: confine(cfg.root, path, cfg.memoryRoot), rev }));
      },
    },
    {
      name: "web_fetch",
      label: "web_fetch",
      description: "Fetch a public http(s) URL as text (HTML reduced to text, JSON as is). A long document comes in screened parts; pass offset (in bytes) to page when the rest is needed.",
      parameters: forModel(webFetchSchema),
      async execute(_id: string, rawParams: { url: string; offset?: number }) {
        const value = fromModel(webFetchSchema, rawParams);
        const bad = errors(webFetchSchema, value);
        if (bad.length) throw new Error(`invalid web_fetch arguments: ${bad.join("; ")}`);
        const params = value as { url: string; offset?: number };
        const offset = params.offset ?? 0;
        let buf = webFetchCache.get(params.url);
        if (!buf) {
          const fetched = await fetchText(params.url, fetchOptions);
          buf = utf8Encoder.encode(fetched);
          webFetchCache.set(params.url, buf);
        }
        const { page, end, total, paged } = sliceWebPage(buf, offset, screenMaxBytes);
        if (!paged) {
          return text(await deps.host.screen(page));
        }
        const footer =
          end < total
            ? `[bytes ${offset}–${end} of ${total} shown; call web_fetch again with offset=${end} for the next part]`
            : `[end of document]`;
        if (page.length === 0 && offset >= total) {
          return text(footer);
        }
        let screened: string;
        try {
          screened = await deps.host.screen(page);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const withheldFooter =
            end < total
              ? `[bytes ${offset}–${end} of ${total} withheld; call web_fetch again with offset=${end} for the next part]`
              : `[end of document]`;
          throw new Error(`${msg}\n${withheldFooter}`);
        }
        return text(`${screened}\n${footer}`);
      },
    },
    {
      name: "web_search",
      label: "web_search",
      description: "Search the web. Returns the top results as title, url and snippet.",
      parameters: object({ query: nonEmpty }),
      async execute(_id: string, params: { query: string }) {
        const found = await search(cfg.searxngUrl, params.query, cfg.searchResults ?? 5, fetchOptions.timeoutMs);
        return text(await deps.host.screen(found));
      },
    },
    {
      name: "room_context",
      label: "room_context",
      description:
        "Fetch additional context from the current Matrix room: recent room messages (scope: \"room\", optional before/limit/sender), a specific event by id (scope: \"event\", event), or messages in a thread (scope: \"thread\", thread, optional offset). The room is always bound by the bot from the current conversation.",
      parameters: forModel(roomContextSchema),
      async execute(_id: string, rawParams: unknown) {
        const value = fromModel(roomContextSchema, rawParams);
        const bad = errors(roomContextSchema, value);
        if (bad.length) throw new Error(`invalid room_context arguments: ${bad.join("; ")}`);
        const res = await deps.host.room_context({ context: value });
        return text(typeof res === "string" ? res : JSON.stringify(res));
      },
    },
  ];

  return (pi) => {
    for (const t of tools) pi.registerTool(t);
    pi.on("session_start", async () => pi.setActiveTools([...TOOLS]));
    pi.on("tool_call", async (e) => {
      if (!(TOOLS as readonly string[]).includes(e.toolName)) return { block: true, reason: `${e.toolName} is not a tier-1 tool` };
      if ((WRITE_BUILTINS as readonly string[]).includes(e.toolName)) {
        try {
          const realTarget = confineWrite(cfg.root, e.input.path, {
            memoryRoot: cfg.memoryRoot,
            requireExisting: e.toolName === "edit",
            mutants: cfg.mutants,
          });
          let newBytes = 0;
          if (e.toolName === "write") {
            newBytes = utf8Encoder.encode(typeof e.input.content === "string" ? e.input.content : "").byteLength;
          } else {
            const existingSize = existsSync(realTarget) ? statSync(realTarget).size : 0;
            const oldLen = utf8Encoder.encode(typeof e.input.oldText === "string" ? e.input.oldText : "").byteLength;
            const newLen = utf8Encoder.encode(typeof e.input.newText === "string" ? e.input.newText : "").byteLength;
            newBytes = Math.max(0, existingSize - oldLen + newLen);
          }
          if (!scratchLedger.has(realTarget) && scratchLedger.size + 1 > maxScratchFiles) {
            return { block: true, reason: `refused: scratch file quota (${maxScratchFiles} files) exceeded` };
          }
          const currentTotal = Array.from(scratchLedger.values()).reduce((a, b) => a + b, 0);
          const prevBytes = scratchLedger.get(realTarget) ?? 0;
          if (currentTotal - prevBytes + newBytes > maxScratchBytes) {
            return { block: true, reason: `refused: scratch byte quota (${maxScratchBytes} bytes) exceeded` };
          }
          scratchLedger.set(realTarget, newBytes);
          e.input.path = realTarget;
        } catch (err) {
          return { block: true, reason: `refused: ${(err as Error).message}` };
        }
        return undefined;
      }
      if (!(READ_BUILTINS as readonly string[]).includes(e.toolName)) return undefined;
      try {
        // The built-in opens exactly the path checked.
        e.input.path = confine(cfg.root, e.input.path, cfg.memoryRoot);
      } catch (err) {
        return { block: true, reason: `refused: ${(err as Error).message}` };
      }
      return undefined;
    });
    // pi's RPC `bash` command runs a shell outside the tool list; a throwing handler blocks it.
    pi.on("user_bash", async () => {
      throw new Error("shell disabled in genie tier 1");
    });
  };
}
