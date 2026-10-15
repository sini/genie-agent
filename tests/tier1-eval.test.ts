// Hermetic test for tier-1 discriminating prompt evaluation (Unit C2.1, C2.1.1 & C2.3, Oracles).
// Runs hermetically through real pi (tier1Launch + Supervisor) against a loopback SSE stub server.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { type Record as PiRecord, Supervisor } from "../src/supervisor/index.ts";
import {
   compareArms,
  computeExploratoryPredictors,
  computePairedBootstrapCI,
  formatReportTables,
  type ArmResult,
  type QuestionFixture,
  type ScoredQuestion,
  runArm,
  runTier1PromptEval,
} from "../src/tier1/eval.ts";
import { TOOLS } from "../src/tier1/index.ts";
import { tier1Launch, writePiModelsJson } from "../src/tier1/launch.ts";

const root = new URL("..", import.meta.url);
const questions: QuestionFixture[] = readFileSync(
  new URL("tests/fixtures/tier1-eval/questions.jsonl", root),
  "utf8",
)
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part: any) => (typeof part === "string" ? part : (part?.text ?? ""))).join("");
  }
  return "";
}

export function sseToolCalls(calls: { id: string; name: string; args: unknown }[]): string {
  const chunks = calls.map((c, index) =>
    `data: ${JSON.stringify({
      id: "x",
      object: "chat.completion.chunk",
      created: 0,
      model: "stub-qwen",
      choices: [
        {
          index: 0,
          delta: {
            ...(index === 0 ? { role: "assistant" } : {}),
            tool_calls: [
              {
                index,
                id: c.id,
                type: "function",
                function: {
                  name: c.name,
                  arguments: typeof c.args === "string" ? c.args : JSON.stringify(c.args),
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })}\n\n`,
  );
  chunks.push(
    `data: ${JSON.stringify({
      id: "x",
      object: "chat.completion.chunk",
      created: 0,
      model: "stub-qwen",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    })}\n\ndata: [DONE]\n\n`,
  );
  return chunks.join("");
}

export function sseTextStop(text: string): string {
  return [
    `data: ${JSON.stringify({
      id: "x",
      object: "chat.completion.chunk",
      created: 0,
      model: "stub-qwen",
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    })}`,
    `data: ${JSON.stringify({
      id: "x",
      object: "chat.completion.chunk",
      created: 0,
      model: "stub-qwen",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}`,
    "data: [DONE]",
    "",
  ].join("\n\n");
}

let server: Server;
let port = 0;
let inFlight = 0;
let maxInFlight = 0;
let callCount = 0;

before(async () => {
  server = createServer((req, res) => {
    inFlight++;
    if (inFlight > maxInFlight) maxInFlight = inFlight;

    if (req.method === "GET" && req.url === "/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "stub-qwen" }] }));
      inFlight--;
      return;
    }

    if (req.method === "POST" && req.url === "/chat/completions") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        callCount++;
        const parsed = JSON.parse(body);
        const messages = parsed.messages ?? [];
        const systemMsg = textOf(messages.find((m: any) => m.role === "system" || m.role === "developer")?.content);
        const userMsg = textOf(messages.find((m: any) => m.role === "user")?.content);

        // Identify which prompt arm is in flight
        const hasHowToAnswer = systemMsg.includes("## How to answer");
        const hasCitationRule = /cite what\s+you checked/i.test(systemMsg);

        // Find corresponding question fixture
        const q = questions.find((item) => item.question === userMsg) ?? questions[0];
        const claims = q.expected_claims ?? [];
        const citations = q.expected_citations ?? [];

        let answer = "";
        let confidence = 0.9;
        const gaps: string[] = [];

        if (hasHowToAnswer && hasCitationRule) {
          // Real arm: full correctness, citations present, high confidence
          // Slight jitter across runs to produce a non-zero measured generation noise band
          const runIndex = Math.floor((callCount - 1) / questions.length);
          const jitter = (runIndex % 3) * 0.03;
          confidence = Number((0.92 - jitter).toFixed(2));
          answer = `Checked ${citations.join(" and ")}: confirmed that ${claims.join(" and ")} holds true.\n\`\`\`nix\n{ test = true; }\n\`\`\``;
        } else if (hasHowToAnswer && !hasCitationRule) {
          // Degraded arm (no-citations): claims present, citations completely omitted
          confidence = 0.85;
          answer = `The solution requires ${claims.join(" and ")}.`;
        } else {
          // Degraded arm (no-steps): vague/generic, misses claims and citations
          confidence = 0.65;
          answer = `You can configure this by checking your system configuration file.`;
          gaps.push("did not verify details");
        }

        const sse = sseToolCalls([
          {
            id: "call_1",
            name: "reply",
            args: {
              answer,
              confidence,
              gaps,
              escalate_forced: q.id === "asks-for-expert" ? "yes" : "no",
            },
          },
        ]);

        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(sse);
        inFlight--;
      });
      return;
    }

    res.writeHead(404);
    res.end();
    inFlight--;
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as { port: number }).port;
      resolve();
    });
  });
});

