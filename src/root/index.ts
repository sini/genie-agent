// Tier 1's composition root (plan C11, design §4): one entrypoint that assembles the landed units.
// An inbound envelope sets the thread's tier (C7) from its raw lines, then passes guard-in, and only
// the guard's allowed or rewritten text reaches the thread's pi (C4); a reject never does. Tier 1's
// Host calls run here, on the supervisor's side: eval on the per-thread lock at the thread's stored
// tier, clone on the mirror, the web Screen, escalation (C5, routed by C6, guarded by S5), and
// proposals through the broker. A thread is archived (P4) when it closes and again when it is
// collected (P3). An expert reply that guard-out blocks is dropped from tier 1's context and the
// transcript, and archived with a tier label only (C8, design §4 step 6, §5.8).
//
// xmsg and Matrix enter only through the seams below; GA builds their real adapters.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { archiver, replayResume, type S3Config } from "../archive/index.ts";
import { type BankRecallItem, DEFAULT_HINDSIGHT_ENDPOINT, HindsightRecallClient, recallBankId } from "../bank/index.ts";
import { gist, gistRead, gistUpdate, gistComment } from "../broker/gist.ts";
import {
  BOT_LOGIN_RE,
  broker,
  byKind,
  DEFAULT_BOT_LOGIN,
  DEFAULT_FORBIDDEN_LOGINS,
  outbound,
  type Proposal,
  validateProposalFields,
} from "../broker/index.ts";
import { pr } from "../broker/pr.ts";
import { BrokerBridge, type BridgePrincipal } from "../broker/bridge.ts";
import { createHash } from "node:crypto";
import { parseExpertReply, type ExpertReply } from "../dispatcher/reply.ts";
import { escalationGuard } from "../escalation/guard.ts";
import {
  Escalation,
  type GhTranscriptEntry,
  type GitTranscriptEntry,
  type Package,
  type XmsgSend,
} from "../escalation/index.ts";
import { router } from "../escalation/route.ts";
import { withCache } from "../eval/cache.ts";
import { perThread, type Runner } from "../eval/lock.ts";
import type { EvalRequest } from "../eval/run.ts";
import { configuredEval, validateEvalConfig, type EvalConfig } from "./eval.ts";
import { containerLaunch, type ContainerExecutor } from "../tier1/container.ts";
import { RootFileService, piToolsPath } from "../tier1/files.ts";
import { Gc } from "../gc/index.ts";
import { type Envelope, type Line, verdictErrors } from "../guard/verdict.ts";
import { type Clock, type HandlerErrorKind, type HandlerErrorSink, Lifecycle } from "../lifecycle/index.ts";
export type { HandlerErrorKind, HandlerErrorSink };
import {
  gitRead,
  type GitRequest,
  type MirrorConfig,
  type Runner as GitRunner,
  worktreeFor,
} from "../mirror/index.ts";
import { redact } from "../redactor/index.ts";
import { ThreadStateStore, type PendingAction, type Tier } from "../state/index.ts";
import { type GuardClient, webScreen } from "../supervisor/guard-client.ts";
import { Supervisor } from "../supervisor/index.ts";
import { seedGuard } from "../supervisor/seed.ts";
import type { Draft } from "../tier1/draft.ts";
import { type GhReadRequest, ghRead } from "../tier1/github.ts";
import type { Config as Tier1Config, Host } from "../tier1/index.ts";
import { tier1Launch, tier1ReadOnlyBinds } from "../tier1/launch.ts";
import { Custody, piAiPath } from "../tier1/custody.ts";
import { errors, load } from "../tier1/schema.ts";
import { observe, parseEnvelope, type TrustControl } from "../tier/index.ts";
import { parseMatrixForward } from "./io.ts";

export interface ApproveControl {
  control: "approve";
  sender?: string;
  sender_id?: string;
  tier?: Tier | string;
  target?: string;
}

// One inbound item from matrix-xmsg or xmsg, on the thread it belongs to: the raw envelope exactly as
// matrix-xmsg sends it (carrying `screened: false` when matrix-xmsg forwarded under fail-open, M26, or
// `screened: true` when pre-screened by matrix-xmsg, GAP-7, and optional `addressed` from the header, GAP-1),
// `!trust` (C7's TrustControl), a ✅ accept / 🔍 deeper reaction, an approve control (C10),
// or an expert reply.
export type Inbound =
  | ({ thread: string } & (
      | { envelope: string; screened?: boolean; addressed?: boolean }
      | TrustControl
      | { control: "accept" | "deeper" }
      | { expert: string }
    ))
  | ({ thread?: string } & ApproveControl);

export interface Intake {
  // The next batch of inbound items, in arrival order; null once the intake has closed.
  next(): Promise<Inbound[] | null>;
}

export interface PostEnvelope {
  text: string;
  approval?: true;
}

export type PostPayload =
  | PostEnvelope
  | { silent: true }
  | { redact: string; reason?: string }
  | { edit: string; text: string };

export interface Post {
  // A message to the bot's thread: tier 1's draft, or a notice such as a refusal.
  // Returns the posted event id if provided by the underlying transport.
  post(thread: string, message: PostPayload): Promise<string | void>;
}

export interface Io {
  intake: Intake;
  post: Post;
  guard?: GuardClient;
  xmsg: XmsgSend;
  request?: (thread: string, payload: unknown) => Promise<string>;
  git?: GitRunner;
  onHandlerError?: HandlerErrorSink;
  registrationLimits?: { max_body_bytes?: number; reply_ttl_secs?: number; idempotency_ttl_secs?: number };
  setBrokerHandler?: (handler: (message: { id: string; text: string; origin?: unknown }) => Promise<boolean>, acknowledged?: (message: { id: string; text: string; origin?: unknown }) => Promise<void>) => void;
  brokerReply?: (id: string, text: string, key: string) => Promise<unknown>;
}

