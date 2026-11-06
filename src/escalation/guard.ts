// The escalation guard (plan S5, design §4 step 6, oracle 18, GE2 F-B): screens untrusted tool
// output entering the expert escalation package before it leaves the pod:
// - `eval_transcript[i].result.stdout_tail` and `stderr_tail` (non-empty strings) under
//   `source: "eval_stdout"`, and
// - `git_transcript[i].output` and `gh_transcript[i].output` (non-empty strings, only when
//   `entry.screened !== true`) under `source: "web"` (orchestrator decision of 2026-11-06).
// `cleaned_question` (already guard-in'd on intake), `draft` and `gaps` (already scrubbed and
// guard-out'd), `recall_transcript` (trusted Hindsight bank content, owner ruling of 2026-11-06),
// `eval_transcript[i].request`, and `screened: true` `git_transcript`/`gh_transcript` entries are
// not re-screened. Checks run sequentially (`for ... of`) and fail fast on the first refusal.
import type { Envelope, Verdict } from "../guard/verdict.ts";
import { verdictErrors } from "../guard/verdict.ts";
import type { GuardClient, Unavailable } from "../supervisor/guard-client.ts";
import type { GhTranscriptEntry, GitTranscriptEntry, Package } from "./index.ts";

export function escalationGuard(
  client: GuardClient | undefined,
  opts: { enabled?: boolean } = {},
): (pkg: Package) => Promise<Package> {
  const enabled = opts.enabled ?? true;
  const refused = (why: string) => new Error(`escalation refused by the guard: ${why}`);
  const screen = async (text: string, source: Envelope["source"]): Promise<string> => {
    if (!enabled) return text;
    if (!client) throw refused("unavailable (guard client not configured)");
    let v: Verdict | Unavailable;
    try {
      v = await client.check({ source, history: [], content: { text } });
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

  return async (pkg) => {
    const evalTranscript: unknown[] = [];
    for (const entry of pkg.eval_transcript) {
      if (typeof entry !== "object" || entry === null) {
        evalTranscript.push(entry);
        continue;
      }
      const rec = entry as { request?: unknown; result?: unknown };
      if (typeof rec.result !== "object" || rec.result === null) {
        evalTranscript.push(entry);
        continue;
      }
      const res = { ...(rec.result as Record<string, unknown>) };
      if (typeof res.stdout_tail === "string" && res.stdout_tail !== "") {
        res.stdout_tail = await screen(res.stdout_tail, "eval_stdout");
      }
      if (typeof res.stderr_tail === "string" && res.stderr_tail !== "") {
        res.stderr_tail = await screen(res.stderr_tail, "eval_stdout");
      }
      evalTranscript.push({ ...rec, result: res });
    }

    let gitTranscript: GitTranscriptEntry[] | undefined;
    if (pkg.git_transcript !== undefined) {
      gitTranscript = [];
      for (const entry of pkg.git_transcript) {
        if (entry.screened !== true && typeof entry.output === "string" && entry.output !== "") {
          const output = await screen(entry.output, "web");
          gitTranscript.push({ ...entry, output, screened: true });
        } else {
          gitTranscript.push(entry);
        }
      }
    }

    let ghTranscript: GhTranscriptEntry[] | undefined;
    if (pkg.gh_transcript !== undefined) {
      ghTranscript = [];
      for (const entry of pkg.gh_transcript) {
        if (entry.screened !== true && typeof entry.output === "string" && entry.output !== "") {
          const output = await screen(entry.output, "web");
          ghTranscript.push({ ...entry, output, screened: true });
        } else {
          ghTranscript.push(entry);
        }
      }
    }

    return {
      ...pkg,
      eval_transcript: evalTranscript,
      ...(gitTranscript !== undefined ? { git_transcript: gitTranscript } : {}),
      ...(ghTranscript !== undefined ? { gh_transcript: ghTranscript } : {}),
    };
  };
}
