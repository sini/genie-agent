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
  formatMemoryReportTables,
  formatReportTables,
  type MemoryRecallFixture,
  type PromptArm,
  type QuestionFixture,
  runTier1MemoryEval,
  runTier1PromptEval,
  verifyModelFreeRetrieval,
} from "../src/tier1/eval.ts";

const root = new URL("..", import.meta.url);
const defaultKey = "/home/sini/.config/hyperqwen/api-key";

const { values: args } = parseArgs({
  options: {
    prompt: { type: "string", default: new URL("prompts/tier1.md", root).pathname },
    "all-arms": { type: "boolean", default: false },
    "memory-arms": { type: "boolean", default: false },
    "recall-fixture": { type: "string" },
    "memory-dir": {
      type: "string",
      default: new URL("operating-memory", root).pathname,
    },
    arms: { type: "string" },
    runs: { type: "string", default: "1" },
    concurrency: { type: "string", default: "1" },
    out: { type: "string" },
    base: { type: "string", default: process.env.NINFER_URL ?? "http://10.9.2.2:18020/v1" },
    "api-key-file": { type: "string", default: existsSync(defaultKey) ? defaultKey : undefined },
    questions: {
      type: "string",
      multiple: true,
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

const defaultQuestions = args["memory-arms"]
  ? [new URL("tests/fixtures/memory-eval/questions.jsonl", root).pathname]
  : [new URL("tests/fixtures/tier1-eval/questions.jsonl", root).pathname];

const questionFiles = args.questions && args.questions.length > 0 ? args.questions : defaultQuestions;

const questions: QuestionFixture[] = questionFiles.flatMap((file) =>
  readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l)),
);

const runs = Number.parseInt(args.runs, 10);
const concurrency = Number.parseInt(args.concurrency, 10);
const turns = Number.parseInt(args.turns, 10);
const maxTokens = Number.parseInt(args["max-tokens"], 10);

// Memory arms mode (Unit C2.2 live runner)
if (args["memory-arms"]) {
  const memoryDir = args["memory-dir"] ?? new URL("operating-memory", root).pathname;
  const memoryMdPath = `${memoryDir}/MEMORY.md`;
  const recallFixtureFile =
    args["recall-fixture"] ??
    new URL("tests/fixtures/memory-eval/recall-fixtures.json", root).pathname;

  let recallFixtures: MemoryRecallFixture;
  try {
    recallFixtures = JSON.parse(readFileSync(recallFixtureFile, "utf8"));
  } catch (e) {
    die(`could not read recall fixture ${recallFixtureFile}: ${(e as Error).message}`);
  }

  // Pre-run model-free retrieval check (Amendment 6 & 7):
  // Verifies links from MEMORY.md and fixture mappings, and refuses stand-in fixture on live run.
  try {
    verifyModelFreeRetrieval(questions, memoryMdPath, recallFixtures, { live: true });
  } catch (e) {
    die((e as Error).message);
  }

  const apiKey = args["api-key-file"] ? readFileSync(args["api-key-file"], "utf8").trim() : undefined;
  if (args["api-key-file"] && !apiKey) die(`${args["api-key-file"]} is empty`);

  const model = await firstModel(args.base, apiKey).catch((e) => die(e.message));

  const report = await runTier1MemoryEval({
    model,
    base: args.base,
    apiKey,
    memoryRoot: memoryDir,
    memoryMdPath,
    recallFixtures,
    questions,
    arms: ["no-memory", "wiki", "bank", "wiki+bank"],
    runs,
    concurrency,
    turns,
    maxTokens,
    live: true,
  });

  console.log(formatMemoryReportTables(report));

  if (args.out) {
    writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
  }

  const allDiscriminating = report.comparisons.every((c) => c.is_discriminating);
  process.exit(allDiscriminating ? 0 : 1);
}

// Prompt arms mode (Unit C2.1)
const apiKey = args["api-key-file"] ? readFileSync(args["api-key-file"], "utf8").trim() : undefined;
if (args["api-key-file"] && !apiKey) die(`${args["api-key-file"]} is empty`);

const model = await firstModel(args.base, apiKey).catch((e) => die(e.message));

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
