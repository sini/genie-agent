// Tier 1's tool surface (plan C1, design rows 25 and 26), as a pi extension: exactly the twelve
// tools below. The C1 five act through the supervisor's Host; read, grep, find and ls are pi's
// built-ins, confined to the thread's worktrees; clone asks the mirror fetcher (P1) for a
// worktree; the web tools reach only public addresses, and guard-in screens what they return.
// Nothing else runs: every other tool call is blocked, and so is pi's RPC `bash` command.
import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { checkUrl } from "../mirror/index.ts";
import { errors, forModel, fromModel, load, type Schema } from "./schema.ts";
import { fetchText, refusedList, type Resolver, type Screen, screened, search, systemResolver } from "./web.ts";

export const BUILTINS = ["read", "grep", "find", "ls"] as const;
export const TOOLS = [
  "eval",
  "recall",
  "escalate",
  "reply",
  "propose",
  ...BUILTINS,
  "clone",
  "web_fetch",
  "web_search",
] as const;

// The supervisor's side of each tool's effect (C3 implements it). Arguments arrive validated.
export interface Host {
  eval(request: unknown): Promise<unknown>;
  recall(query: string): Promise<unknown>;
  escalate(escalation: unknown): Promise<unknown>;
  reply(draft: unknown): Promise<unknown>;
  propose(proposal: unknown): Promise<unknown>;
  // The thread's worktree of url from the mirror fetcher (P1's worktreeFor), which runs git
  // outside tier 1.
  clone(url: string): Promise<{ path: string; rev: string }>;
}

export interface Config {
  // The thread's worktree root, `<worktreeRoot>/<thread>`: every clone lands under it.
  root: string;
  searxngUrl: string;
  // CIDRs of the cluster's pod and service networks, refused like the private ranges.
  cluster: string[];
  fetchMaxBytes?: number;
  searchResults?: number;
  timeoutMs?: number;
  // Addresses web_fetch may reach although refused. Tests only.
  exempt?: string[];
}

export interface Deps {
  host: Host;
  // guard-in on a web result (production: xmsg to svc:genie-guard).
  screen: Screen;
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
  on(event: "session_start", handler: () => Promise<void>): void;
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

// The real path `raw` names inside root, or a refusal. Relative paths are taken from root, and
// symlinks and `..` are resolved before the check.
export function confine(root: string, raw: unknown): string {
  const p = raw === undefined || raw === "" ? "." : raw;
  if (typeof p !== "string") throw new Error("the path is not a string");
  if (/^[A-Za-z][A-Za-z0-9+.-]*:|^\/\//.test(p)) throw new Error(`${p} is a URL, not a path`);
  if (/^[~@]/.test(p) || /[\x00-\x1f\x7f]/.test(p) || UNICODE_SPACES.test(p)) throw new Error(`${p} is not a plain path`);
  let top: string;
  try {
    top = realpathSync(root);
  } catch {
    throw new Error("no worktree yet: clone a repository first");
  }
  let real: string;
  try {
    real = realpathSync(isAbsolute(p) ? p : resolve(top, p));
  } catch {
    throw new Error(`${p} does not exist`);
  }
  if (real !== top && !real.startsWith(`${top}/`)) throw new Error(`${p} is outside the thread's worktrees`);
  if (UNICODE_SPACES.test(real)) throw new Error(`${p} is not a plain path`);
  return real;
}

export function tier1(cfg: Config, deps: Deps): (pi: Pi) => void {
  const fetchOptions = {
    resolve: deps.resolve ?? systemResolver,
    refused: refusedList(cfg.cluster),
    exempt: cfg.exempt,
    maxBytes: cfg.fetchMaxBytes ?? 1 << 20,
    timeoutMs: cfg.timeoutMs ?? 15_000,
  };

  // A C1 tool: the repo's schema validates the arguments, then the Host acts.
  const c1 = (name: keyof Omit<Host, "clone">, description: string, schema: Schema, arg: (v: any) => unknown) => ({
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
    c1("eval", "Evaluate one attribute of one repository at one rev (nix eval). Returns {exit, stdout_tail, stderr_tail, limit_hit}.", load("eval-request"), whole),
    c1("recall", "Look up previously answered support questions.", object({ query: nonEmpty }), (v) => v.query),
    c1("escalate", "Hand this thread to the expert tier.", load("escalation"), whole),
    c1("reply", "Post the final draft answer. Call exactly once, last.", load("draft"), whole),
    c1("propose", "Propose a gist or a pull request to the broker. A pull request needs repo and branch.", load("proposal"), whole),
    {
      name: "clone",
      label: "clone",
      description: "Check out a public git repository (https:// or git://) for this thread. Returns the worktree path for read, grep, find and ls.",
      parameters: object({ url: nonEmpty }),
      // A checkout moves files under the confinement root, so no read races it.
      executionMode: "sequential" as const,
      async execute(_id: string, params: { url: string }) {
        checkUrl(params.url);
        const { path, rev } = await deps.host.clone(params.url);
        return text(JSON.stringify({ path: confine(cfg.root, path), rev }));
      },
    },
    {
      name: "web_fetch",
      label: "web_fetch",
      description: "Fetch a public http(s) URL as text (HTML reduced to text, JSON as is).",
      parameters: object({ url: nonEmpty }),
      async execute(_id: string, params: { url: string }) {
        return text(await screened(deps.screen, await fetchText(params.url, fetchOptions)));
      },
    },
    {
      name: "web_search",
      label: "web_search",
      description: "Search the web. Returns the top results as title, url and snippet.",
      parameters: object({ query: nonEmpty }),
      async execute(_id: string, params: { query: string }) {
        const found = await search(cfg.searxngUrl, params.query, cfg.searchResults ?? 5, fetchOptions.timeoutMs);
        return text(await screened(deps.screen, found));
      },
    },
  ];

  return (pi) => {
    for (const t of tools) pi.registerTool(t);
    pi.on("session_start", async () => pi.setActiveTools([...TOOLS]));
    pi.on("tool_call", async (e) => {
      if (!(TOOLS as readonly string[]).includes(e.toolName)) return { block: true, reason: `${e.toolName} is not a tier-1 tool` };
      if (!(BUILTINS as readonly string[]).includes(e.toolName)) return undefined;
      try {
        // The built-in opens exactly the path checked.
        e.input.path = confine(cfg.root, e.input.path);
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
