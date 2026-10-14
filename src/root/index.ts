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
import { gist } from "../broker/gist.ts";
import { broker, byKind, outbound } from "../broker/index.ts";
import { pr } from "../broker/pr.ts";
import { escalationGuard } from "../escalation/guard.ts";
import { Escalation, type Package, type XmsgSend } from "../escalation/index.ts";
import { router } from "../escalation/route.ts";
import { withCache } from "../eval/cache.ts";
import { perThread, type Runner } from "../eval/lock.ts";
import { type EvalRequest, type RunOptions, runEval } from "../eval/run.ts";
import { Gc } from "../gc/index.ts";
import { type Envelope, type Line, verdictErrors } from "../guard/verdict.ts";
import { Lifecycle } from "../lifecycle/index.ts";
import { type MirrorConfig, worktreeFor } from "../mirror/index.ts";
import { ThreadStateStore, type Tier } from "../state/index.ts";
import { type GuardClient, webScreen } from "../supervisor/guard-client.ts";
import { Supervisor } from "../supervisor/index.ts";
import { seedGuard } from "../supervisor/seed.ts";
import type { Draft } from "../tier1/draft.ts";
import type { Config as Tier1Config } from "../tier1/index.ts";
import { tier1Launch } from "../tier1/launch.ts";
import { observe, parseEnvelope, type TrustControl } from "../tier/index.ts";

// One inbound item from matrix-xmsg or xmsg, on the thread it belongs to: the raw envelope exactly as
// matrix-xmsg sends it, `!trust` (C7's TrustControl), a ✅ accept / 🔍 deeper reaction, or an expert reply.
export type Inbound = { thread: string } & (
  | { envelope: string }
  | TrustControl
  | { control: "accept" | "deeper" }
  | { expert: string }
);

export interface Intake {
  // The next batch of inbound items, in arrival order; null once the intake has closed.
  next(): Promise<Inbound[] | null>;
}

export interface Post {
  // A message to the bot's thread: tier 1's draft, or a notice such as a refusal.
  post(thread: string, message: Draft | string): Promise<void>;
}

export interface Io {
  intake: Intake;
  post: Post;
  guard: GuardClient;
  xmsg: XmsgSend;
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
  s3: S3Config;
  // threadLink: the thread's public URL with `{thread}` where the thread id goes; a PR needs it.
  broker: { tokenFile: string; githubApi?: string; threadLink?: string; guardOut: { base: string; model: string; keyFile?: string } };
  // E1/E4/E2.3 RunOptions; memoryMax, when set, needs a delegated cgroup per eval.
  eval?: Pick<RunOptions, "timeoutMs" | "builders" | "memoryMax">;
  experts?: Record<Tier, string>;
}

// Fixed notices, posted without guard-out: no thread text is in them.
export const REFUSAL = "I can't help with that message.";
export const WITHHELD = "I drafted an answer, but my output check withheld it. Please rephrase your question.";

const repo = new URL("../../", import.meta.url);
const secret = (file: string) => readFileSync(file, "utf8").trim();

// guard-in on an inbound envelope (design §4 step 1): the trigger's line is the content and every
// context line its history, in envelope order, each with its authenticated tier. The text tier 1 may
// see: the line on allow, the guard's cleaned_text on rewrite. Anything else refuses it.
async function guardIn(guard: GuardClient, raw: string): Promise<string> {
  const history: Line[] = [];
  let content: Line | undefined;
  let inRequest = false;
  for (const l of raw.split("\n")) {
    if (l === "<request>" || l === "</request>") inRequest = l === "<request>";
    else if (l.startsWith("{")) {
      const { sender, tier, text } = JSON.parse(l);
      if (typeof text !== "string") throw new Error("guard-in: an envelope line without text");
      inRequest ? (content = { sender, tier, text }) : history.push({ sender, tier, text });
    }
  }
  const e: Envelope = { source: "message", history, content: content! };
  const v = await guard.check(e).catch((err) => ({ unavailable: String(err) }));
  if ("unavailable" in v || verdictErrors(v).length) throw new Error("guard-in: no verdict");
  if (v.verdict === "allow") return e.content.text;
  if (v.verdict === "rewrite") return v.cleaned_text;
  throw new Error(`guard-in: rejected: ${v.reason}`);
}

