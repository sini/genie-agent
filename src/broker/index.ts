// The action broker (design §5.6): the only holder of the genie-bot token. A proposal is parsed
// against schemas/proposal.json, redacted, judged by guard-out, and only then acted on. Every
// failure fails closed: an unparseable proposal, a guard-out block, a guard-out error and an
// unreadable token are each not acted on, with the reason recorded.
//
// The redactor runs BEFORE guard-out, once, over every string that will leave. Guard-out is a
// model, and a credential must never enter a model's context (§5.2 item 6), and the act then
// publishes exactly the bytes guard-out passed. Guard-out still sees the `[redacted:<kind>]` mark.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { resolveWorktreeSubdir, WORKTREE_SUBDIR_RE } from "../eval/run.ts";
import { reviewOut, type NinferOut } from "../guard/service.ts";
import { listMirrorTree, mirrorKey, readMirrorPin } from "../mirror/index.ts";
import { redact } from "../redactor/index.ts";
import { errors, load } from "../tier1/schema.ts";

export interface PrTreeEntry {
  path: string;
  mode: "100644" | "100755" | "120000";
  type: "blob";
  content?: string;
  sha?: null;
}

// One record of schemas/proposal.json.
interface ProposalFields {
  kind: "gist" | "pr" | "gist_read" | "gist_update" | "gist_comment";
  id?: string;
  public?: boolean;
  repo?: string;
  branch?: string;
  commits?: string[];
  files?: Record<string, string>;
  worktreeSubdir?: string;
  // Populated by genie-root/broker when diffing `worktreeSubdir` against the pinned mirror base tree.
  treeEntries?: PrTreeEntry[];
  baseTreeSha?: string;
  baseCommitSha?: string;
  title?: string;
  body?: string;
}

export type Proposal = ProposalFields & (
  | { kind: "gist" | "pr"; title: string; body: string }
  | { kind: "gist_read"; id: string }
  | { kind: "gist_update"; id: string; files: Record<string, string> }
  | { kind: "gist_comment"; id: string; body: string }
);

export const GIST_READ_MAX_BYTES = 65_536;
export const GIST_METADATA_MAX_BYTES = 1_048_576;

export interface GistReadResult {
  untrusted: true;
  id: string;
  url: string;
  description: string;
  owner: string | null;
  revision: string;
  files: Record<string, string>;
}
export interface ActResult {
  url: string;
  gist?: GistReadResult;
}

