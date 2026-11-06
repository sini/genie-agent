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
export interface Proposal {
  kind: "gist" | "pr";
  repo?: string;
  branch?: string;
  commits?: string[];
  files?: Record<string, string>;
  worktreeSubdir?: string;
  // Populated by genie-root/broker when diffing `worktreeSubdir` against the pinned mirror base tree.
  treeEntries?: PrTreeEntry[];
  baseTreeSha?: string;
  baseCommitSha?: string;
  title: string;
  body: string;
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

// Repository allowlist check for PR proposals (GX2 F2). Defaults to empty ([]), refusing all
// repositories unless explicitly configured as "owner/repo" or "owner/*".
export function isRepoAllowed(repo: unknown, allowedRepos: readonly string[] = []): boolean {
  if (!isValidRepoCoord(repo)) return false;
  const [owner] = repo.split("/");
  return allowedRepos.some((entry) => entry === repo || entry === `${owner}/*`);
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
  const hasFiles = p.files !== undefined;
  const hasSubdir = p.worktreeSubdir !== undefined;
  if (hasFiles && hasSubdir) {
    return "$.files and $.worktreeSubdir are mutually exclusive";
  }
  if (!hasFiles && !hasSubdir) {
    return "$.files must have at least 1 file";
  }
  if (hasFiles) {
    if (!p.files || typeof p.files !== "object" || Object.keys(p.files).length < 1) {
      return "$.files must have at least 1 file";
    }
    for (const k of Object.keys(p.files)) {
      if (!isValidProposalFilePath(k, p.kind)) {
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
  const base = githubApi.replace(/\/+$/, "");
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
export type Act = (p: Proposal, token: string, thread: string) => Promise<{ url: string }>;

// One Act per proposal kind; a kind with no Act throws, so it is not acted on.
export const byKind =
  (acts: Record<Proposal["kind"], Act>): Act =>
  async (p, token, thread) => {
    if (!Object.hasOwn(acts, p.kind)) throw new Error(`no action for a ${p.kind} proposal`);
    return acts[p.kind](p, token, thread);
  };

export type GuardOutConfig =
  | (NinferOut & { enable?: boolean })
  | { enable: false; base?: string; model?: string; system?: string; apiKey?: string };

export interface Config {
  // Read at act time, never from argv or the environment.
  tokenFile: string;
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

export async function broker(thread: string, raw: string, c: Config): Promise<Action> {
  const redactions: string[] = [];
  const done = (acted: boolean, reason: string, url?: string): Action => ({ thread, acted, reason, redactions, ...(url ? { url } : {}) });

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

  const out = await outbound(
    `genie-bot is about to publish this ${v.kind} on GitHub.`,
    (scrub): Proposal => ({
      kind: v.kind,
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
      title: scrub(v.title),
      body: scrub(v.body),
    }),
    c.guard,
    c.secretFileHashes,
  );
  redactions.push(...out.redactions);
  if (!("value" in out)) return done(false, out.reason);
  const p = out.value;
  const postScrubErr = validateProposalFields(p);
  if (postScrubErr !== null) return done(false, `not a proposal: ${postScrubErr}`);

  let token: string;
  try {
    token = readFileSync(c.tokenFile, "utf8").trim();
  } catch {
    return done(false, `token unreadable: ${c.tokenFile}`);
  }
  if (!token) return done(false, `token empty: ${c.tokenFile}`);
  if (c.botLogin) {
    try {
      await verifyBotIdentity(c.githubApi ?? "https://api.github.com", token, c.botLogin, c.forbiddenLogins ?? []);
    } catch (e) {
      return done(false, String(e instanceof Error ? e.message : e).split(token).join("[token]"));
    }
  }
  try {
    const { url } = await c.act(p, token, thread);
    return done(true, "acted", url);
  } catch (e) {
    // A failed request may echo its Authorization header.
    return done(false, `act failed: ${String(e instanceof Error ? e.message : e).split(token).join("[token]")}`);
  }
}
