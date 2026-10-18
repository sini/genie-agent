// guard-in as the supervisor's side calls it (plan C3.2, "GA builds to these interfaces"): one
// Envelope in, its Verdict out, or `unavailable` when the guard errs or does not answer in time.
// Every consumer fails closed on `unavailable`. GA's adapter carries it to genie-guard over
// xmsg; tier 1 holds no GuardClient and reaches the guard only through Host.screen.
import type { Envelope, Verdict } from "../guard/verdict.ts";
import { verdictErrors } from "../guard/verdict.ts";

export type Unavailable = { unavailable: string };

export interface GuardClient {
  check(e: Envelope): Promise<Verdict | Unavailable>;
}

export const DEFAULT_SCREEN_MAX_BYTES = 32 * 1024;

// Host.screen over guard: a web result as the model may see it, the fetched text on allow and
// the guard's cleaned_text on rewrite. A reject, unavailable, a throw, or a reply that is not a
// verdict withholds it. When `enabled` is false (G11), passes text through unscreened without
// calling the guard.
export function webScreen(
  guard: GuardClient | undefined,
  opts: { enabled?: boolean } = {},
): (text: string) => Promise<string> {
  const enabled = opts.enabled ?? true;
  return async (text) => {
    const withheld = (why: string) => new Error(`web content withheld: ${why}`);
    if (typeof text !== "string") throw withheld("it is not text");
    if (!enabled) return text;
    if (!guard) throw withheld("the guard is unavailable (guard client not configured)");
    let v: Verdict | Unavailable;
    try {
      v = await guard.check({ source: "web", history: [], content: { text } });
    } catch (e) {
      v = { unavailable: e instanceof Error ? e.message : String(e) };
    }
    if (typeof (v as Unavailable)?.unavailable === "string") throw withheld(`the guard is unavailable (${(v as Unavailable).unavailable})`);
    if (verdictErrors(v).length) throw withheld("the guard's reply is not a verdict");
    const verdict = v as Verdict;
    if (verdict.verdict === "allow") return text;
    if (verdict.verdict === "rewrite") return verdict.cleaned_text;
    throw withheld(verdict.reason ? `the guard rejected it (${verdict.reason})` : "the guard rejected it");
  };
}
