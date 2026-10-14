// Tier 1 prompt evaluation CLI (Unit C2.1): discriminating prompt eval across prompt arms,
// noise band measurement over repeated runs, correctness / citation / calibration scoring,
// calibration curve for C5 threshold selection, and concurrency cap.
//
// Usage:
//   flock ~/.local/state/genie-model.lock node tests/tier1-eval.ts [--all-arms] [--runs 3] [--concurrency 1] [--out <file>]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { firstModel } from "../src/guard/service.ts";
import {
  formatReportTables,
  type PromptArm,
  type QuestionFixture,
  runTier1PromptEval,
} from "../src/tier1/eval.ts";

const root = new URL("..", import.meta.url);
const defaultKey = "/home/sini/.config/hyperqwen/api-key";

const { values: args } = parseArgs({
  options: {
    prompt: { type: "string", default: new URL("prompts/tier1.md", root).pathname },
    "all-arms": { type: "boolean", default: false },
    arms: { type: "string" },
    runs: { type: "string", default: "1" },
    concurrency: { type: "string", default: "1" },
    out: { type: "string" },
    base: { type: "string", default: process.env.NINFER_URL ?? "http://10.9.2.2:18020/v1" },
    "api-key-file": { type: "string", default: existsSync(defaultKey) ? defaultKey : undefined },
    questions: {
      type: "string",
      default: new URL("tests/fixtures/tier1-eval/questions.jsonl", root).pathname,
    },
    turns: { type: "string", default: "6" },
    "max-tokens": { type: "string", default: "16384" },
  },
});

const die = (msg: string): never => {
  console.error(`COULD NOT MEASURE: ${msg}`);
  process.exit(2);
};

process.on("uncaughtException", (e) => die(String(e)));

const apiKey = args["api-key-file"] ? readFileSync(args["api-key-file"], "utf8").trim() : undefined;
if (args["api-key-file"] && !apiKey) die(`${args["api-key-file"]} is empty`);

const model = await firstModel(args.base, apiKey).catch((e) => die(e.message));

const questions: QuestionFixture[] = readFileSync(args.questions, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const promptArms: Record<PromptArm, string> = {
  real: new URL("prompts/tier1.md", root).pathname,
  "no-steps": new URL("prompts/tier1-no-steps.md", root).pathname,
  "no-citations": new URL("prompts/tier1-no-citations.md", root).pathname,
};

// Select arms to run
const selectedArms: Record<PromptArm, string> = {} as any;
if (args["all-arms"] || args.arms) {
  const armList = args.arms ? (args.arms.split(",") as PromptArm[]) : (["real", "no-steps", "no-citations"] as PromptArm[]);
  for (const arm of armList) {
    if (promptArms[arm]) selectedArms[arm] = promptArms[arm];
  }
} else {
  // Default single prompt arm if specified by --prompt
  selectedArms.real = args.prompt;
}

const runs = Number.parseInt(args.runs, 10);
const concurrency = Number.parseInt(args.concurrency, 10);
const turns = Number.parseInt(args.turns, 10);
const maxTokens = Number.parseInt(args["max-tokens"], 10);

const report = await runTier1PromptEval({
  model,
  base: args.base,
  apiKey,
  promptArms: selectedArms,
  questions,
  runs,
  concurrency,
  turns,
  maxTokens,
});

console.log(formatReportTables(report));

if (args.out) {
  writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
}

// Exit code logic:
// If multiple arms are run: pass if comparisons are discriminating and no errors.
// If single arm: pass if all parsed questions have draft.
if (report.comparisons.length > 0) {
  const allDiscriminating = report.comparisons.every((c) => c.is_discriminating);
  process.exit(allDiscriminating ? 0 : 1);
} else {
  const realArm = report.arms.real;
  const allOk = realArm && realArm.runs.every((r) => r.questions.every((q) => q.draft));
  process.exit(allOk ? 0 : 1);
}