after(() => server.close());

function makeSyntheticArm(
  arm: "real" | "no-steps" | "no-citations",
  questionScores: { id: string; overall: number; draft?: boolean }[],
): ArmResult {
  const scored: ScoredQuestion[] = questionScores.map((q) => ({
    id: q.id,
    question: `question-${q.id}`,
    calls: ["reply"],
    finish: "stop",
    draft:
      q.draft === false
        ? undefined
        : {
            answer: "synthetic answer",
            confidence: 0.9,
            gaps: [],
            escalate_forced: false,
          },
    correctness: q.overall,
    citation: q.overall,
    calibration: q.overall,
    overall: q.overall,
    last: { role: "assistant", content: "synthetic" },
  }));
  const answered = scored.filter((q) => q.draft);
  const mean = answered.length > 0 ? answered.reduce((s, q) => s + q.overall, 0) / scored.length : 0;
  return {
    arm,
    runs: [
      {
        run_index: 1,
        mean_score: Number(mean.toFixed(4)),
        mean_correctness: Number(mean.toFixed(4)),
        mean_citation: Number(mean.toFixed(4)),
        mean_calibration: Number(mean.toFixed(4)),
        questions: scored,
      },
    ],
    mean_score: Number(mean.toFixed(4)),
    mean_correctness: Number(mean.toFixed(4)),
    mean_citation: Number(mean.toFixed(4)),
    mean_calibration: Number(mean.toFixed(4)),
  };
}

