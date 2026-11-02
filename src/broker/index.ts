// The action broker (design §5.6): the only holder of the genie-bot token. A proposal is parsed
// against schemas/proposal.json, redacted, judged by guard-out, and only then acted on. Every
// failure fails closed: an unparseable proposal, a guard-out block, a guard-out error and an
// unreadable token are each not acted on, with the reason recorded.
//
// The redactor runs BEFORE guard-out, once, over every string that will leave. Guard-out is a
// model, and a credential must never enter a model's context (§5.2 item 6), and the act then
// publishes exactly the bytes guard-out passed. Guard-out still sees the `[redacted:<kind>]` mark.
import { readFileSync } from "node:fs";
import { reviewOut, type NinferOut } from "../guard/service.ts";
import { redact } from "../redactor/index.ts";
import { errors, load } from "../tier1/schema.ts";

// One record of schemas/proposal.json.
export interface Proposal {
  kind: "gist" | "pr";
  repo?: string;
  branch?: string;
  commits?: string[];
  files: Record<string, string>;
  title: string;
  body: string;
}

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
  if (!p.files || typeof p.files !== "object" || Object.keys(p.files).length < 1) {
    return "$.files must have at least 1 file";
  }
  for (const k of Object.keys(p.files)) {
    if (!isValidProposalFilePath(k, p.kind)) {
      return `$.files[${JSON.stringify(k)}] is not a valid file path`;
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
  // Explicit allowlist of "owner/repo" or "owner/*" coordinates for PR proposals; defaults to [] (refuse all).
  allowedRepos?: string[];
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
  if (v.kind === "pr" || v.repo !== undefined) {
    if (!isRepoAllowed(v.repo, c.allowedRepos ?? [])) {
      return done(false, `repo not in broker.allowedRepos: ${v.repo}`);
    }
  }
  const out = await outbound(
    `genie-bot is about to publish this ${v.kind} on GitHub.`,
    (scrub): Proposal => ({
      kind: v.kind,
      ...(v.repo === undefined ? {} : { repo: scrub(v.repo) }),
      ...(v.branch === undefined ? {} : { branch: scrub(v.branch) }),
      ...(v.commits === undefined ? {} : { commits: v.commits.map(scrub) }),
      files: Object.fromEntries(Object.entries(v.files).map(([k, f]) => [scrub(k), scrub(f)])),
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
  if (p.kind === "pr" || p.repo !== undefined) {
    if (!isRepoAllowed(p.repo, c.allowedRepos ?? [])) {
      return done(false, `repo not in broker.allowedRepos: ${p.repo}`);
    }
  }

  let token: string;
  try {
    token = readFileSync(c.tokenFile, "utf8").trim();
  } catch {
    return done(false, `token unreadable: ${c.tokenFile}`);
  }
  if (!token) return done(false, `token empty: ${c.tokenFile}`);
  try {
    const { url } = await c.act(p, token, thread);
    return done(true, "acted", url);
  } catch (e) {
    // A failed request may echo its Authorization header.
    return done(false, `act failed: ${String(e instanceof Error ? e.message : e).split(token).join("[token]")}`);
  }
}