// Every secret is a file path, read at start or at use, never argv or the environment.
export interface Config {
  stateRoot: string;
  storeRoot: string;
  mirror: MirrorConfig;
  // The pi executable.
  pi: string;
  // Tier 1's configured pi model API.
  model: { baseUrl: string; api: string; id: string; keyFile: string };
  tier1: Omit<Tier1Config, "root"> & { sandbox?: { bwrap?: string }; executor?: ContainerExecutor };
  // Inbound guard-in screening switch (G11; default true).
  guard?: { enable?: boolean };
  // Optional guard-in screening switch for `git` read outputs (GC1 OQ-2; default false).
  gitScreen?: { enable?: boolean };
  // Optional guard-in screening switch for `gh_read` outputs (GC1 OQ-2; default false).
  ghScreen?: { enable?: boolean };
  // Optional fine-grained zero-permission GitHub read token file for `gh_read` (GC1 OQ-4).
  githubReadTokenFile?: string | null;
  // Hindsight dataplane endpoint for recall ("support" -> genie, "memory" -> genie-memory).
  hindsightUrl?: string;
  s3?: S3Config | null;
  // threadLink: the thread's public URL with `{thread}` where the thread id goes; a PR needs it.
  broker: {
    bridge?: { allowlist: BridgePrincipal[]; maxBodyBytes?: number };
    tokenFile?: string | null;
    botLogin?: string;
    forbiddenLogins?: string[];
    maxProposalsPerThreadPerDay?: number;
    githubApi?: string;
    threadLink?: string;
    guardOut?: { enable?: boolean; base?: string; model?: string; keyFile?: string };
  };
  // Eval limits are requested from detected host adapters; unavailable enforcement is reported.
  eval?: EvalConfig;
  experts?: Record<Tier, string>;
  xmsg?: XmsgIoOptions;
}

import type { GuardOutConfig } from "../broker/index.ts";
import type { XmsgIoOptions } from "./io.ts";
export { parseGuardVerdictReply, parseMatrixForward, XmsgGuardClient, type XmsgGuardClientOptions, XmsgIo, type XmsgIoOptions } from "./io.ts";

import { pathToFileURL } from "node:url";

const repo = process.env.GENIE_REPO_ROOT
  ? pathToFileURL(`${process.env.GENIE_REPO_ROOT}/`)
  : import.meta.url
    ? new URL("../../", import.meta.url)
    : pathToFileURL(`${process.cwd()}/`);