test("oracle: a degraded arm scores below real by more than paired bootstrap noise band", async () => {
  maxInFlight = 0;
  const beforeCalls = callCount;
  const promptArms = {
    real: new URL("prompts/tier1.md", root).pathname,
    "no-steps": new URL("prompts/tier1-no-steps.md", root).pathname,
    "no-citations": new URL("prompts/tier1-no-citations.md", root).pathname,
  };

  const report = await runTier1PromptEval({
    model: "stub-qwen",
    base: `http://127.0.0.1:${port}`,
    promptArms,
    questions,
    runs: 3,
    concurrency: 1,
  });

  // Amendment 3: every model request in the 3 arms x 3 runs x 24 questions went to the loopback stub
  assert.strictEqual(
    callCount - beforeCalls,
    questions.length * 3 * 3,
    "every model request must be served by the loopback stub",
  );

  // Verify concurrency cap at 1: inFlight never exceeded 1
  assert.strictEqual(maxInFlight, 1, `max concurrency must be 1 (got ${maxInFlight})`);

  // Generation noise band is recorded across repeated runs (diagnostic for T>0)
  assert(
    report.generation_noise_band !== undefined && report.generation_noise_band > 0,
    `generation_noise_band must be strictly positive across jittered runs (got ${report.generation_noise_band})`,
  );
  assert(
    report.arms.real.generation_noise_band !== undefined && report.arms.real.generation_noise_band > 0,
    "real arm must record positive generation_noise_band across repeated runs",
  );

  // Both degraded arms must be discriminating under paired bootstrap CI
  assert.strictEqual(report.comparisons.length, 2);
  for (const comp of report.comparisons) {
    assert(
      comp.ci_low > 0,
      `Degraded arm ${comp.degraded_arm} lower CI bound (${comp.ci_low}) must be strictly positive`,
    );
    assert.strictEqual(
      comp.status,
      "discriminating",
      `Comparison for ${comp.degraded_arm} must be discriminating`,
    );
    assert.strictEqual(comp.is_discriminating, true);
    assert.strictEqual(comp.n_paired, questions.length);
    assert.strictEqual(comp.n_missing, 0);
  }

  // Calibration curve must cover bins and compute error
  assert.strictEqual(report.calibration_curve.length, 5);
  const totalCount = report.calibration_curve.reduce((s, b) => s + b.count, 0);
  assert.strictEqual(totalCount, questions.length * 3);

  // Threshold analysis must include C5 threshold 0.8
  const c5Entry = report.threshold_analysis.find((t) => t.threshold === 0.8);
  assert(c5Entry !== undefined, "threshold_analysis must include 0.8 for C5");
  assert(c5Entry.accepted_accuracy > 0.8, "accepted accuracy at 0.8 must be high");

  // Exploratory predictors computed on distinct answered questions
  assert(report.exploratory_predictors !== undefined);
  assert.strictEqual(report.exploratory_predictors.distinct_answered_count, questions.length);
  assert.strictEqual(report.exploratory_predictors.label, `exploratory, N=${questions.length}, no threshold`);

  // Output formatting table helper
  const formatted = formatReportTables(report);
  assert(formatted.includes("=== Tier-1 Prompt Eval Summary ==="));
  assert(formatted.includes("--- Comparisons Against Baseline (real) ---"));
  assert(formatted.includes("Bootstrap 95% CI"));
  assert(formatted.includes("n_paired"));
  assert(formatted.includes("--- Calibration Curve (real arm) ---"));
  assert(formatted.includes("--- Escalation Threshold Analysis for C5 (real arm) ---"));
  assert(formatted.includes("--- Exploratory Correctness Predictors (exploratory, N=24, no threshold) ---"));
});

test("oracle: compareArms reports inside_noise_band when paired bootstrap CI crosses zero", () => {
  const baseline = makeSyntheticArm("real", [
    { id: "q1", overall: 0.8 },
    { id: "q2", overall: 0.2 },
    { id: "q3", overall: 0.9 },
    { id: "q4", overall: 0.1 },
    { id: "q5", overall: 0.7 },
    { id: "q6", overall: 0.3 },
    { id: "q7", overall: 0.8 },
    { id: "q8", overall: 0.4 },
  ]);

  const degraded = makeSyntheticArm("no-steps", [
    { id: "q1", overall: 0.4 },
    { id: "q2", overall: 0.5 },
    { id: "q3", overall: 0.5 },
    { id: "q4", overall: 0.6 },
    { id: "q5", overall: 0.3 },
    { id: "q6", overall: 0.6 },
    { id: "q7", overall: 0.5 },
    { id: "q8", overall: 0.7 },
  ]);

  const comp = compareArms(baseline, degraded, { seed: 42 });

  assert(comp.delta > 0, "sample delta must be positive");
  assert(comp.ci_low < 0, `ci_low must be negative to cross zero (got ${comp.ci_low})`);
  assert(comp.ci_high > 0, `ci_high must be positive (got ${comp.ci_high})`);
  assert.strictEqual(comp.status, "inside_noise_band");
  assert.strictEqual(comp.is_discriminating, false);
  assert.strictEqual(comp.n_paired, 8);
  assert.strictEqual(comp.n_missing, 0);
});

