// guard-out's live evaluation: every case of <corpus>/cases.jsonl goes
// through the guard-out prompt on ninfer at temperature 0 via reviewOut().
// - A pass case passes when the guard passes it.
// - A block case passes when the guard blocks it.
// - False negative: a block case that the guard passed (attributed to case.class).
// - False positive: a clean case that the guard blocked (attributed to verdict reason class).
// - Parser error: a reply that failed to parse, was cut off at max_tokens, or had no message content.
//
// Usage:
//   npm run guard-out-eval [-- --corpus <dir>] [-- --prompt <file>] [-- --api-key-file <file>]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { firstModel, reviewOut, Unavailable } from "../src/guard/service.ts";
import {
  classifyReason,
  PARSE_FAILURE,
  type ReasonClass,
  type VerdictOut,
} from "../src/guard/verdict-out.ts";

interface Case {
  id: string;
  set: "block" | "pass";
  class: "leak" | "secret_request" | "injection" | "clean" | "other";
  question: string;
  answer: string;
  note: string;
}

const root = new URL("..", import.meta.url);
const defaultKey = existsSync("/home/sini/.config/hyperqwen/api-key")
  ? "/home/sini/.config/hyperqwen/api-key"
  : undefined;

const { values: args } = parseArgs({
  options: {
    prompt: { type: "string", default: new URL("prompts/guard-out.md", root).pathname },
    corpus: { type: "string", default: "corpus/outbound" },
    out: { type: "string" },
    base: { type: "string", default: process.env.NINFER_URL ?? "http://10.9.2.2:18020/v1" },
    "api-key-file": { type: "string", default: process.env.GENIE_GUARD_API_KEY_FILE ?? defaultKey },
    concurrency: { type: "string", default: "3" },
  },
});

const die = (msg: string): never => {
  console.error(`COULD NOT MEASURE: ${msg}`);
  process.exit(2);
};

const casesFile = new URL(`${args.corpus}/cases.jsonl`, root);
if (!existsSync(casesFile)) die(`corpus file not found: ${casesFile.pathname}`);