const secret = (file: string) => {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8").trim();
  } catch (e) {
    throw new Error(`credential file unreadable (${file}): ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!raw) throw new Error(`credential file is empty: ${file}`);
  return raw;
};

const evalRequestSchema = load("eval-request");
const proposalSchema = load("proposal");
const gitRequestSchema = load("git-request");
const ghReadSchema = load("gh-read");

// Fixed notices, posted without guard-out: no thread text is in them.
export const REFUSAL = "I can't help with that message.";
export const WITHHELD = "I drafted an answer, but my output check held it back. I've flagged this for review.";
export const DEADLINE_NOTICE = readFileSync(new URL("prompts/tier1-deadline.md", repo).pathname, "utf8").trim();
export const approvalNotice = (action: string, params: unknown): PostEnvelope & { approval: true } => ({
  approval: true,
  text: redact(`Approval requested: ${action} ${JSON.stringify(params)}`).text,
});
export const approvalRequest = approvalNotice;

// guard-in on an inbound envelope (design §4 step 1): the trigger's line is the content and every
// context line its history, in envelope order, each with its authenticated tier. Runs on every
// inbound envelope, including fail-open forwards (`<request screened="false" note="…">`), except when
// matrix-xmsg has already screened the request and marked the outer `<request screened="true">` tag (GAP-7, Q5).
// The text tier 1 may see: the line on allow, the guard's cleaned_text on rewrite. Anything else refuses it.
// When `enabled` is false (G11), passes `content.text` through unscreened without calling the guard.
export async function guardIn(
  guard: GuardClient | undefined,
  raw: string,
  opts: { enabled?: boolean; preScreened?: boolean } = {},
): Promise<string> {
  const enabled = opts.enabled ?? true;
  const history: Line[] = [];
  let content: Line | undefined;
  let inRequest = false;
  let seenRequest = false;
  let headerPreScreened = false;
  for (const l of raw.split("\n")) {
    if (
      l === "<request>" ||
      /^<request(?:\s+(?:addressed="(?:true|false)"|screened="(?:true|false)"|note="[^"]*"))+>$/.test(l)
    ) {
      if (seenRequest) throw new Error("guard-in: multiple <request> blocks");
      seenRequest = true;
      inRequest = true;
      headerPreScreened = /\bscreened="true"/.test(l) && !/\bscreened="false"/.test(l);
    } else if (l === "</request>") inRequest = false;
    else if (l.startsWith("{")) {
      const { sender, tier, text } = JSON.parse(l);
      if (typeof text !== "string") throw new Error("guard-in: an envelope line without text");
      inRequest ? (content = { sender, tier, text }) : history.push({ sender, tier, text });
    }
  }
  if (!content) throw new Error("guard-in: an envelope without request content");
  if (!enabled) return content.text;
  if (opts.preScreened === true || (opts.preScreened !== false && headerPreScreened)) {
    return content.text;
  }
  if (!guard) throw new Error("guard-in: no verdict");
  const e: Envelope = { source: "message", history, content };
  const v = await guard.check(e).catch((err) => ({ unavailable: String(err) }));
  if ("unavailable" in v || verdictErrors(v).length) throw new Error("guard-in: no verdict");
  if (v.verdict === "allow") return e.content.text;
  if (v.verdict === "rewrite") return v.cleaned_text;
  throw new Error(`guard-in: rejected: ${v.reason}`);
}

export function validateRootConfig(c: Config): { guardEnable: boolean; guardOutEnable: boolean } {
  validateEvalConfig(c.eval);
  const executor = c.tier1?.executor;
  if (executor !== undefined) {
    const command = (value: unknown): value is { command: string; args: string[] } => Boolean(value && typeof value === "object" && typeof (value as any).command === "string" && (value as any).command.length && Array.isArray((value as any).args) && (value as any).args.every((arg: unknown) => typeof arg === "string"));
    if (!command(executor) || !command(executor.stop) || typeof executor.socketPath !== "string" || !executor.socketPath.startsWith("/")) throw new Error("tier1.executor requires command, args, stop and absolute socketPath");
    if (c.tier1.sandbox?.bwrap) throw new Error("tier1.sandbox.bwrap belongs to the local executor");
  }
  if (c.broker?.bridge) {
    const b = c.broker.bridge;
    if (!Array.isArray(b.allowlist) || b.allowlist.some((p) => !p || typeof p.service !== "string" || !p.service || typeof p.node !== "string" || !p.node || /[\s@\x00-\x1f]/u.test(p.service + p.node))
        || (b.maxBodyBytes !== undefined && (!Number.isInteger(b.maxBodyBytes) || b.maxBodyBytes < 512 || b.maxBodyBytes > 65_536))) throw new Error("invalid broker.bridge allowlist or maxBodyBytes");
  }
  const guardEnable = c.guard?.enable ?? true;
  const guardOutEnable = c.broker?.guardOut?.enable ?? true;
  if (guardEnable && c.xmsg !== undefined && "guard" in c.xmsg) {
    if (c.xmsg.guard === null || (c.xmsg.guard !== undefined && "target" in c.xmsg.guard && !c.xmsg.guard.target)) {
      throw new Error("xmsg.guard.target is required when guard.enable is true");
    }
  }
  if (c.broker?.tokenFile) {
    if (!guardOutEnable && guardEnable) {
      throw new Error("broker.guardOut.enable must be true when broker.tokenFile is configured");
    }
    const botLogin = c.broker.botLogin ?? DEFAULT_BOT_LOGIN;
    if (!BOT_LOGIN_RE.test(botLogin)) {
      throw new Error(`invalid broker.botLogin: ${botLogin}`);
    }
    const forbidden = (c.broker.forbiddenLogins ?? DEFAULT_FORBIDDEN_LOGINS).map((s) => s.toLowerCase());
    if (forbidden.includes(botLogin.toLowerCase())) {
      throw new Error(`broker.botLogin ${botLogin} is in broker.forbiddenLogins`);
    }
  }
  if (guardOutEnable) {
    if (!c.broker?.guardOut?.base || !c.broker?.guardOut?.model) {
      throw new Error("broker.guardOut.base and broker.guardOut.model are required when broker.guardOut.enable is true");
    }
  }
  return { guardEnable, guardOutEnable };
}

// Resync a thread's history from matrix-xmsg in paged 4 KiB chunks (GI-8, matrix-context-design.md §5.3),
// starting at `{"resync": {"offset": 0}}` and following `truncated="true" next_offset="<N>"` /
// `call {"resync": {"offset": <N>}}` until complete. Each page is screened through `screen` before
// its inner body is appended.
export async function resyncThread(
  thread: string,
  request: (thread: string, payload: unknown) => Promise<string>,
  screen: (text: string) => Promise<string>,
): Promise<string> {
  const parts: string[] = [];
  let offset = 0;
  for (let step = 0; step < 10_000; step++) {
    const rawPage = await request(thread, { resync: { offset } });
    const trimmed = rawPage.trim();
    if (trimmed.startsWith("{")) {
      let parsedErr: Record<string, unknown> | undefined;
      try {
        const obj = JSON.parse(trimmed);
        if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
          parsedErr = obj as Record<string, unknown>;
        }
      } catch {
        // not a JSON error object
      }
      if (parsedErr && ("resync" in parsedErr || "error" in parsedErr)) {
        const kind = String(parsedErr.resync ?? parsedErr.error);
        const detail = typeof parsedErr.reason === "string" ? `: ${parsedErr.reason}` : "";
        throw new Error(`resync ${kind}${detail}`);
      }
    }
    const screenedPage = await screen(rawPage);
    const bodyMatch = /^<context\b[^>]*>\n([\s\S]*?)\n<\/context>\s*$/.exec(screenedPage);
    const body = bodyMatch ? bodyMatch[1] : screenedPage;
    const rawBodyMatch = /^<context\b[^>]*>\n([\s\S]*?)\n<\/context>\s*$/.exec(rawPage);
    const rawBody = rawBodyMatch ? rawBodyMatch[1] : rawPage;

    const nextAttr = /\btruncated="true"\s+next_offset="(\d+)"/.exec(rawPage);
    const nextNote = /call\s+\{"resync":\s*\{"offset":\s*(\d+)\}\}/.exec(rawPage);
    const nextStr = nextAttr?.[1] ?? nextNote?.[1];
    if (!nextStr) {
      parts.push(body);
      break;
    }
    const nextOffset = Number.parseInt(nextStr, 10);
    if (!Number.isFinite(nextOffset) || nextOffset <= offset) {
      parts.push(body);
      break;
    }
    const rawLen = new TextEncoder().encode(rawBody).byteLength;
    const sep = nextOffset - offset === rawLen ? "" : "\n".repeat(Math.max(1, nextOffset - offset - rawLen));
    parts.push(`${body}${sep}`);
    offset = nextOffset;
  }
  return parts.join("");
}

export function main(
  configFile: string,
  io: Io,
  run?: Runner,
  clock?: Clock,
) {
  const c: Config = JSON.parse(readFileSync(configFile, "utf8"));
  const { guardEnable, guardOutEnable } = validateRootConfig(c);
  const readOnlyBinds = tier1ReadOnlyBinds({ pi: c.pi, memoryRoot: c.tier1.memoryRoot });
  const exportedRoots = [c.stateRoot, c.mirror.worktreeRoot, ...[...readOnlyBinds.system, ...readOnlyBinds.application].map((bind) => bind[1])].filter((p): p is string => Boolean(p)).map((p) => existsSync(p) ? realpathSync(p) : resolve(p));
  const configuredCredentials: Array<string | null | undefined> = [
    c.model.keyFile,
    c.broker?.tokenFile,
    guardOutEnable ? c.broker?.guardOut?.keyFile : undefined,
    c.githubReadTokenFile,
    c.s3?.secretKeyFile,
    c.eval?.backend === "kubernetes" ? c.eval.kubernetes?.tokenFile : undefined,
  ];
  for (const credential of configuredCredentials) {
    if (credential === null || credential === undefined) continue;
    secret(credential);
  }
  for (const credential of [c.model.keyFile, c.broker?.tokenFile, c.broker?.guardOut?.keyFile, c.githubReadTokenFile, c.s3?.secretKeyFile, c.eval?.kubernetes?.tokenFile]) {
    if (!credential || !existsSync(credential)) continue;
    const file = realpathSync(credential);
    if (exportedRoots.some((root) => file === root || file.startsWith(`${root}/`))) throw new Error("credential file must be outside tier-1 exported roots");
  }
  const store = new ThreadStateStore(c.stateRoot, c.storeRoot);
  const archive = c.s3 ? archiver(store, c.s3) : async () => {};
  const evalIn = withCache(
    store,
    perThread(
      run ?? configuredEval(c.eval, c.mirror.worktreeRoot),
    ),
  );
  const screen = webScreen(io.guard, { enabled: guardEnable });
  const gitScreen = webScreen(io.guard, { enabled: guardEnable && (c.gitScreen?.enable ?? false) });
  const ghScreen = webScreen(io.guard, { enabled: guardEnable && (c.ghScreen?.enable ?? false) });
  const guard = seedGuard(io.guard, { enabled: guardEnable });
  const hindsightUrl = c.hindsightUrl ?? DEFAULT_HINDSIGHT_ENDPOINT;
  const guardOut: GuardOutConfig = guardOutEnable
    ? {
        enable: true,
        base: c.broker.guardOut!.base!,
        model: c.broker.guardOut!.model!,
        system: readFileSync(new URL("prompts/guard-out.md", repo).pathname, "utf8"),
        apiKey: c.broker.guardOut!.keyFile && secret(c.broker.guardOut!.keyFile),
      }
    : { enable: false };

  // C5's record of the thread: its latest cleaned question, evals, Hindsight recalls (GAP-5), and git/gh reads (GE2), beside P2's state.
  type Context = {
    cleaned_question: string;
    eval_transcript: unknown[];
    recall_transcript: unknown[];
    git_transcript: GitTranscriptEntry[];
    gh_transcript: GhTranscriptEntry[];
    addressed?: boolean;
  };
  const file = (t: string) => `${store.dir(t)}/context.json`;
  const hasEvalExit = (e: unknown): boolean =>
    typeof (e as { result?: { exit?: unknown } } | null)?.result?.exit === "number";
  const context = (t: string): Context => {
    if (!existsSync(file(t))) {
      return {
        cleaned_question: "",
        eval_transcript: [],
        recall_transcript: [],
        git_transcript: [],
        gh_transcript: [],
      };
    }
    const raw = JSON.parse(readFileSync(file(t), "utf8")) as Partial<Context>;
    return {
      cleaned_question: raw.cleaned_question ?? "",
      eval_transcript: (raw.eval_transcript ?? []).filter(hasEvalExit),
      recall_transcript: raw.recall_transcript ?? [],
      git_transcript: raw.git_transcript ?? [],
      gh_transcript: raw.gh_transcript ?? [],
      ...(raw.addressed !== undefined ? { addressed: raw.addressed } : {}),
    };
  };
  const setContext = (t: string, x: Partial<Context>) => writeFileSync(file(t), JSON.stringify({ ...context(t), ...x }));

  const { githubApi, threadLink } = c.broker ?? {};
  const botLogin = c.broker?.botLogin ?? DEFAULT_BOT_LOGIN;
  const forbiddenLogins = c.broker?.forbiddenLogins ?? [...DEFAULT_FORBIDDEN_LOGINS];
  const link = (t: string) => {
    if (!threadLink) throw new Error("broker.threadLink is not configured");
    return threadLink.replace("{thread}", encodeURIComponent(t));
  };
  const act = byKind({
    gist: gist(githubApi, 30_000, { botLogin, forbiddenLogins }),
    gist_read: gistRead(githubApi, 30_000, { botLogin, forbiddenLogins }),
    gist_update: gistUpdate(githubApi, 30_000, { botLogin, forbiddenLogins }),
    gist_comment: gistComment(githubApi, 30_000, { botLogin, forbiddenLogins }),
    pr: pr(link, githubApi, { botLogin, forbiddenLogins }),
  });

  const escalation = new Escalation({
    store,
    xmsg: io.xmsg,
    guard: escalationGuard(io.guard, { enabled: guardEnable }),
    route: router(c.experts),
    context: (t) => {
      const { cleaned_question, eval_transcript, recall_transcript, git_transcript, gh_transcript } = context(t);
      return {
        cleaned_question,
        eval_transcript,
        ...(recall_transcript.length > 0 ? { recall_transcript } : {}),
        ...(git_transcript.length > 0 ? { git_transcript } : {}),
        ...(gh_transcript.length > 0 ? { gh_transcript } : {}),
      };
    },
  });

  const agentDir = mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/genie-pi-`);
  const { baseUrl, api, id, keyFile } = c.model;
  const { executor, sandbox: _sandbox, ...tier1Config } = c.tier1;
  const configForThread = (thread: string) => {
    const root = `${c.mirror.worktreeRoot}/${thread}`;
    mkdirSync(root, { recursive: true, mode: 0o755 });
    return { ...tier1Config, root };
  };
  const fileServices = new Map<string, RootFileService>();
  const propose = async (t: string, p: unknown) => {
    const bad = errors(proposalSchema, p);
    if (bad.length) {
      return { thread: t, acted: false, reason: `not a proposal: ${bad.join("; ")}`, redactions: [] };
    }
    const prop = p as Proposal;
    const fieldErr = validateProposalFields(prop);
    if (fieldErr !== null) {
      return { thread: t, acted: false, reason: `not a proposal: ${fieldErr}`, redactions: [] };
    }
    if (!c.broker.tokenFile && prop.kind !== "gist_read") {
      return { thread: t, acted: false, reason: "the proposal broker is not configured on this deployment", redactions: [] };
    }
    if (
      typeof c.broker.maxProposalsPerThreadPerDay === "number" &&
      store.proposalCount(t) >= c.broker.maxProposalsPerThreadPerDay
    ) {
      return {
        thread: t,
        acted: false,
        reason: `refused: thread exceeded maxProposalsPerThreadPerDay (${c.broker.maxProposalsPerThreadPerDay})`,
        redactions: [],
      };
    }
    const res = await broker(t, JSON.stringify(p), {
      tokenFile: c.broker.tokenFile ?? null,
      readScreen: screen,
      botLogin,
      forbiddenLogins,
      githubApi,
      mirrorRoot: c.mirror.mirrorRoot,
      worktreeRoot: c.mirror.worktreeRoot,
      repoUrlBase: c.mirror.repoUrlBase ?? (c as { repoUrlBase?: string }).repoUrlBase,
      guard: guardOut,
      act,
    });
    if (res.acted) {
      if (res.gist) {
        setContext(t, {
          gh_transcript: [
            ...context(t).gh_transcript,
            { request: { kind: "gist_read", id: res.gist.id }, output: JSON.stringify(res.gist), screened: guardEnable },
          ],
        });
      }
      store.recordProposal(t);
    }
    return res;
  };

  let hostForThread: (thread: string) => Host;
  const custody = new Custody({
    model: { baseUrl, api, id, apiKey: secret(keyFile) },
    sdk: () => piAiPath(c.pi),
    host: (thread) => hostForThread(thread),
    ...(executor ? {
      socketRoot: executor.socketRoot,
      files: (thread: string) => {
        let service = fileServices.get(thread);
        if (!service) { service = new RootFileService(configForThread(thread), () => piToolsPath(piAiPath(c.pi))); fileServices.set(thread, service); }
        return service;
      },
      session: (thread: string) => `${store.dir(thread)}/session/thread.jsonl`,
    } : {}),
  });
  const threadCustody = (thread: string) => ({ socket: custody.open(thread), model: custody.publicModel, cleanup: async () => { try { await custody.closeThread(thread); } finally { fileServices.delete(thread); } } });
  const launch = executor ? containerLaunch({
    executor, custody: threadCustody, config: configForThread,
    memory: Boolean(c.tier1.memoryRoot), memoryPath: c.tier1.memoryRoot ? `${c.tier1.memoryRoot}/MEMORY.md` : undefined,
    screened: guardEnable,
  }) : tier1Launch({
    pi: c.pi,
    custody: threadCustody,
    memory: Boolean(c.tier1.memoryRoot),
    memoryPath: c.tier1.memoryRoot ? `${c.tier1.memoryRoot}/MEMORY.md` : undefined,
    screened: guardEnable,
    // Local execution adds the usable host jail when available.
    sandbox: {
      ...(c.tier1.sandbox?.bwrap ? { bwrap: c.tier1.sandbox.bwrap } : {}),
      stateRoot: c.stateRoot,
      worktreeRoot: c.mirror.worktreeRoot,
      agentDir,
      memoryRoot: c.tier1.memoryRoot,
    },
    config: configForThread,
    args: (t) => ["--model", `genie/${id}`, ...store.sessionArgs(t)],
  });

  // Wrap every outbound post in a structured envelope { text: <string> }, with approval: true
  // only on approval notices, so model output can never mint an approval request (Unit C10).
  // Records `lastReplyMessageId` in ThreadStateStore for GAP-6 redact/edit support.
  const postEnvelope = async (
    thread: string,
    msg: string | Draft | ExpertReply | PostEnvelope,
    approval?: boolean,
  ): Promise<string | void> => {
    let sentId: string | void;
    if (typeof msg === "object" && msg !== null && "text" in msg && (msg as PostEnvelope).approval === true) {
      sentId = await io.post.post(thread, msg as PostEnvelope);
    } else {
      const text = typeof msg === "string" ? msg : JSON.stringify(msg);
      const payload: PostEnvelope = approval ? { text, approval: true } : { text };
      sentId = await io.post.post(thread, payload);
    }
    if (typeof sentId === "string" && sentId) {
      store.setLastReplyMessageId(thread, sentId);
    }
    return sentId;
  };
  const redactLastPost = async (thread: string, reason?: string): Promise<string | void> => {
    const targetId = store.lastReplyMessageId(thread);
    if (!targetId) {
      throw new Error(`redactLastPost: no reply message id recorded for thread ${thread}`);
    }
    return io.post.post(thread, reason !== undefined ? { redact: targetId, reason } : { redact: targetId });
  };
  const editLastPost = async (thread: string, text: string): Promise<string | void> => {
    const targetId = store.lastReplyMessageId(thread);
    if (!targetId) {
      throw new Error(`editLastPost: no reply message id recorded for thread ${thread}`);
    }
    return io.post.post(thread, { edit: targetId, text });
  };
  const withheldInTurn = new Set<string>();
  const escalateAfterPost = async (
    t: string,
    draft: Draft,
  ): Promise<{ escalated: string | null } | { escalated: false; escalation: string }> => {
    try {
      return { escalated: await escalation.reply(t, draft) };
    } catch (e) {
      const rawMsg = e instanceof Error ? e.message : String(e);
      const reason = rawMsg
        .replace(/^escalation refused by the guard:\s*/i, "")
        .replace(/^thread\s+\S+:\s*escalation refused:\s*/i, "");
      console.error(`thread ${t}: escalation after reply failed: ${rawMsg}`);
      return { escalated: false, escalation: `refused: ${reason}` };
    }
  };

  const supervisor: Supervisor = new Supervisor(
    (t) => {
      const l = launch(t);
      return executor ? l : { ...l, env: { ...l.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" } };
    },
    async (t, r) => {
      try {
        if (r.type === "agent_settled" && withheldInTurn.delete(t)) {
          const st = store.read(t);
          if (st && st.status !== "closed") {
            await postEnvelope(t, WITHHELD);
            await escalateAfterPost(t, { answer: "", confidence: 0, gaps: [], escalate_forced: true });
          }
        }
      } finally {
        await lifecycle.event(t, r);
      }
    },
    (hostForThread = (t) => ({
      // The tier is the thread's, from P2's state, never the request's (E4's effectiveTier clamps it).
      // When the thread's tier refuses a capability (e.g. trusted eval on a public thread), tier 1's
      // tool result names it, the supervisor records the pending action with params fixed, and the bot
      // posts an approval request (C9, design row 24).
      eval: async (request) => {
        const bad = errors(evalRequestSchema, request);
        if (bad.length) throw new Error(`invalid eval arguments: ${bad.join("; ")}`);
        const req = request as EvalRequest;
        const tier = store.read(t)?.sender_tier ?? "public";
        if (req.trusted === "yes" && tier !== "trusted") {
          if (store.pendingActions(t).length >= 1) {
            const result = {
              refused: "trusted eval",
              error: "refused: a pending action is already awaiting approval on this thread",
            };
            return result;
          }
          const action = "eval";
          const rawNotice = approvalNotice(action, req);
          const out = await outbound(context(t).cleaned_question, (scrub) => scrub(rawNotice.text), guardOut);
          if (!("value" in out)) {
            const result = {
              refused: "trusted eval",
              error: `refused: ${out.reason}`,
            };
            return result;
          }
          const sentEventId = (await postEnvelope(t, { approval: true, text: out.value })) ?? undefined;
          const pendingAction: PendingAction = {
            action,
            params: JSON.parse(JSON.stringify(req)),
            thread: t,
            requested_at: new Date().toISOString(),
            posted_event_id: typeof sentEventId === "string" ? sentEventId : undefined,
          };
          store.addPendingAction(pendingAction);
          const result = {
            refused: "trusted eval",
            error: "refused: trusted eval on a public thread",
          };
          return result;
        }
        const result = await evalIn(t, {
          request: req,
          sender_tier: tier,
          thread: t,
        });
        setContext(t, { eval_transcript: [...context(t).eval_transcript, { request, result }] });
        return result;
      },
      // Recall from Hindsight ("support" -> genie, "memory" -> genie-memory).
      // Owner ruling of 2026-11-06 (GE2 C-6): Hindsight recall banks are curated trusted sources
      // and are not screened by guard-in.
      recall: async (req) => {
        const query = typeof req === "string" ? req : req.query;
        const bank = typeof req === "string" ? undefined : req.bank;
        const client = new HindsightRecallClient(hindsightUrl, recallBankId(bank));
        const res = await client.recall({ query });
        const results: BankRecallItem[] = res.results ?? [];
        setContext(t, {
          recall_transcript: [
            ...context(t).recall_transcript,
            { query, ...(bank !== undefined ? { bank } : {}), results },
          ],
        });
        return { ...(res.entities !== undefined ? { entities: res.entities } : {}), results };
      },
      // GE2 (C-1 / C-2): rebuilds cleaned_question and transcripts unconditionally from context(t)
      // and scrubs + guard-outs draft and gaps before Escalation.escalate.
      escalate: async (pkg) => {
        withheldInTurn.delete(t);
        lifecycle.disarm(t);
        const p = pkg as Package;
        const ctx = context(t);
        const out = await outbound(
          ctx.cleaned_question,
          (scrub) => ({
            draft: {
              ...p.draft,
              answer: scrub(p.draft.answer),
              gaps: p.draft.gaps.map(scrub),
            },
            gaps: p.gaps.map(scrub),
          }),
          guardOut,
        );
        if (!("value" in out)) {
          throw new Error(`escalation refused: ${out.reason}`);
        }
        return escalation.escalate(t, {
          cleaned_question: ctx.cleaned_question,
          eval_transcript: ctx.eval_transcript,
          ...(ctx.recall_transcript.length > 0 ? { recall_transcript: ctx.recall_transcript } : {}),
          ...(ctx.git_transcript.length > 0 ? { git_transcript: ctx.git_transcript } : {}),
          ...(ctx.gh_transcript.length > 0 ? { gh_transcript: ctx.gh_transcript } : {}),
          draft: out.value.draft,
          gaps: out.value.gaps,
        });
      },
      // The draft leaves only as redacted and passed by guard-out. A withheld draft is neither posted
      // nor escalated on the spot: tier 1 receives {posted: false, reason} so it can retry, and WITHHELD
      // is posted only if the turn settles without any posted reply (GI-11).
      // When `silent === true` (GAP-1), emits `{"silent": true}` to matrix-xmsg without posting a
      // visible Matrix message, running guardOut, or escalating.
      reply: async (raw) => {
        lifecycle.disarm(t);
        const d = raw as Draft;
        if (d.silent === true) {
          withheldInTurn.delete(t);
          await io.post.post(t, { silent: true });
          return { posted: true, silent: true, escalated: null };
        }
        const out = await outbound(context(t).cleaned_question, (scrub): Draft => ({ ...d, answer: scrub(d.answer), gaps: d.gaps.map(scrub) }), guardOut);
        if (!("value" in out)) {
          console.error(`thread ${t}: reply withheld: ${out.reason}`);
          withheldInTurn.add(t);
          return { posted: false, reason: out.reason };
        }
        withheldInTurn.delete(t);
        await postEnvelope(t, out.value);
        return { posted: true, ...(await escalateAfterPost(t, out.value)) };
      },
      propose: (p) => propose(t, p),
      clone: (url) => worktreeFor({ ...c.mirror, cluster: c.mirror.cluster ?? c.tier1.cluster }, url, t, io.git),
      git: async (request) => {
        const bad = errors(gitRequestSchema, request);
        if (bad.length) throw new Error(`invalid git arguments: ${bad.join("; ")}`);
        const out = await gitRead(request as GitRequest, {
          mirrorRoot: c.mirror.mirrorRoot,
          worktreeRoot: c.mirror.worktreeRoot,
          thread: t,
          repoUrlBase: c.mirror.repoUrlBase ?? (c as { repoUrlBase?: string }).repoUrlBase,
          git: io.git,
        });
        const screenedAtTool = (c.gitScreen?.enable ?? false) && guardEnable;
        if (screenedAtTool) {
          const screened = await gitScreen(out.output);
          setContext(t, {
            git_transcript: [
              ...context(t).git_transcript,
              { request: request as GitRequest, output: screened, screened: true },
            ],
          });
          return { ...out, output: screened };
        }
        setContext(t, {
          git_transcript: [
            ...context(t).git_transcript,
            { request: request as GitRequest, output: out.output, screened: false },
          ],
        });
        return out;
      },
      gh_read: async (request) => {
        const bad = errors(ghReadSchema, request);
        if (bad.length) throw new Error(`invalid gh_read arguments: ${bad.join("; ")}`);
        const res = await ghRead(request as GhReadRequest, {
          githubApi: c.broker?.githubApi,
          tokenFile: c.githubReadTokenFile,
        });
        const rawJson = JSON.stringify(res);
        const screenedAtTool = (c.ghScreen?.enable ?? false) && guardEnable;
        if (screenedAtTool) {
          const screened = await ghScreen(rawJson);
          setContext(t, {
            gh_transcript: [
              ...context(t).gh_transcript,
              { request: request as GhReadRequest, output: screened, screened: true },
            ],
          });
          try {
            return JSON.parse(screened);
          } catch {
            return screened;
          }
        }
        setContext(t, {
          gh_transcript: [
            ...context(t).gh_transcript,
            { request: request as GhReadRequest, output: rawJson, screened: false },
          ],
        });
        return res;
      },
      screen,
      room_context: async (request) => {
        if (!io.request) {
          throw new Error("room_context is not configured on this Io adapter");
        }
        if (typeof request !== "object" || request === null || Array.isArray(request)) {
          throw new Error("invalid room_context request");
        }
        const reqObj =
          "context" in request && typeof (request as { context?: unknown }).context === "object" && (request as { context?: unknown }).context !== null
            ? (request as { context: Record<string, unknown> })
            : { context: request as Record<string, unknown> };
        if ("room" in reqObj.context || "room" in (request as Record<string, unknown>)) {
          throw new Error("room_context: room parameter is not permitted; the room is bound by the bot");
        }
        const reply = await io.request(t, reqObj);
        const trimmed = reply.trim();
        if (trimmed.startsWith("{")) {
          let parsedErr: Record<string, unknown> | undefined;
          try {
            const obj = JSON.parse(trimmed);
            if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
              parsedErr = obj as Record<string, unknown>;
            }
          } catch {
            // not a JSON object
          }
          if (parsedErr && ("context" in parsedErr || "error" in parsedErr)) {
            const kind = String(parsedErr.context ?? parsedErr.error);
            const reason = typeof parsedErr.reason === "string" ? `: ${parsedErr.reason}` : "";
            const retry =
              typeof parsedErr.retry_after_ms === "number"
                ? ` (retry_after_ms=${parsedErr.retry_after_ms})`
                : "";
            throw new Error(`room_context ${kind}${reason}${retry}`);
          }
        }
        return screen(reply);
      },
    })),
  );

  // Close archives too (design §6, "on close and on GC"). A failed archive is logged and the close
  // stands: P3's collection archives the thread again.
  class ArchivingLifecycle extends Lifecycle {
    async close(thread: string): Promise<void> {
      await super.close(thread);
      await archive(thread).catch((e) => console.error(`archive ${thread}: ${e}`));
    }
  }
  const lifecycle: Lifecycle = new ArchivingLifecycle({
    supervisor,
    store,
    mirror: c.mirror,
    clock,
    questionTimeoutMs: c.tier1.questionTimeoutMs,
    checkinMs: c.tier1.checkinMs,
    maxConcurrentTurns: c.tier1.maxConcurrentTurns,
    maxQueueWaitSecs: c.tier1.maxQueueWaitSecs,
    onHandlerError: io.onHandlerError,
    onDeadline: async (t) => {
      const out = await outbound(context(t).cleaned_question, (scrub) => scrub(DEADLINE_NOTICE), guardOut);
      if (!("value" in out)) {
        console.error(`thread ${t}: deadline notice withheld: ${out.reason}`);
        await postEnvelope(t, WITHHELD);
      } else {
        await postEnvelope(t, out.value);
      }
      await escalateAfterPost(t, { answer: "", confidence: 0, gaps: [], escalate_forced: true });
    },
    onQueueTimeout: async (t) => {
      const out = await outbound(context(t).cleaned_question, (scrub) => scrub(DEADLINE_NOTICE), guardOut);
      if (!("value" in out)) {
        console.error(`thread ${t}: queue timeout notice withheld: ${out.reason}`);
        await postEnvelope(t, WITHHELD);
      } else {
        await postEnvelope(t, out.value);
      }
      await escalateAfterPost(t, { answer: "", confidence: 0, gaps: ["tier-1 busy"], escalate_forced: true });
    },
    deeper: (t) => escalation.deeper(t),
    replayResume: c.s3
      ? (t) => replayResume({ supervisor, thread: t, s3: c.s3!, guard, store, tier: store.tombstone(t)?.tier })
      : undefined,
    resync: io.request ? (t) => resyncThread(t, io.request!, screen) : undefined,
  });
  const gc = new Gc({ store, mirror: c.mirror, archive, supervisor, clock });

  // C7 reads the raw envelope before guard-in; a reject is answered with a refusal and never
  // reaches pi. An expert reply is judged by guard-out (C8); a blocked reply is dropped from
  // context and transcript, posting WITHHELD and recorded with a tier label only for the archive (P4).
  const handle = async (i: Inbound): Promise<void> => {
    if ("envelope" in i) {
      const hadState = existsSync(`${store.stateRoot}/${i.thread}/state.json`);
      const isDelta = /<context\b[^>]*\bcontext="delta"/.test(i.envelope);
      let text: string;
      try {
        observe(store, i.thread, parseEnvelope(i.envelope));
        text = await guardIn(io.guard, i.envelope, {
          enabled: guardEnable,
          ...(i.screened !== undefined ? { preScreened: i.screened } : {}),
        });
      } catch (e) {
        console.error(`thread ${i.thread}: ${e}`);
        await postEnvelope(i.thread, REFUSAL);
        return;
      }
      withheldInTurn.delete(i.thread);
      let envAddressed = true;
      for (const l of i.envelope.split("\n")) {
        if (l.startsWith("[matrix] ")) {
          const m = /\baddressed="(true|false)"/.exec(l);
          if (m) {
            envAddressed = m[1] === "true";
            break;
          }
        } else if (
          l === "<request>" ||
          /^<request(?:\s+(?:addressed="(?:true|false)"|screened="(?:true|false)"|note="[^"]*"))+>$/.test(l)
        ) {
          const m = /\baddressed="(true|false)"/.exec(l);
          if (m) envAddressed = m[1] === "true";
          break;
        }
      }
      const addressed = i.addressed ?? envAddressed;
      setContext(i.thread, { cleaned_question: text, addressed });
      await lifecycle.message(i.thread, text, { hadState, isDelta });
    } else if ("expert" in i) {
      const check = parseExpertReply(i.expert);
      if (!check.ok) {
        console.error(`thread ${i.thread}: malformed expert reply rejected: ${check.error}`);
        return;
      }
      const parsed = check.value;
      if (parsed.silent === true) {
        await io.post.post(i.thread, { silent: true });
        return;
      }
      const q = context(i.thread).cleaned_question;
      const out = await outbound(
        q,
        (scrub): ExpertReply => ({ ...parsed, answer: scrub(parsed.answer), gaps: parsed.gaps.map(scrub) }),
        guardOut,
      );
      if (!("value" in out)) {
        console.error(`thread ${i.thread}: expert reply withheld: ${out.reason}`);
        store.addBlockedExpertReply(i.thread, store.read(i.thread)?.sender_tier ?? "public");
        await postEnvelope(i.thread, WITHHELD);
        return;
      }
      const serialized = JSON.stringify(out.value);
      await postEnvelope(i.thread, serialized);
      await lifecycle.message(i.thread, serialized);
    } else if (i.control === "trust") {
      observe(store, i.thread, i);
    } else if (i.control === "approve") {
      // One-shot approval (Unit C10, design row 24):
      // An approval control carrying a trusted sender's tier runs the named pending action once
      // with the trusted capability, logs approver + action, posts the result, and consumes the record;
      // the thread tier is unchanged.
      // A non-trusted tier, or a target with no pending action, does nothing.
      if (i.tier !== "trusted") return;
      const target = i.target;
      if (!target) return;
      const pending = store.consumePendingAction(target, i.thread);
      if (!pending) return;

      const approver = i.sender_id ?? i.sender ?? "unknown";
      console.log(`approved action ${pending.action} by ${approver} for target ${target}`);

      if (pending.action === "eval") {
        const evalReq = pending.params as EvalRequest;
        const evalResult = await evalIn(pending.thread, {
          request: evalReq,
          sender_tier: "trusted",
          thread: pending.thread,
        });
        const postContent = typeof evalResult.stdout_tail === "string" && evalResult.stdout_tail.length > 0
          ? evalResult.stdout_tail
          : JSON.stringify(evalResult);
        await postEnvelope(pending.thread, postContent);
        setContext(pending.thread, { eval_transcript: [...context(pending.thread).eval_transcript, { request: evalReq, result: evalResult }] });
      }
    } else if (i.control === "accept" || i.control === "deeper") {
      await lifecycle.control(i.thread, i.control);
    }
  };

  let bridge: BrokerBridge | undefined;
  if (c.broker.bridge) {
    const limits = io.registrationLimits;
    if (!io.setBrokerHandler || !io.brokerReply || !limits || !Number.isInteger(limits.max_body_bytes)
        || !Number.isInteger(limits.reply_ttl_secs) || !Number.isInteger(limits.idempotency_ttl_secs)) {
      throw new Error("broker.bridge requires negotiated xmsg body and replay limits");
    }
    const negotiatedContract = JSON.stringify([limits.max_body_bytes, limits.reply_ttl_secs, limits.idempotency_ttl_secs]);
    let contractChanged = false;
    const checkContract = () => {
      const current = io.registrationLimits;
      contractChanged ||= JSON.stringify([current?.max_body_bytes, current?.reply_ttl_secs, current?.idempotency_ttl_secs]) !== negotiatedContract;
      if (contractChanged) {
        throw new Error("broker bus limits changed; restart root to renegotiate");
      }
    };
    bridge = new BrokerBridge({
      stateRoot: `${c.stateRoot}/broker-bridge`, allowlist: c.broker.bridge.allowlist,
      maxBodyBytes: Math.min(c.broker.bridge.maxBodyBytes ?? 65_536, limits.max_body_bytes!),
      retentionMs: Math.max(limits.reply_ttl_secs!, limits.idempotency_ttl_secs!) * 1000,
      checkContract,
      propose: (principal, proposal) => propose(`broker-${createHash("sha256").update(JSON.stringify([principal.service, principal.node])).digest("hex")}`, proposal),
      reply: (id, text, key) => {
        const currentMax = io.registrationLimits?.max_body_bytes;
        if (!Number.isSafeInteger(currentMax) || currentMax! < new TextEncoder().encode(text).byteLength) {
          throw new Error("broker result exceeds current bus limit");
        }
        return io.brokerReply!(id, text, key);
      },
    });
    io.setBrokerHandler((message) => bridge!.accept({ ...message, origin: message.origin }), (message) => bridge!.acknowledge({ ...message, origin: message.origin }));
  }

  return {
    store,
    supervisor,
    lifecycle,
    gc,
    context,
    redactLastPost,
    editLastPost,
    async start() {
      await bridge?.start();
      lifecycle.start();
      gc.start();
    },
    // Reads the intake until it closes; an item that fails is logged and the next one runs.
    async run(): Promise<void> {
      for (let batch; (batch = await io.intake.next()); )
        for (const i of batch) await handle(i).catch((e) => console.error(`thread ${i.thread}: ${e}`));
    },
    async stop(): Promise<void> {
      await bridge?.close();
      lifecycle.stop();
      gc.stop();
      await supervisor.shutdown();
      await custody.close();
    },
  };
}