test("oracle: pairing by question id is invariant to question array reordering", () => {
  const baseline = makeSyntheticArm("real", [
    { id: "q1", overall: 0.9 },
    { id: "q2", overall: 0.3 },
    { id: "q3", overall: 0.8 },
    { id: "q4", overall: 0.4 },
  ]);

  const degradedOriginal = makeSyntheticArm("no-steps", [
    { id: "q1", overall: 0.5 },
    { id: "q2", overall: 0.2 },
    { id: "q3", overall: 0.4 },
    { id: "q4", overall: 0.3 },
  ]);

  const degradedReordered = makeSyntheticArm("no-steps", [
    { id: "q4", overall: 0.3 },
    { id: "q1", overall: 0.5 },
    { id: "q3", overall: 0.4 },
    { id: "q2", overall: 0.2 },
  ]);

  const compOriginal = compareArms(baseline, degradedOriginal, { seed: 42 });
  const compReordered = compareArms(baseline, degradedReordered, { seed: 42 });

  assert.strictEqual(compOriginal.ci_low, compReordered.ci_low);
  assert.strictEqual(compOriginal.ci_high, compReordered.ci_high);
  assert.strictEqual(compOriginal.delta, compReordered.delta);
  assert.strictEqual(compOriginal.n_paired, compReordered.n_paired);
  assert.strictEqual(compOriginal.n_missing, compReordered.n_missing);
  assert.strictEqual(compOriginal.status, compReordered.status);
});

test("oracle: missing or unanswered questions count as score 0 and are tracked in n_missing", () => {
  const baseline = makeSyntheticArm("real", [
    { id: "q1", overall: 0.8 },
    { id: "q2", overall: 0.7 },
    { id: "q3", overall: 0.9 },
    { id: "q4", overall: 0.6 },
  ]);

  // Degraded arm has q3 unanswered (draft: false) and q4 completely omitted
  const degraded = makeSyntheticArm("no-steps", [
    { id: "q1", overall: 0.4 },
    { id: "q2", overall: 0.3 },
    { id: "q3", overall: 0.5, draft: false },
  ]);

  const comp = compareArms(baseline, degraded, { seed: 42 });

  assert.strictEqual(comp.n_paired, 2, "q1 and q2 are answered in both arms");
  assert.strictEqual(comp.n_missing, 2, "q3 is unanswered and q4 is missing");
  assert.strictEqual(comp.n_paired + comp.n_missing, 4);
});

test("oracle: seeded bootstrap is hermetically deterministic", () => {
  const deltas = [0.1, -0.05, 0.2, 0.15, -0.1, 0.05, 0.3, -0.2];
  const r1 = computePairedBootstrapCI(deltas, { seed: 12345 });
  const r2 = computePairedBootstrapCI(deltas, { seed: 12345 });

  assert.strictEqual(r1.ci_low, r2.ci_low);
  assert.strictEqual(r1.ci_high, r2.ci_high);
  assert.strictEqual(r1.sample_mean, r2.sample_mean);
});

test("oracle: exploratory correctness predictors calculate AUROC and lift on distinct answered questions", () => {
  const questions: ScoredQuestion[] = [
    {
      id: "q1",
      question: "q1",
      calls: ["recall", "clone", "eval", "web_fetch", "web_search", "reply"],
      finish: "stop",
      draft: { answer: "```nix\ncode\n```", confidence: 0.9, gaps: [], escalate_forced: false },
      correctness: 1.0,
      citation: 1.0,
      calibration: 0.9,
      overall: 0.95,
      last: {},
    },
    {
      id: "q2",
      question: "q2",
      calls: ["reply"],
      finish: "stop",
      draft: { answer: "plain answer", confidence: 0.7, gaps: [], escalate_forced: false },
      correctness: 0.3,
      citation: 0.0,
      calibration: 0.6,
      overall: 0.3,
      last: {},
    },
    // Duplicate of q1 (simulating run 2 of identical question)
    {
      id: "q1",
      question: "q1",
      calls: ["recall", "clone", "eval", "web_fetch", "web_search", "reply"],
      finish: "stop",
      draft: { answer: "```nix\ncode\n```", confidence: 0.9, gaps: [], escalate_forced: false },
      correctness: 1.0,
      citation: 1.0,
      calibration: 0.9,
      overall: 0.95,
      last: {},
    },
  ];

  const report = computeExploratoryPredictors(questions);
  assert.strictEqual(report.distinct_answered_count, 2, "must deduplicate distinct questions to N=2");
  assert.strictEqual(report.label, "exploratory, N=2, no threshold");

  const codePredictor = report.predictors.find((p) => p.predictor === "Code Block Presence");
  assert(codePredictor !== undefined);
  assert.strictEqual(codePredictor.met_count, 1);
  assert.strictEqual(codePredictor.unmet_count, 1);
  assert(codePredictor.lift > 0, "code presence must produce positive lift");
  assert.strictEqual(codePredictor.auroc, 1.0, "perfect separation must yield AUROC 1.0");
});