const cases: Case[] = readFileSync(casesFile, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const system = readFileSync(args.prompt, "utf8");

const apiKey = args["api-key-file"] ? readFileSync(args["api-key-file"], "utf8").trim() : undefined;
if (args["api-key-file"] && !apiKey) die(`${args["api-key-file"]} is empty`);
const model = await firstModel(args.base, apiKey).catch((e) => die(e.message));

// The request, retry on length/empty, and parsing go through reviewOut() in src/guard/service.ts.
async function guard(id: string, c: Case): Promise<{ raw: string; verdict: VerdictOut }> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await reviewOut(
        { question: c.question, answer: c.answer },
        { base: args.base, model, system, apiKey, timeoutMs: 60_000 },
      );
    } catch (err: any) {
      if (!(err instanceof Unavailable)) throw err;
      if (err.message.includes("cut off at max_tokens") || err.message.includes("no message content")) {
        return {
          raw: "",
          verdict: { verdict: "block", reason: `${PARSE_FAILURE}: ${err.message}` },
        };
      }
      if (attempt >= 3 || !err.dropped) die(`${id}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

interface Result extends Case {
  raw: string;
  verdict: VerdictOut;
  reasonClass: ReasonClass;
  outcome: "pass" | "fn" | "fp" | "parser";
  isEmpty: boolean;
}

async function run(c: Case): Promise<Result> {
  const { raw, verdict } = await guard(c.id, c);
  const rClass = classifyReason(verdict.reason);
  const isParser = verdict.reason.startsWith(PARSE_FAILURE);
  const isEmpty = raw === "" || verdict.reason.includes("no message content") || verdict.reason.includes("cut off at max_tokens");
  let outcome: Result["outcome"];

  if (c.set === "block") {
    if (isParser) {
      outcome = "parser";
    } else if (verdict.verdict === "block") {
      outcome = "pass";
    } else {
      outcome = "fn";
    }
  } else {
    // c.set === "pass"
    if (isParser) {
      outcome = "parser";
    } else if (verdict.verdict === "pass") {
      outcome = "pass";
    } else {
      outcome = "fp";
    }
  }

  return { ...c, raw, verdict, reasonClass: rClass, outcome, isEmpty };
}

const results: Result[] = [];
const queue = [...cases];
await Promise.all(
  Array.from({ length: Math.max(1, Number(args.concurrency) || 1) }, async () => {
    for (let c; (c = queue.shift()); ) results.push(await run(c));
  }),
);

results.sort((a, b) => cases.indexOf(a) - cases.indexOf(b));
if (results.length !== cases.length) die(`${results.length} results for ${cases.length} cases`);

console.log(`model: ${model}`);
console.log(`prompt: ${args.prompt}`);
console.log(`corpus: ${args.corpus} (${cases.length} cases)`);
console.log("");

// Truncate and redact any secrets in raw text before printing to logs
function redact(str: string): string {
  const truncated = str.length > 60 ? str.slice(0, 60) + "..." : str;
  return truncated
    .replace(/whsec_[a-zA-Z0-9_-]+/g, "whsec_[REDACTED]")
    .replace(/ghp_[a-zA-Z0-9]+/g, "ghp_[REDACTED]")
    .replace(/github_pat_[a-zA-Z0-9_]+/g, "github_pat_[REDACTED]")
    .replace(/syt_[a-zA-Z0-9_]+/g, "syt_[REDACTED]")
    .replace(/AGE-SECRET-KEY-[a-zA-Z0-9]+/g, "AGE-SECRET-KEY-[REDACTED]");
}

// Breakdown table
const classes: ReasonClass[] = ["leak", "secret_request", "injection", "clean", "other"];
console.log("Class             Total  Expected   Passed  FN  FP  Parser  Empty");
console.log("-----------------------------------------------------------------");
for (const cls of classes) {
  const inClass = results.filter((r) => r.class === cls);
  if (inClass.length === 0 && !results.some((r) => r.reasonClass === cls && r.outcome === "fp")) continue;
  const passed = inClass.filter((r) => r.outcome === "pass").length;
  const fn = inClass.filter((r) => r.outcome === "fn").length;
  // FP attributed to this reasonClass
  const fp = results.filter((r) => r.set === "pass" && r.reasonClass === cls && r.outcome === "fp").length;
  const parser = inClass.filter((r) => r.outcome === "parser").length;
  const empty = inClass.filter((r) => r.isEmpty).length;
  const expected = inClass[0]?.set ?? (cls === "clean" ? "pass" : "block");
  const pad = (n: number) => String(n).padStart(4);
  console.log(
    `${cls.padEnd(17)} ${pad(inClass.length)}  ${expected.padEnd(8)}   ${pad(passed)} ${pad(fn)} ${pad(fp)}  ${pad(parser)}   ${pad(empty)}`,
  );
}
console.log("-----------------------------------------------------------------");

const totalFN = results.filter((r) => r.outcome === "fn").length;
const totalFP = results.filter((r) => r.outcome === "fp").length;
const totalParser = results.filter((r) => r.outcome === "parser").length;
const totalEmpty = results.filter((r) => r.isEmpty).length;
const totalPassed = results.filter((r) => r.outcome === "pass").length;

console.log(
  `Total: ${results.length} cases | Passed: ${totalPassed} | FN: ${totalFN} | FP: ${totalFP} | Parser-errors: ${totalParser} | Empty: ${totalEmpty}`,
);

for (const r of results.filter((r) => r.outcome === "parser")) {
  console.log(`PARSER ERROR: ${r.id} (${r.class}) reason: ${r.verdict.reason} | raw: ${JSON.stringify(redact(r.raw))}`);
}
for (const r of results.filter((r) => r.outcome === "fn")) {
  console.log(`FALSE NEGATIVE: ${r.id} (${r.class}) passed by guard! reason: ${r.verdict.reason}`);
}
for (const r of results.filter((r) => r.outcome === "fp")) {
  console.log(`FALSE POSITIVE: ${r.id} (${r.class}) blocked as ${r.reasonClass}! reason: ${r.verdict.reason}`);
}

if (args.out) {
  writeFileSync(args.out, JSON.stringify(results, null, 2));
}

// Exit 0 if no false negatives and all pass cases cleanly passed
const pass = (r: Result) => (r.set === "block" ? r.outcome !== "fn" : r.outcome === "pass");
process.exit(results.every(pass) ? 0 : 1);
