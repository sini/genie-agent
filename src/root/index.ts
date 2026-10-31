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
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { archiver, replayResume, type S3Config } from "../archive/index.ts";
import { type BankRecallItem, DEFAULT_HINDSIGHT_ENDPOINT, HindsightRecallClient, recallBankId } from "../bank/index.ts";
import { gist } from "../broker/gist.ts";
import { broker, byKind, outbound } from "../broker/index.ts";
import { pr } from "../broker/pr.ts";
import { parseExpertReply, type ExpertReply } from "../dispatcher/reply.ts";
import { escalationGuard } from "../escalation/guard.ts";
import { Escalation, type Package, type XmsgSend } from "../escalation/index.ts";
import { router } from "../escalation/route.ts";
import { withCache } from "../eval/cache.ts";
import { perThread, type Runner } from "../eval/lock.ts";
import { type EvalRequest, type RunOptions, runEval } from "../eval/run.ts";
import { Gc } from "../gc/index.ts";
import { type Envelope, type Line, verdictErrors } from "../guard/verdict.ts";
import { type Clock, Lifecycle } from "../lifecycle/index.ts";
import { type MirrorConfig, worktreeFor } from "../mirror/index.ts";
import { ThreadStateStore, type PendingAction, type Tier } from "../state/index.ts";
import { type GuardClient, webScreen } from "../supervisor/guard-client.ts";
import { Supervisor } from "../supervisor/index.ts";
import { seedGuard } from "../supervisor/seed.ts";
import type { Draft } from "../tier1/draft.ts";
import type { Config as Tier1Config } from "../tier1/index.ts";
import { tier1Launch, writePiModelsJson } from "../tier1/launch.ts";
import { observe, parseEnvelope, type TrustControl } from "../tier/index.ts";

export interface ApproveControl {
  control: "approve";
  sender?: string;
  sender_id?: string;
  tier?: Tier | string;
  target?: string;
}