export function main(configFile: string, io: Io, run?: Runner) {
  const c: Config = JSON.parse(readFileSync(configFile, "utf8"));
  const store = new ThreadStateStore(c.stateRoot, c.storeRoot);
  const archive = archiver(store, c.s3);
  const evalIn = withCache(store, perThread(run ?? ((l) => runEval(l, c.eval))));
  const screen = webScreen(io.guard);
  const { base, model, keyFile: outKey } = c.broker.guardOut;
  const guardOut = { base, model, system: readFileSync(new URL("prompts/guard-out.md", repo).pathname, "utf8"), apiKey: outKey && secret(outKey) };

  // C5's record of the thread: its latest cleaned question and its evals, beside P2's state.
  type Context = { cleaned_question: string; eval_transcript: unknown[] };
  const file = (t: string) => `${store.dir(t)}/context.json`;
  const context = (t: string): Context => (existsSync(file(t)) ? JSON.parse(readFileSync(file(t), "utf8")) : { cleaned_question: "", eval_transcript: [] });
  const setContext = (t: string, x: Partial<Context>) => writeFileSync(file(t), JSON.stringify({ ...context(t), ...x }));

  const { githubApi, threadLink } = c.broker;
  const link = (t: string) => {
    if (!threadLink) throw new Error("broker.threadLink is not configured");
    return threadLink.replace("{thread}", encodeURIComponent(t));
  };
  const act = byKind({ gist: gist(githubApi), pr: pr(link, githubApi) });

  const escalation = new Escalation({
    store,
    xmsg: io.xmsg,
    guard: escalationGuard(io.guard),
    route: router(c.experts),
    context: (t) => {
      const { cleaned_question, eval_transcript } = context(t);
      return { cleaned_question, eval_transcript };
    },
  });

  // pi reads its model from its agent dir; the key goes into a file there, never argv or env.
  const agentDir = mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/genie-pi-`);
  const { baseUrl, api, id, keyFile } = c.model;
  writeFileSync(`${agentDir}/models.json`, JSON.stringify({ providers: { genie: { baseUrl, api, apiKey: secret(keyFile), models: [{ id }] } } }));
  const launch = tier1Launch({
    pi: c.pi,
    config: (t) => ({ ...c.tier1, root: `${c.mirror.worktreeRoot}/${t}` }),
    args: (t) => ["--model", `genie/${id}`, ...store.sessionArgs(t)],
  });

  const supervisor: Supervisor = new Supervisor(
    (t) => {
      const l = launch(t);
      return { ...l, env: { ...l.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" } };
    },
    (t, r) => lifecycle.event(t, r),
    (t) => ({
      // The tier is the thread's, from P2's state, never the request's (E4's effectiveTier clamps it).
      eval: async (request) => {
        const result = await evalIn(t, { request: request as EvalRequest, sender_tier: store.read(t)?.sender_tier ?? "public" });
        setContext(t, { eval_transcript: [...context(t).eval_transcript, { request, result }] });
        return result;
      },
      recall: async () => {
        throw new Error("recall is not available yet");
      },
      escalate: (pkg) => escalation.escalate(t, pkg as Package),
      // The draft leaves only as redacted and passed by guard-out. A withheld draft is neither posted
      // nor escalated: guard-out judged it unfit to leave the pod, and xmsg is a way out too.
      reply: async (raw) => {
        const d = raw as Draft;
        const out = await outbound(context(t).cleaned_question, (scrub): Draft => ({ ...d, answer: scrub(d.answer), gaps: d.gaps.map(scrub) }), guardOut);
        if (!("value" in out)) {
          console.error(`thread ${t}: reply withheld: ${out.reason}`);
          await io.post.post(t, WITHHELD);
          return { posted: false, reason: out.reason };
        }
        await io.post.post(t, out.value);
        return { posted: true, escalated: await escalation.reply(t, out.value) };
      },
      propose: (p) => broker(t, JSON.stringify(p), { tokenFile: c.broker.tokenFile, guard: guardOut, act }),
      clone: (url) => worktreeFor(c.mirror, url, t),
      screen,
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
  const guard = seedGuard(io.guard);
  const lifecycle: Lifecycle = new ArchivingLifecycle({
    supervisor,
    store,
    mirror: c.mirror,
    deeper: (t) => escalation.deeper(t),
    replayResume: (t) => replayResume({ supervisor, thread: t, s3: c.s3, guard, store, tier: store.tombstone(t)?.tier }),
  });
  const gc = new Gc({ store, mirror: c.mirror, archive });

  // C7 reads the raw envelope before guard-in; a reject is answered with a refusal and never
  // reaches pi. An expert reply is judged by guard-out (C8); a blocked reply is dropped from
  // context and transcript, posting WITHHELD and recorded with a tier label only for the archive (P4).
  const handle = async (i: Inbound): Promise<void> => {
    if ("envelope" in i) {
      observe(store, i.thread, parseEnvelope(i.envelope));
      let text: string;
      try {
        text = await guardIn(io.guard, i.envelope);
      } catch (e) {
        console.error(`thread ${i.thread}: ${e}`);
        return io.post.post(i.thread, REFUSAL);
      }
      setContext(i.thread, { cleaned_question: text });
      await lifecycle.message(i.thread, text);
    } else if ("expert" in i) {
      const q = context(i.thread).cleaned_question;
      const out = await outbound(q, (scrub) => scrub(i.expert), guardOut);
      if (!("value" in out)) {
        console.error(`thread ${i.thread}: expert reply withheld: ${out.reason}`);
        store.addBlockedExpertReply(i.thread, store.read(i.thread)?.sender_tier ?? "public");
        return io.post.post(i.thread, WITHHELD);
      }
      await io.post.post(i.thread, out.value);
      await lifecycle.message(i.thread, out.value);
    } else if (i.control === "trust") observe(store, i.thread, i);
    else await lifecycle.control(i.thread, i.control);
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