test("oracle C2.2.2 (Item 1 & 3): runArm offers all 12 production TOOLS and executes built-in read/grep/find/ls with confinement", async () => {
  const tmp = realpathSync(mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/genie-c21-builtin-`));
  mkdirSync(`${tmp}/sub`, { recursive: true });
  writeFileSync(`${tmp}/sub/mod.nix`, "{ services.foo.enable = true; }\n");

  let offeredTools: string[] = [];
  const toolOutputs: Record<string, string> = {};
  let stubRequests = 0;

  const builtinServer = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      stubRequests++;
      const parsed = JSON.parse(body);
      offeredTools = (parsed.tools ?? []).map((t: any) => t.function.name);
      const msgs = parsed.messages ?? [];
      const toolMsgs = msgs.filter((m: any) => m.role === "tool");
      res.writeHead(200, { "content-type": "text/event-stream" });

      if (toolMsgs.length === 0) {
        res.end(
          sseToolCalls([
            { id: "c_ls", name: "ls", args: { path: "." } },
            { id: "c_find", name: "find", args: { pattern: "*.nix" } },
            { id: "c_grep", name: "grep", args: { pattern: "services.foo" } },
            { id: "c_read", name: "read", args: { path: "sub/mod.nix" } },
            { id: "c_esc", name: "read", args: { path: "/etc/passwd" } },
          ]),
        );
        return;
      }

      for (const m of toolMsgs) {
        toolOutputs[m.tool_call_id] = textOf(m.content);
      }
      res.end(
        sseToolCalls([
          {
            id: "c_reply",
            name: "reply",
            args: {
              answer: `From sub/mod.nix: ${toolOutputs.c_read ?? ""}`,
              confidence: 0.9,
              gaps: [],
              escalate_forced: "no",
            },
          },
        ]),
      );
    });
  });

  const builtinPort = await new Promise<number>((resolve) =>
    builtinServer.listen(0, "127.0.0.1", () => resolve((builtinServer.address() as { port: number }).port)),
  );

  try {
    const armRes = await runArm(
      "real",
      new URL("prompts/tier1.md", root).pathname,
      {
        model: "stub-qwen",
        base: `http://127.0.0.1:${builtinPort}`,
        promptArms: { real: "", "no-steps": "", "no-citations": "" },
        worktreeRoot: tmp,
        questions: [
          {
            id: "q-builtin",
            question: "How is services.foo.enable configured?",
            expected_claims: ["services.foo.enable"],
            expected_citations: ["sub/mod.nix"],
          },
        ],
      },
    );

    assert.equal(stubRequests, 2, "both turns must be served by the loopback stub");
    assert.deepEqual(offeredTools, [...TOOLS]);
    assert.equal(toolOutputs.c_ls.trim(), "sub/");
    assert.equal(toolOutputs.c_find.trim(), "sub/mod.nix");
    assert.match(toolOutputs.c_grep, /sub\/mod\.nix:1:.*\{ services\.foo\.enable = true; \}/);
    assert.equal(toolOutputs.c_read, "{ services.foo.enable = true; }\n");
    assert.match(toolOutputs.c_esc, /refused: \/etc\/passwd is outside the thread's worktrees and memory mount/);
    assert.equal(armRes.runs[0].questions[0].correctness, 1);
    assert.equal(armRes.runs[0].questions[0].citation, 1);
  } finally {
    builtinServer.close();
  }
});

