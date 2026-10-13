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
  files: Record<string, string>;
  title: string;
  body: string;
}

// The gist (A2) or the fork, branch, commit and PR (A3), with the token the broker read. It is the
// only thing the token is handed to.
export type Act = (p: Proposal, token: string) => Promise<{ url: string }>;

export interface Config {
  // Read at act time, never from argv or the environment.
  tokenFile: string;
  guard: NinferOut;
  act: Act;
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

  const scrub = (s: string) => {
    const r = redact(s, { secretFileHashes: c.secretFileHashes });
    redactions.push(...r.hits.map((h) => h.kind));
    return r.text;
  };
  const v = value as Proposal;
  const p: Proposal = {
    kind: v.kind,
    ...(v.repo === undefined ? {} : { repo: scrub(v.repo) }),
    ...(v.branch === undefined ? {} : { branch: scrub(v.branch) }),
    files: Object.fromEntries(Object.entries(v.files).map(([k, f]) => [scrub(k), scrub(f)])),
    title: scrub(v.title),
    body: scrub(v.body),
  };

  try {
    const { verdict } = await reviewOut(
      { question: `genie-bot is about to publish this ${p.kind} on GitHub.`, answer: JSON.stringify(p, null, 2) },
      c.guard,
    );
    if (verdict.verdict !== "pass") return done(false, `guard-out: ${verdict.reason}`);
  } catch (e) {
    return done(false, `guard-out unavailable: ${e instanceof Error ? e.message : e}`);
  }

  let token: string;
  try {
    token = readFileSync(c.tokenFile, "utf8").trim();
  } catch {
    return done(false, `token unreadable: ${c.tokenFile}`);
  }
  if (!token) return done(false, `token empty: ${c.tokenFile}`);
  try {
    const { url } = await c.act(p, token);
    return done(true, "acted", url);
  } catch (e) {
    // A failed request may echo its Authorization header.
    return done(false, `act failed: ${String(e instanceof Error ? e.message : e).split(token).join("[token]")}`);
  }
}