// One inbound item from matrix-xmsg or xmsg, on the thread it belongs to: the raw envelope exactly as
// matrix-xmsg sends it (carrying `screened: false` when matrix-xmsg forwarded under fail-open, M26),
// `!trust` (C7's TrustControl), a ✅ accept / 🔍 deeper reaction, an approve control (C10),
// or an expert reply.
export type Inbound =
  | ({ thread: string } & (
      | { envelope: string; screened?: false }
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

export type PostPayload = PostEnvelope;

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
}

// Every secret is a file path, read at start or at use, never argv or the environment.
export interface Config {
  stateRoot: string;
  storeRoot: string;
  mirror: MirrorConfig;
  // The pi executable.
  pi: string;
  // Tier 1's OpenAI-compatible model.
  model: { baseUrl: string; api: string; id: string; keyFile: string };
  tier1: Omit<Tier1Config, "root">;
  // Inbound guard-in screening switch (G11; default true).
  guard?: { enable?: boolean };
  // Hindsight dataplane endpoint for recall ("support" -> genie, "memory" -> genie-memory).
  hindsightUrl?: string;
  s3?: S3Config | null;
  // threadLink: the thread's public URL with `{thread}` where the thread id goes; a PR needs it.
  broker: {
    tokenFile?: string | null;
    githubApi?: string;
    threadLink?: string;
    guardOut?: { enable?: boolean; base?: string; model?: string; keyFile?: string };
  };
  // E1/E4/E2.3 RunOptions; memoryMax, when set, needs a delegated cgroup per eval.
  eval?: Pick<RunOptions, "timeoutMs" | "builders" | "memoryMax">;
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
const secret = (file: string) => readFileSync(file, "utf8").trim();

// Fixed notices, posted without guard-out: no thread text is in them.
export const REFUSAL = "I can't help with that message.";
export const WITHHELD = "I drafted an answer, but my output check held it back. I've flagged this for review.";
export const DEADLINE_NOTICE = readFileSync(new URL("prompts/tier1-deadline.md", repo).pathname, "utf8").trim();
export const approvalNotice = (action: string, params: unknown): PostEnvelope & { approval: true } => ({
  approval: true,
  text: `Approval requested: ${action} ${JSON.stringify(params)}`,
});
export const approvalRequest = approvalNotice;

// guard-in on an inbound envelope (design §4 step 1): the trigger's line is the content and every
// context line its history, in envelope order, each with its authenticated tier. Runs on every
// inbound envelope, including fail-open forwards (`<request screened="false" note="…">`). The text
// tier 1 may see: the line on allow, the guard's cleaned_text on rewrite. Anything else refuses it.
// When `enabled` is false (G11), passes `content.text` through unscreened without calling the guard.
export async function guardIn(
  guard: GuardClient | undefined,
  raw: string,
  opts: { enabled?: boolean } = {},
): Promise<string> {
  const enabled = opts.enabled ?? true;
  const history: Line[] = [];
  let content: Line | undefined;
  let inRequest = false;
  for (const l of raw.split("\n")) {
    if (l === "<request>" || /^<request\s+screened="false"(?:\s+note="[^"]*")?>$/.test(l)) inRequest = true;
    else if (l === "</request>") inRequest = false;
    else if (l.startsWith("{")) {
      const { sender, tier, text } = JSON.parse(l);
      if (typeof text !== "string") throw new Error("guard-in: an envelope line without text");
      inRequest ? (content = { sender, tier, text }) : history.push({ sender, tier, text });
    }
  }
  if (!content) throw new Error("guard-in: an envelope without request content");
  if (!enabled) return content.text;
  if (!guard) throw new Error("guard-in: no verdict");
  const e: Envelope = { source: "message", history, content };
  const v = await guard.check(e).catch((err) => ({ unavailable: String(err) }));
  if ("unavailable" in v || verdictErrors(v).length) throw new Error("guard-in: no verdict");
  if (v.verdict === "allow") return e.content.text;
  if (v.verdict === "rewrite") return v.cleaned_text;
  throw new Error(`guard-in: rejected: ${v.reason}`);
}

export function validateRootConfig(c: Config): { guardEnable: boolean; guardOutEnable: boolean } {
  const guardEnable = c.guard?.enable ?? true;
  const guardOutEnable = c.broker?.guardOut?.enable ?? true;
  if (guardEnable && c.xmsg !== undefined && "guard" in c.xmsg) {
    if (c.xmsg.guard === null || (c.xmsg.guard !== undefined && "target" in c.xmsg.guard && !c.xmsg.guard.target)) {
      throw new Error("xmsg.guard.target is required when guard.enable is true");
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

export function main(configFile: string, io: Io, run?: Runner, clock?: Clock) {
  const c: Config = JSON.parse(readFileSync(configFile, "utf8"));
  const { guardEnable, guardOutEnable } = validateRootConfig(c);
  const store = new ThreadStateStore(c.stateRoot, c.storeRoot);
  const archive = c.s3 ? archiver(store, c.s3) : async () => {};
  const evalIn = withCache(store, perThread(run ?? ((l) => runEval(l, c.eval))));
  const screen = webScreen(io.guard, { enabled: guardEnable });
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

  // C5's record of the thread: its latest cleaned question and its evals, beside P2's state.
  type Context = { cleaned_question: string; eval_transcript: unknown[] };
  const file = (t: string) => `${store.dir(t)}/context.json`;
  const context = (t: string): Context => (existsSync(file(t)) ? JSON.parse(readFileSync(file(t), "utf8")) : { cleaned_question: "", eval_transcript: [] });
  const setContext = (t: string, x: Partial<Context>) => writeFileSync(file(t), JSON.stringify({ ...context(t), ...x }));

  const { githubApi, threadLink } = c.broker ?? {};
  const link = (t: string) => {
    if (!threadLink) throw new Error("broker.threadLink is not configured");
    return threadLink.replace("{thread}", encodeURIComponent(t));
  };
  const act = byKind({ gist: gist(githubApi), pr: pr(link, githubApi) });

  const escalation = new Escalation({
    store,
    xmsg: io.xmsg,
    guard: escalationGuard(io.guard, { enabled: guardEnable }),
    route: router(c.experts),
    context: (t) => {
      const { cleaned_question, eval_transcript } = context(t);
      return { cleaned_question, eval_transcript };
    },
  });

  // pi reads its model from its agent dir; the key goes into a file there, never argv or env.
  const agentDir = mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/genie-pi-`);
  const { baseUrl, api, id, keyFile } = c.model;
  writePiModelsJson(agentDir, { baseUrl, api, apiKey: secret(keyFile), id });
  const launch = tier1Launch({
    pi: c.pi,
    memory: Boolean(c.tier1.memoryRoot),
    memoryPath: c.tier1.memoryRoot ? `${c.tier1.memoryRoot}/MEMORY.md` : undefined,
    screened: guardEnable,
    config: (t) => ({ ...c.tier1, root: `${c.mirror.worktreeRoot}/${t}` }),
    args: (t) => ["--model", `genie/${id}`, ...store.sessionArgs(t)],
  });

  // Wrap every outbound post in a structured envelope { text: <string> }, with approval: true
  // only on approval notices, so model output can never mint an approval request (Unit C10).
  const postEnvelope = async (
    thread: string,
    msg: string | Draft | ExpertReply | PostEnvelope,
    approval?: boolean,
  ): Promise<string | void> => {
    if (typeof msg === "object" && msg !== null && "text" in msg && (msg as PostEnvelope).approval === true) {
      return io.post.post(thread, msg as PostEnvelope);
    }
    const text = typeof msg === "string" ? msg : JSON.stringify(msg);
    const payload: PostEnvelope = approval ? { text, approval: true } : { text };
    return io.post.post(thread, payload);
  };
  const withheldInTurn = new Set<string>();

  const supervisor: Supervisor = new Supervisor(
    (t) => {
      const l = launch(t);
      return { ...l, env: { ...l.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" } };
    },
    async (t, r) => {
      if (r.type === "agent_settled" && withheldInTurn.delete(t)) {
        const st = store.read(t);
        if (st && st.status !== "closed") {
          await postEnvelope(t, WITHHELD);
          await escalation.reply(t, { answer: "", confidence: 0, gaps: [], escalate_forced: true });
        }
      }
      await lifecycle.event(t, r);
    },
    (t) => ({
      // The tier is the thread's, from P2's state, never the request's (E4's effectiveTier clamps it).
      // When the thread's tier refuses a capability (e.g. trusted eval on a public thread), tier 1's
      // tool result names it, the supervisor records the pending action with params fixed, and the bot
      // posts an approval request (C9, design row 24).
      eval: async (request) => {
        const req = request as EvalRequest;
        const tier = store.read(t)?.sender_tier ?? "public";
        if (req.trusted === "yes" && tier !== "trusted") {
          const action = "eval";
          const sentEventId = (await postEnvelope(t, approvalNotice(action, req))) ?? undefined;
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
          setContext(t, { eval_transcript: [...context(t).eval_transcript, { request, result }] });
          return result;
        }
        const result = await evalIn(t, { request: req, sender_tier: tier });
        setContext(t, { eval_transcript: [...context(t).eval_transcript, { request, result }] });
        return result;
      },
      // Recall from Hindsight ("support" -> genie, "memory" -> genie-memory), screening every
      // returned entry's text through S6's seedGuard(io.guard); a withheld entry is dropped.
      recall: async (req) => {
        const query = typeof req === "string" ? req : req.query;
        const bank = typeof req === "string" ? undefined : req.bank;
        const client = new HindsightRecallClient(hindsightUrl, recallBankId(bank));
        const res = await client.recall({ query });
        const results: BankRecallItem[] = [];
        for (const item of res.results ?? []) {
          try {
            const text = await guard.bankEntry(item.text);
            results.push({ ...item, text });
          } catch (e) {
            console.error(`thread ${t}: recall entry ${item.id ?? ""} withheld: ${e}`);
          }
        }
        return { ...(res.entities !== undefined ? { entities: res.entities } : {}), results };
      },
      escalate: (pkg) => {
        withheldInTurn.delete(t);
        lifecycle.disarm(t);
        return escalation.escalate(t, pkg as Package);
      },
      // The draft leaves only as redacted and passed by guard-out. A withheld draft is neither posted
      // nor escalated on the spot: tier 1 receives {posted: false, reason} so it can retry, and WITHHELD
      // is posted only if the turn settles without any posted reply (GI-11).
      reply: async (raw) => {
        lifecycle.disarm(t);
        const d = raw as Draft;
        const out = await outbound(context(t).cleaned_question, (scrub): Draft => ({ ...d, answer: scrub(d.answer), gaps: d.gaps.map(scrub) }), guardOut);
        if (!("value" in out)) {
          console.error(`thread ${t}: reply withheld: ${out.reason}`);
          withheldInTurn.add(t);
          return { posted: false, reason: out.reason };
        }
        withheldInTurn.delete(t);
        await postEnvelope(t, out.value);
        return { posted: true, escalated: await escalation.reply(t, out.value) };
      },
      propose: async (p) => {
        if (!c.broker.tokenFile) {
          return {
            thread: t,
            acted: false,
            reason: "the proposal broker is not configured on this deployment",
            redactions: [],
          };
        }
        return broker(t, JSON.stringify(p), { tokenFile: c.broker.tokenFile, guard: guardOut, act });
      },
      clone: (url) => worktreeFor(c.mirror, url, t),
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
    }),
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
    onDeadline: async (t) => {
      const out = await outbound(context(t).cleaned_question, (scrub) => scrub(DEADLINE_NOTICE), guardOut);
      if (!("value" in out)) {
        console.error(`thread ${t}: deadline notice withheld: ${out.reason}`);
        await postEnvelope(t, WITHHELD);
      } else {
        await postEnvelope(t, out.value);
      }
      await escalation.reply(t, { answer: "", confidence: 0, gaps: [], escalate_forced: true });
    },
    onQueueTimeout: async (t) => {
      const out = await outbound(context(t).cleaned_question, (scrub) => scrub(DEADLINE_NOTICE), guardOut);
      if (!("value" in out)) {
        console.error(`thread ${t}: queue timeout notice withheld: ${out.reason}`);
        await postEnvelope(t, WITHHELD);
      } else {
        await postEnvelope(t, out.value);
      }
      await escalation.reply(t, { answer: "", confidence: 0, gaps: ["tier-1 busy"], escalate_forced: true });
    },
    deeper: (t) => escalation.deeper(t),
    replayResume: c.s3
      ? (t) => replayResume({ supervisor, thread: t, s3: c.s3!, guard, store, tier: store.tombstone(t)?.tier })
      : undefined,
    resync: io.request ? (t) => resyncThread(t, io.request!, screen) : undefined,
  });
  const gc = new Gc({ store, mirror: c.mirror, archive });

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
        text = await guardIn(io.guard, i.envelope, { enabled: guardEnable });
      } catch (e) {
        console.error(`thread ${i.thread}: ${e}`);
        await postEnvelope(i.thread, REFUSAL);
        return;
      }
      withheldInTurn.delete(i.thread);
      setContext(i.thread, { cleaned_question: text });
      await lifecycle.message(i.thread, text, { hadState, isDelta });
    } else if ("expert" in i) {
      const check = parseExpertReply(i.expert);
      if (!check.ok) {
        console.error(`thread ${i.thread}: malformed expert reply rejected: ${check.error}`);
        return;
      }
      const parsed = check.value;
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
        const evalResult = await evalIn(pending.thread, { request: evalReq, sender_tier: "trusted" });
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

  return {
    store,
    supervisor,
    lifecycle,
    gc,
    start() {
      lifecycle.start();
      gc.start();
    },
    // Reads the intake until it closes; an item that fails is logged and the next one runs.
    async run(): Promise<void> {
      for (let batch; (batch = await io.intake.next()); )
        for (const i of batch) await handle(i).catch((e) => console.error(`thread ${i.thread}: ${e}`));
    },
    async stop(): Promise<void> {
      lifecycle.stop();
      gc.stop();
      await supervisor.shutdown();
    },
  };
}