test("oracle C2.3 (Cell 1): eval tool set and system prompt equal production tier1Launch byte-for-byte", async () => {
  const captured: { system: string; tools: unknown[] }[] = [];
  const parityServer = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      const sys = textOf((parsed.messages ?? []).find((m: any) => m.role === "system" || m.role === "developer")?.content);
      captured.push({ system: sys, tools: parsed.tools ?? [] });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        sseToolCalls([
          {
            id: "c_reply",
            name: "reply",
            args: { answer: "ok", confidence: 0.9, gaps: [], escalate_forced: "no" },
          },
        ]),
      );
    });
  });

  const parityPort = await new Promise<number>((resolve) =>
    parityServer.listen(0, "127.0.0.1", () => resolve((parityServer.address() as { port: number }).port)),
  );

  try {
    // 1. Run via eval's runArm
    await runArm("real", new URL("prompts/tier1.md", root).pathname, {
      model: "stub-qwen",
      base: `http://127.0.0.1:${parityPort}`,
      promptArms: { real: "", "no-steps": "", "no-citations": "" },
      questions: [{ id: "q-parity", question: "parity check" }],
    });
    assert.equal(captured.length, 1, "eval runArm must send 1 request to loopback stub");
    const evalCapture = captured[0];

    // 2. Run directly via production tier1Launch + Supervisor
    const prodAgentDir = mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/genie-c23-prod-`);
    writePiModelsJson(prodAgentDir, { baseUrl: `http://127.0.0.1:${parityPort}`, id: "stub-qwen" });
    const prodLaunch = tier1Launch({
      pi: process.env.PI ?? "pi",
      config: () => ({ root: "", searxngUrl: "http://127.0.0.1:1", cluster: [] }),
      args: () => ["--model", "genie/stub-qwen", "--no-session"],
    });
    const events: PiRecord[] = [];
    const prodSupervisor = new Supervisor(
      (th) => {
        const l = prodLaunch(th);
        return { ...l, env: { ...l.env, PI_CODING_AGENT_DIR: prodAgentDir, PI_OFFLINE: "1" } };
      },
      (_th, r) => events.push(r),
      (th) => ({
        eval: async () => ({}),
        recall: async () => ({}),
        escalate: async () => ({}),
        reply: async () => {
          void prodSupervisor.command(th, { type: "abort" }).catch(() => {});
          return { posted: true };
        },
        propose: async () => ({}),
        clone: async () => ({ path: "", rev: "x" }),
        screen: async (x) => x,
      }),
    );
    try {
      await prodSupervisor.command("prod-t1", { type: "prompt", message: "parity check" });
      while (!events.some((r) => r.type === "agent_settled")) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      await prodSupervisor.shutdown();
    }

    assert.equal(captured.length, 2, "production tier1Launch must also send 1 request to loopback stub");
    const prodCapture = captured[1];

    assert.strictEqual(evalCapture.system, prodCapture.system, "eval system prompt must equal production tier1Launch byte-for-byte");
    assert.deepStrictEqual(evalCapture.tools, prodCapture.tools, "eval tool set and schemas must equal production tier1Launch");
  } finally {
    parityServer.close();
  }
});

