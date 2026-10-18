// The escalation guard (plan S5, design §4 step 6, oracle 18): the package passes guard-in before
// it leaves the pod, because tier 1 wrote it after reading eval stdout, and the whole package
// comes from tier 1 on its `escalate` call, cleaned_question included. Every non-empty string in
// it is one envelope, so a rewrite replaces exactly that string and the package keeps its shape.
//
// Each check is a fresh session: an independent request with `history: []`, so no thread text and
// no other field of the package rides along. The source is `eval_stdout`, guard-in's evidence
// class: text that addresses a model, or carries instructions for the expert, is an injection.
// A reject, unavailable, a throw, or a reply that is not a verdict refuses the whole package.
import type { Verdict } from "../guard/verdict.ts";
import { verdictErrors } from "../guard/verdict.ts";
import type { GuardClient, Unavailable } from "../supervisor/guard-client.ts";
import type { Package } from "./index.ts";

export function escalationGuard(
  client: GuardClient | undefined,
  opts: { enabled?: boolean } = {},
): (pkg: Package) => Promise<Package> {
  const enabled = opts.enabled ?? true;
  const refused = (why: string) => new Error(`escalation refused by the guard: ${why}`);
  const screen = async (text: string): Promise<string> => {
    if (!enabled) return text;
    if (!client) throw refused("unavailable (guard client not configured)");
    let v: Verdict | Unavailable;
    try {
      v = await client.check({ source: "eval_stdout", history: [], content: { text } });
    } catch (e) {
      v = { unavailable: e instanceof Error ? e.message : String(e) };
    }
    if (typeof (v as Unavailable)?.unavailable === "string") throw refused(`unavailable (${(v as Unavailable).unavailable})`);
    if (verdictErrors(v).length) throw refused("the reply is not a verdict");
    const verdict = v as Verdict;
    if (verdict.verdict === "allow") return text;
    if (verdict.verdict === "rewrite") return verdict.cleaned_text;
    throw refused(verdict.reason);
  };
  const walk = async (x: unknown): Promise<unknown> => {
    if (typeof x === "string") return x === "" ? x : screen(x);
    if (Array.isArray(x)) return Promise.all(x.map(walk));
    if (typeof x === "object" && x !== null)
      return Object.fromEntries(await Promise.all(Object.entries(x).map(async ([k, v]) => [k, await walk(v)])));
    return x;
  };
  return async (pkg) => (await walk(pkg)) as Package;
}