export function normalizeGistId(input: string): string {
  if (typeof input !== "string" || input.length > 4096 || /[\s\x00-\x1f\x7f]/u.test(input)) {
    throw new Error("invalid gist ID or URL");
  }
  if (/^[0-9a-f]{1,64}$/i.test(input)) return input.toLowerCase();
  let url: URL;
  try { url = new URL(input); } catch { throw new Error("invalid gist ID or URL"); }
  const authority = input.split("://")[1]?.split(/[/?#]/)[0] ?? "";
  if (url.protocol !== "https:" || url.hostname !== "gist.github.com" || url.port || authority.includes("@") || url.username || url.password) {
    throw new Error("invalid gist ID or URL");
  }
  const match = /^https:\/\/gist\.github\.com\/(?:[A-Za-z0-9][A-Za-z0-9-]{0,38}\/)?([0-9a-f]{1,64})\/?(?:[?#].*)?$/i.exec(input);
  if (!match) throw new Error("invalid gist ID or URL");
  return match[1].toLowerCase();
}

export const BOT_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
export const DEFAULT_BOT_LOGIN = "genie-bot";
export const DEFAULT_FORBIDDEN_LOGINS: readonly string[] = [];

export const REPO_COORD_RE =
  /^[A-Za-z0-9_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*\/[A-Za-z0-9_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$/;
export const BRANCH_REF_RE =
  /^[A-Za-z0-9_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*(?:\/[A-Za-z0-9_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*)*$/;
export const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;

export function isValidRepoCoord(repo: unknown): repo is string {
  if (typeof repo !== "string" || !REPO_COORD_RE.test(repo) || repo.includes("..")) return false;
  const parts = repo.split("/");
  return (
    parts.length === 2 &&
    parts.every((seg) => seg.length > 0 && seg !== "." && seg !== ".." && !seg.startsWith("-") && !seg.endsWith(".lock"))
  );
}

export function isValidBranchRef(branch: unknown): branch is string {
  if (typeof branch !== "string" || !BRANCH_REF_RE.test(branch) || branch.includes("..")) return false;
  const parts = branch.split("/");
  return (
    parts.length >= 1 &&
    parts.every(
      (seg) =>
        seg.length > 0 &&
        seg !== "." &&
        seg !== ".." &&
        !seg.startsWith("-") &&
        !seg.startsWith(".") &&
        !seg.endsWith(".") &&
        !seg.endsWith(".lock"),
    )
  );
}

export function isValidProposalFilePath(path: unknown, kind: "gist" | "pr"): path is string {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.startsWith("-")
  ) {
    return false;
  }
  if (kind === "gist" && path.includes("/")) return false;
  const parts = path.split("/");
  return parts.every((seg) => seg.length > 0 && seg !== "." && seg !== ".." && !seg.startsWith("-"));
}

export function validateProposalFields(p: Proposal): string | null {
  if (["gist_read", "gist_update", "gist_comment"].includes(p.kind)) {
    const allowed = new Set(p.kind === "gist_read" ? ["kind", "id"] : p.kind === "gist_update" ? ["kind", "id", "files", "title"] : ["kind", "id", "body"]);
    if (Object.keys(p).some((field) => !allowed.has(field))) return "proposal contains a field not permitted for its kind";
    try { normalizeGistId(p.id!); } catch { return "$.id is not a gist ID or canonical gist URL"; }
    if (p.kind === "gist_read") return null;
    if (p.kind === "gist_comment") return typeof p.body === "string" && p.body.trim().length > 0 ? null : "$.body must be nonempty";
    if (p.title !== undefined && (typeof p.title !== "string" || !p.title.trim())) return "$.title must be nonempty when supplied";
  } else if (p.kind !== "gist" && p.kind !== "pr") {
    return "unknown proposal kind";
  }
  if (p.public !== undefined && (p.kind !== "gist" || typeof p.public !== "boolean")) return "$.public is only a boolean for gist creation";
  if ((p.kind === "gist" || p.kind === "pr") && (typeof p.title !== "string" || !p.title.length || typeof p.body !== "string")) return "legacy gist/PR requires title and body";
  const hasFiles = p.files !== undefined;
  const hasSubdir = p.worktreeSubdir !== undefined;
  if (hasFiles && hasSubdir) {
    return "$.files and $.worktreeSubdir are mutually exclusive";
  }
  if (!hasFiles && !hasSubdir) {
    return "$.files must have at least 1 file";
  }
  if (hasFiles) {
    if (!p.files || typeof p.files !== "object" || Array.isArray(p.files) || Object.keys(p.files).length < 1) {
      return "$.files must have at least 1 file";
    }
    for (const k of Object.keys(p.files)) {
      if (typeof p.files[k] !== "string") return "$.files must contain string content";
      if (!isValidProposalFilePath(k, p.kind === "pr" ? "pr" : "gist")) {
        return `$.files[${JSON.stringify(k)}] is not a valid file path`;
      }
    }
  }
  if (hasSubdir) {
    if (p.kind !== "pr") {
      return "$.worktreeSubdir is only valid for kind === 'pr'";
    }
    if (
      typeof p.worktreeSubdir !== "string" ||
      !WORKTREE_SUBDIR_RE.test(p.worktreeSubdir) ||
      p.worktreeSubdir.split("/").some((s) => s === "." || s === "..")
    ) {
      return `$.worktreeSubdir is not a valid relative worktree path: ${JSON.stringify(p.worktreeSubdir)}`;
    }
  }
  if (p.repo !== undefined && !isValidRepoCoord(p.repo)) {
    return `$.repo is not a valid owner/repo coordinate: ${JSON.stringify(p.repo)}`;
  }
  if (p.branch !== undefined && !isValidBranchRef(p.branch)) {
    return `$.branch is not a valid git branch ref: ${JSON.stringify(p.branch)}`;
  }
  if (p.kind === "pr") {
    if (!isValidRepoCoord(p.repo)) {
      return `$.repo is not a valid owner/repo coordinate: ${JSON.stringify(p.repo)}`;
    }
    if (!isValidBranchRef(p.branch)) {
      return `$.branch is not a valid git branch ref: ${JSON.stringify(p.branch)}`;
    }
  }
  if (p.commits !== undefined) {
    if (!Array.isArray(p.commits) || p.commits.length < 1 || !p.commits.every((c) => typeof c === "string" && COMMIT_SHA_RE.test(c))) {
      return "$.commits must be a non-empty array of 40-hex commit SHAs";
    }
  }
  return null;
}

const verifiedIdentities = new WeakSet<VerifiedBotIdentity>();

export interface VerifiedBotIdentity {
  readonly githubApi: string;
  readonly credentialVersion: string;
  readonly botLogin: string;
  readonly forbiddenKey: string;
  readonly login: string;
}

export function credentialVersion(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function normalizeGithubApi(githubApi: string): string {
  return githubApi.replace(/\/+$/, "");
}

function normalizeForbiddenKey(forbiddenLogins: readonly string[]): string {
  return JSON.stringify([...new Set(forbiddenLogins.map((f) => f.toLowerCase()))].sort());
}

export async function verifyBotIdentity(
  githubApi: string,
  token: string,
  botLogin: string,
  forbiddenLogins: readonly string[] = [],
  timeoutMs = 15_000,
): Promise<string> {
  if (!BOT_LOGIN_RE.test(botLogin)) {
    throw new Error(`invalid broker.botLogin: ${botLogin}`);
  }
  if (forbiddenLogins.some((f) => f.toLowerCase() === botLogin.toLowerCase())) {
    throw new Error(`broker.botLogin ${botLogin} is in forbiddenLogins`);
  }
  const base = normalizeGithubApi(githubApi);
  const res = await fetch(`${base}/user`, {
    method: "GET",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "genie-agent",
    },
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status >= 300 && res.status < 400) {
    throw new Error("broker identity check: HTTP redirect refused");
  }
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`broker identity check GET /user failed: HTTP ${res.status}`);
  }
  const user = JSON.parse(text) as { login?: unknown };
  const login = typeof user?.login === "string" ? user.login : "";
  if (!login) {
    throw new Error("broker identity check: /user response missing login");
  }
  if (forbiddenLogins.some((f) => f.toLowerCase() === login.toLowerCase())) {
    throw new Error(`broker token identity forbidden: ${login}`);
  }
  if (login.toLowerCase() !== botLogin.toLowerCase()) {
    throw new Error(`broker token identity mismatch: expected ${botLogin}, got ${login}`);
  }
  return login;
}

export async function verifyBotIdentityContext(
  githubApi: string,
  token: string,
  botLogin: string,
  forbiddenLogins: readonly string[] = [],
  timeoutMs = 15_000,
): Promise<VerifiedBotIdentity> {
  const login = await verifyBotIdentity(githubApi, token, botLogin, forbiddenLogins, timeoutMs);
  const verified: VerifiedBotIdentity = Object.freeze({
    githubApi: normalizeGithubApi(githubApi),
    credentialVersion: credentialVersion(token),
    botLogin: botLogin.toLowerCase(),
    forbiddenKey: normalizeForbiddenKey(forbiddenLogins),
    login,
  });
  verifiedIdentities.add(verified);
  return verified;
}

export async function ensureBotIdentity(
  githubApi: string,
  token: string,
  botLogin: string,
  forbiddenLogins: readonly string[] = [],
  timeoutMs = 15_000,
  verifiedIdentity?: VerifiedBotIdentity,
): Promise<string> {
  if (
    verifiedIdentity &&
    verifiedIdentities.has(verifiedIdentity) &&
    verifiedIdentity.githubApi === normalizeGithubApi(githubApi) &&
    verifiedIdentity.credentialVersion === credentialVersion(token) &&
    verifiedIdentity.botLogin === botLogin.toLowerCase() &&
    verifiedIdentity.forbiddenKey === normalizeForbiddenKey(forbiddenLogins)
  ) {
    return verifiedIdentity.login;
  }
  return verifyBotIdentity(githubApi, token, botLogin, forbiddenLogins, timeoutMs);
}

async function resolveCommitTreeSha(bareDir: string, commitRev: string): Promise<string> {
  return new Promise<string>((resolveSha, reject) => {
    const child = spawn(
      "git",
      [
        "-c",
        "protocol.allow=never",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        `--git-dir=${bareDir}`,
        "rev-parse",
        "--verify",
        `${commitRev}^{tree}`,
      ],
      {
        cwd: "/",
        env: {
          PATH: process.env.PATH,
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolveSha(out.trim());
      else reject(new Error(`git rev-parse tree: ${err.trim() || `exit ${code}`}`));
    });
  });
}

// Computes the Git tree delta of `<worktreeRoot>/<thread>/<worktreeSubdir>` against the thread's
// pinned base commit in `<mirrorRoot>/<key>` purely in Node (GC1 §2.6.2, F2, F4, Gate v1 C1 & C-N4).
// Never runs `git` inside the writable worktree, ignores `.git` entries, refuses symlinks, ignores
// `160000` gitlinks, and scopes `ls-tree` to the walked prefix so files outside a subdirectory
// worktreeSubdir are never marked deleted (Gate v1 C-N4).
export async function computeWorktreeDiff(opts: {
  mirrorRoot: string;
  worktreeRoot: string;
  thread: string;
  repo: string;
  worktreeSubdir: string;
  repoUrlBase?: string;
}): Promise<{
  entries: PrTreeEntry[];
  baseCommitSha: string;
  baseTreeSha: string;
}> {
  if (!isValidRepoCoord(opts.repo)) {
    throw new Error(`invalid repo coordinate: ${opts.repo}`);
  }
  const resolvedSubdir = resolveWorktreeSubdir(opts.worktreeRoot, opts.thread, opts.worktreeSubdir);
  const segs = opts.worktreeSubdir.split("/");
  const firstSeg = segs[0] ?? "";
  const urlBase = (opts.repoUrlBase ?? "https://github.com").replace(/\/+$/, "");
  const expectedKey = mirrorKey(`${urlBase}/${opts.repo}`);
  // Gate v1 C-N4: require worktreeSubdir's first segment to equal mirrorKey("https://github.com/" + repo).
  if (firstSeg !== expectedKey) {
    throw new Error(
      `worktreeSubdir first segment must match the cloned mirror key for ${opts.repo} (expected ${expectedKey}, got ${firstSeg})`,
    );
  }
  const bareDir = `${opts.mirrorRoot}/${expectedKey}`;
  const pin = readMirrorPin(bareDir, opts.thread);
  if (!pin) {
    throw new Error(`clone https://github.com/${opts.repo} in this thread before proposing from worktreeSubdir`);
  }
  const subPrefix = segs.slice(1).join("/");
  const baseList = await listMirrorTree(bareDir, pin.rev, subPrefix || undefined);
  const baseTreeSha = await resolveCommitTreeSha(bareDir, pin.rev);
  const baseMap = new Map(baseList.map((e) => [e.path, e]));

  const diskFiles = new Map<string, { mode: "100644" | "100755"; sha: string; content: string }>();
  const walk = (dir: string, relPrefix: string) => {
    for (const dirent of readdirSync(dir, { withFileTypes: true })) {
      if (dirent.name === ".git") continue;
      const fullPath = `${dir}/${dirent.name}`;
      const relToSub = relPrefix ? `${relPrefix}/${dirent.name}` : dirent.name;
      const st = lstatSync(fullPath);
      if (st.isSymbolicLink()) {
        throw new Error(`worktreeSubdir contains a symlink at ${relToSub}`);
      }
      if (st.isDirectory()) {
        walk(fullPath, relToSub);
      } else if (st.isFile()) {
        const repoRelPath = subPrefix ? `${subPrefix}/${relToSub}` : relToSub;
        if (!isValidProposalFilePath(repoRelPath, "pr")) {
          throw new Error(`worktreeSubdir contains invalid file path ${repoRelPath}`);
        }
        const buf = readFileSync(fullPath);
        const sha = createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
        const mode: "100644" | "100755" = (st.mode & 0o111) !== 0 ? "100755" : "100644";
        diskFiles.set(repoRelPath, { mode, sha, content: buf.toString("utf8") });
      } else {
        throw new Error(`worktreeSubdir contains non-regular file at ${relToSub}`);
      }
    }
  };
  walk(resolvedSubdir, "");

  const entries: PrTreeEntry[] = [];
  for (const [repoRelPath, disk] of diskFiles) {
    const base = baseMap.get(repoRelPath);
    if (!base) {
      entries.push({ path: repoRelPath, mode: disk.mode, type: "blob", content: disk.content });
    } else if (disk.sha !== base.sha) {
      const mode: "100644" | "100755" | "120000" = base.mode === "120000" ? "120000" : disk.mode;
      entries.push({ path: repoRelPath, mode, type: "blob", content: disk.content });
    } else if (base.mode !== "120000" && disk.mode !== base.mode) {
      entries.push({ path: repoRelPath, mode: disk.mode, type: "blob", content: disk.content });
    }
  }
  for (const [repoRelPath, base] of baseMap) {
    if (!diskFiles.has(repoRelPath)) {
      entries.push({ path: repoRelPath, mode: base.mode, type: "blob", sha: null });
    }
  }
  return { entries, baseCommitSha: pin.rev, baseTreeSha };
}

// The gist (A2) or the fork, branch, commit and PR (A3), with the token the broker read and the
// thread the proposal came from (A3's PR body links it). It is the only thing the token is handed to.
export type Act = (
  p: Proposal,
  token: string,
  thread: string,
  verifiedIdentity?: VerifiedBotIdentity,
) => Promise<ActResult>;

// One Act per proposal kind; a kind with no Act throws, so it is not acted on.
export const byKind =
  (acts: Partial<Record<Proposal["kind"], Act>>): Act =>
  async (p, token, thread, verifiedIdentity) => {
    if (!Object.hasOwn(acts, p.kind)) throw new Error(`no action for a ${p.kind} proposal`);
    const act = acts[p.kind];
    if (!act) throw new Error(`no action for a ${p.kind} proposal`);
    return act(p, token, thread, verifiedIdentity);
  };

export type GuardOutConfig =
  | (NinferOut & { enable?: boolean })
  | { enable: false; base?: string; model?: string; system?: string; apiKey?: string };

export interface Config {
  // Read at act time, never from argv or the environment.
  tokenFile: string | null;
  // Required for reads; root supplies its globally controlled inbound screen.
  readScreen?: (text: string) => Promise<string>;
  guard: GuardOutConfig;
  act: Act;
  // Required in production via validateRootConfig (GC1 OQ-3, F6): verified against GET /user before any act.
  botLogin?: string;
  // Disallowed token identities (e.g. owner logins, GC1 OQ-3, F6, Q3).
  forbiddenLogins?: string[];
  githubApi?: string;
  mirrorRoot?: string;
  worktreeRoot?: string;
  repoUrlBase?: string;
  // As the redactor takes them, from secretLineHashes.
  secretFileHashes?: string[];
}

// What the broker records against the thread: never the token.
export interface Action {
  thread: string;
  acted: boolean;
  reason: string;
  redactions: string[];
  url?: string;
  gist?: GistReadResult;
}

const schema = load("proposal");

// What leaves the pod, in the outbound order (design §4 step 5, §5.6; owner-ruled arm A): `build`
// redacts every string that will leave through the scrub it is handed, the question is redacted too,
// and guard-out then judges exactly those bytes, so no credential enters its context and what it
// passed is what is published. Resolves to the redacted value guard-out passed, or why it did not.
// When `guard.enable === false` (G11), the deterministic redactor still runs unconditionally and
// only the guard-out model call is skipped.
export async function outbound<T>(
  question: string,
  build: (scrub: (s: string) => string) => T,
  guard: GuardOutConfig,
  secretFileHashes?: string[],
): Promise<{ redactions: string[] } & ({ value: T } | { reason: string })> {
  const redactions: string[] = [];
  const scrub = (s: string) => {
    const r = redact(s, { secretFileHashes });
    redactions.push(...r.hits.map((h) => h.kind));
    return r.text;
  };
  const value = build(scrub);
  if (guard.enable === false) {
    return { redactions, value };
  }
  try {
    const { verdict } = await reviewOut({ question: scrub(question), answer: JSON.stringify(value, null, 2) }, guard);
    if (verdict.verdict !== "pass") return { redactions, reason: `guard-out: ${verdict.reason}` };
  } catch (e) {
    return { redactions, reason: `guard-out unavailable: ${e instanceof Error ? e.message : e}` };
  }
  return { redactions, value };
}

function boundedText(text: string, limit = GIST_READ_MAX_BYTES): string {
  if (new TextEncoder().encode(text).byteLength <= limit) return text;
  return Buffer.from(text, "utf8").subarray(0, limit - 3).toString("utf8").replace(/\uFFFD$/, "") + "...";
}

function gistReadValue(value: unknown, expectedId: string): GistReadResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid gist read result");
  const v = value as Record<string, unknown>;
  const allowed = new Set(["untrusted", "id", "url", "description", "owner", "revision", "files"]);
  if (Object.keys(v).some((key) => !allowed.has(key))
      || v.id !== expectedId || typeof v.url !== "string" || normalizeGistId(v.url) !== expectedId
      || typeof v.description !== "string" || typeof v.revision !== "string" || !v.revision.length
      || !(v.owner === null || (typeof v.owner === "string" && BOT_LOGIN_RE.test(v.owner)))
      || !v.files || typeof v.files !== "object" || Array.isArray(v.files) || Object.keys(v.files).length === 0) {
    throw new Error("invalid gist read result");
  }
  for (const [name, content] of Object.entries(v.files)) {
    if (!isValidProposalFilePath(name, "gist") || typeof content !== "string") throw new Error("invalid gist read files");
  }
  // Neither provenance nor the fetched identifier comes from a model verdict.
  return { untrusted: true, id: expectedId, url: v.url, description: v.description,
    owner: v.owner as string | null, revision: v.revision, files: v.files as Record<string, string> };
}

async function processGistRead(
  value: unknown, id: string, token: string, c: Config, redactions: string[],
): Promise<GistReadResult> {
  if (!c.readScreen) throw new Error("gist reads require an inbound screen");
  const bounded = (value: unknown) => {
    const encoded = JSON.stringify(value);
    if (new TextEncoder().encode(encoded).byteLength > GIST_READ_MAX_BYTES) throw new Error("gist read exceeds byte limit");
    return encoded;
  };
  const scrub = (text: string) => {
    const exact = token ? text.split(token).join("[token]") : text;
    const r = redact(exact, { secretFileHashes: c.secretFileHashes });
    redactions.push(...r.hits.map((hit) => hit.kind));
    return r.text;
  };
  const clean = (input: GistReadResult): GistReadResult => gistReadValue({
    ...input, id: scrub(input.id), url: scrub(input.url), description: scrub(input.description),
    owner: input.owner === null ? null : scrub(input.owner), revision: scrub(input.revision),
    files: Object.fromEntries(Object.entries(input.files).map(([name, text]) => [scrub(name), scrub(text)])),
  }, id);
  bounded(value);
  const initial = clean(gistReadValue(value, id));
  const screened = await c.readScreen(bounded(initial));
  if (typeof screened !== "string" || new TextEncoder().encode(screened).byteLength > GIST_READ_MAX_BYTES) throw new Error("gist read screen exceeds byte limit");
  let rewritten: unknown;
  try { rewritten = JSON.parse(screened); } catch { throw new Error("gist read screen returned invalid JSON"); }
  const final = clean(gistReadValue(rewritten, id));
  if (final.url !== initial.url) throw new Error("gist read screen changed its source URL");
  bounded(final);
  return final;
}

export async function broker(thread: string, raw: string, c: Config): Promise<Action> {
  const redactions: string[] = [];
  let token = "";
  const scrubResult = (text: string) => {
    const r = redact(token ? text.split(token).join("[token]") : text, { secretFileHashes: c.secretFileHashes });
    redactions.push(...r.hits.map((hit) => hit.kind));
    return boundedText(r.text);
  };
  const done = (acted: boolean, reason: string, url?: string): Action => ({ thread, acted, reason: scrubResult(reason), redactions, ...(url ? { url: scrubResult(url) } : {}) });

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return done(false, "proposal unparseable");
  }
  const bad = errors(schema, value);
  if (bad.length) return done(false, `not a proposal: ${bad.join("; ")}`);

  const v = value as Proposal;
  const fieldErr = validateProposalFields(v);
  if (fieldErr !== null) return done(false, `not a proposal: ${fieldErr}`);

  let treeEntries: PrTreeEntry[] | undefined;
  let baseCommitSha: string | undefined;
  let baseTreeSha: string | undefined;
  if (v.worktreeSubdir !== undefined) {
    if (!c.mirrorRoot || !c.worktreeRoot) {
      return done(false, "worktreeSubdir requires mirrorRoot and worktreeRoot");
    }
    try {
      const diff = await computeWorktreeDiff({
        mirrorRoot: c.mirrorRoot,
        worktreeRoot: c.worktreeRoot,
        thread,
        repo: v.repo!,
        worktreeSubdir: v.worktreeSubdir,
        repoUrlBase: c.repoUrlBase,
      });
      if (diff.entries.length === 0) {
        return done(false, "not a proposal: worktreeSubdir has no changes relative to base commit");
      }
      treeEntries = diff.entries;
      baseCommitSha = diff.baseCommitSha;
      baseTreeSha = diff.baseTreeSha;
    } catch (e) {
      return done(false, `not a proposal: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  let out: { redactions: string[] } & ({ value: Proposal } | { reason: string });
  try {
    out = await outbound(
    `genie-bot is about to publish this ${v.kind} on GitHub.`,
    (scrub): Proposal => ({
      kind: v.kind,
      ...(v.id === undefined ? {} : { id: normalizeGistId(scrub(v.id)) }),
      ...(v.public === undefined ? {} : { public: v.public }),
      ...(v.repo === undefined ? {} : { repo: scrub(v.repo) }),
      ...(v.branch === undefined ? {} : { branch: scrub(v.branch) }),
      ...(v.commits === undefined ? {} : { commits: v.commits.map(scrub) }),
      ...(v.files === undefined
        ? {}
        : { files: Object.fromEntries(Object.entries(v.files).map(([k, f]) => [scrub(k), scrub(f)])) }),
      ...(v.worktreeSubdir === undefined ? {} : { worktreeSubdir: scrub(v.worktreeSubdir) }),
      ...(treeEntries === undefined
        ? {}
        : {
            treeEntries: treeEntries.map((e) =>
              e.sha === null
                ? { path: scrub(e.path), mode: e.mode, type: "blob", sha: null }
                : { path: scrub(e.path), mode: e.mode, type: "blob", content: scrub(e.content ?? "") },
            ),
            baseCommitSha,
            baseTreeSha,
          }),
      ...(v.title === undefined ? {} : { title: scrub(v.title) }),
      ...(v.body === undefined ? {} : { body: scrub(v.body) }),
    } as Proposal),
    v.kind === "gist_read" ? { enable: false } : c.guard,
    c.secretFileHashes,
    );
  } catch {
    return done(false, "proposal redaction produced invalid metadata");
  }
  redactions.push(...out.redactions);
  if (!("value" in out)) return done(false, out.reason);
  const p = out.value;
  const postScrubErr = validateProposalFields(p);
  if (postScrubErr !== null) return done(false, `not a proposal: ${postScrubErr}`);

  if (p.kind === "gist_read" && !c.readScreen) return done(false, "gist reads require an inbound screen");
  if (c.tokenFile === null) {
    if (p.kind !== "gist_read") return done(false, "credentialed writes require a configured token");
  } else {
    try {
      token = readFileSync(c.tokenFile, "utf8").trim();
    } catch {
      return done(false, `token unreadable: ${c.tokenFile}`);
    }
    if (!token) return done(false, `token empty: ${c.tokenFile}`);
  }
  let verifiedIdentity: VerifiedBotIdentity | undefined;
  if (token && c.botLogin) {
    try {
      verifiedIdentity = await verifyBotIdentityContext(
        c.githubApi ?? "https://api.github.com",
        token,
        c.botLogin,
        c.forbiddenLogins ?? [],
      );
    } catch (e) {
      return done(false, String(e instanceof Error ? e.message : e).split(token).join("[token]"));
    }
  }
  try {
    const result = await c.act(p, token, thread, verifiedIdentity);
    if (p.kind === "gist_read") {
      const value = await processGistRead(result.gist, p.id, token, c, redactions);
      return { ...done(true, "read", value.url), gist: value };
    }
    return done(true, "acted", result.url);
  } catch (e) {
    // A failed request may echo its Authorization header.
    return done(false, `act failed: ${String(e instanceof Error ? e.message : e)}`);
  }
}