test("oracle C2.3 (Cell 2): checkpointed run with --resume skips finished questions without calling pi", async () => {
  const tmp = mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/genie-c23-resume-`);
  const outPath = `${tmp}/checkpoint.json`;
  const seenQuestions: string[] = [];

  const resumeServer = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      const usr = textOf((parsed.messages ?? []).find((m: any) => m.role === "user")?.content);
      seenQuestions.push(usr);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        sseToolCalls([
          {
            id: "c_reply",
            name: "reply",
            args: { answer: `ans for ${usr}`, confidence: 0.9, gaps: [], escalate_forced: "no" },
          },
        ]),
      );
    });
  });

  const resumePort = await new Promise<number>((resolve) =>
    resumeServer.listen(0, "127.0.0.1", () => resolve((resumeServer.address() as { port: number }).port)),
  );

  try {
    const q1: QuestionFixture = { id: "q-res-1", question: "First question?", expected_claims: ["ans for First question?"] };
    const q2: QuestionFixture = { id: "q-res-2", question: "Second question?", expected_claims: ["ans for Second question?"] };

    // Step 1: Run with only q1 and write checkpoint to outPath
    await runTier1PromptEval({
      model: "stub-qwen",
      base: `http://127.0.0.1:${resumePort}`,
      promptArms: { real: new URL("prompts/tier1.md", root).pathname, "no-steps": "", "no-citations": "" },
      questions: [q1],
      outPath,
    });
    assert.deepEqual(seenQuestions, ["First question?"]);

    // Step 2: Resume with [q1, q2] and resume: true -> q1 must be skipped, only q2 must run
    seenQuestions.length = 0;
    const resumedReport = await runTier1PromptEval({
      model: "stub-qwen",
      base: `http://127.0.0.1:${resumePort}`,
      promptArms: { real: new URL("prompts/tier1.md", root).pathname, "no-steps": "", "no-citations": "" },
      questions: [q1, q2],
      outPath,
      resume: true,
    });

    assert.deepEqual(seenQuestions, ["Second question?"], "resume must not re-run already checkpointed q1");
    assert.equal(resumedReport.arms.real.runs[0].questions.length, 2);
    assert.equal(resumedReport.arms.real.runs[0].questions[0].id, "q-res-1");
    assert.equal(resumedReport.arms.real.runs[0].questions[0].correctness, 1);
    assert.equal(resumedReport.arms.real.runs[0].questions[1].id, "q-res-2");
    assert.equal(resumedReport.arms.real.runs[0].questions[1].correctness, 1);
  } finally {
    resumeServer.close();
  }
});

test("oracle C2.3 (Cell 3): unanswered question (pi settles without reply or times out) has draft undefined, score 0, and counts in n_missing", async () => {
  let reqCount = 0;
  const unansweredServer = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      reqCount++;
      const parsed = JSON.parse(body);
      const usr = textOf((parsed.messages ?? []).find((m: any) => m.role === "user")?.content);
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (usr === " settles-without-reply ") {
        res.end(sseTextStop("I am stopping without calling the reply tool."));
        return;
      }
      res.end(
        sseToolCalls([
          {
            id: "c_reply",
            name: "reply",
            args: { answer: "answered", confidence: 1.0, gaps: [], escalate_forced: "no" },
          },
        ]),
      );
    });
  });

  const uPort = await new Promise<number>((resolve) =>
    unansweredServer.listen(0, "127.0.0.1", () => resolve((unansweredServer.address() as { port: number }).port)),
  );

  try {
    const armRes = await runArm("no-steps", new URL("prompts/tier1-no-steps.md", root).pathname, {
      model: "stub-qwen",
      base: `http://127.0.0.1:${uPort}`,
      promptArms: { real: "", "no-steps": "", "no-citations": "" },
      questions: [
        { id: "q-ans", question: "answered-q", expected_claims: ["answered"] },
        { id: "q-unans", question: " settles-without-reply ", expected_claims: ["answered"] },
      ],
    });

    assert.equal(reqCount, 2, "both questions must hit the loopback stub");
    const [qAns, qUnans] = armRes.runs[0].questions;
    assert.ok(qAns.draft !== undefined, "q-ans must have a captured draft");
    assert.equal(qAns.overall, 1);
    assert.equal(qUnans.draft, undefined, "question settling without reply must have draft: undefined");
    assert.equal(qUnans.overall, 0, "unanswered question must score 0");

    const baseline = makeSyntheticArm("real", [
      { id: "q-ans", overall: 1.0 },
      { id: "q-unans", overall: 1.0 },
    ]);
    const comp = compareArms(baseline, armRes);
    assert.equal(comp.n_paired, 1);
    assert.equal(comp.n_missing, 1);
  } finally {
    unansweredServer.close();
  }
});

