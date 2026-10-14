// Hermetic test for tier-1 discriminating prompt evaluation (Unit C2.1, Oracle).
// Runs hermetically against a stub model server on loopback without live ninfer.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import {
  formatReportTables,
  type QuestionFixture,
  runTier1PromptEval,
} from "../src/tier1/eval.ts";

const root = new URL("..", import.meta.url);
const questions: QuestionFixture[] = readFileSync(
  new URL("tests/fixtures/tier1-eval/questions.jsonl", root),
  "utf8",
)
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

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
        const systemMsg = messages.find((m: any) => m.role === "system")?.content ?? "";
        const userMsg = messages.find((m: any) => m.role === "user")?.content ?? "";

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
          // Slight jitter across runs to produce a non-zero measured noise band
          const runIndex = Math.floor((callCount - 1) / questions.length);
          const jitter = (runIndex % 3) * 0.03;
          confidence = Number((0.92 - jitter).toFixed(2));
          answer = `Checked ${citations.join(" and ")}: confirmed that ${claims.join(" and ")} holds true.`;
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

        const replyArgs = JSON.stringify({
          answer,
          confidence,
          gaps,
          escalate_forced: q.id === "asks-for-expert" ? "yes" : "no",
        });

        const responsePayload = {
          choices: [
            {
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "reply",
                      arguments: replyArgs,
                    },
                  },
                ],
              },
            },
          ],
        };

        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(responsePayload));
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

test("oracle: a degraded arm scores below the real prompt by more than the measured noise band", async () => {
  maxInFlight = 0;
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

  // Verify concurrency cap at 1: inFlight never exceeded 1
  assert.strictEqual(maxInFlight, 1, `max concurrency must be 1 (got ${maxInFlight})`);

  // Noise band must be measured across repeated runs of real prompt
  assert(
    report.noise_band > 0,
    `noise_band must be strictly positive (got ${report.noise_band})`,
  );
  assert(
    report.arms.real.noise_band !== undefined && report.arms.real.noise_band > 0,
    "real arm must record positive noise_band across repeated runs",
  );

  // Both degraded arms must score below real by more than noise band
  assert.strictEqual(report.comparisons.length, 2);
  for (const comp of report.comparisons) {
    assert(
      comp.delta > comp.noise_band,
      `Degraded arm ${comp.degraded_arm} delta (${comp.delta}) must exceed noise band (${comp.noise_band})`,
    );
    assert.strictEqual(
      comp.status,
      "discriminating",
      `Comparison for ${comp.degraded_arm} must be discriminating`,
    );
    assert.strictEqual(comp.is_discriminating, true);
  }

  // Calibration curve must cover bins and compute error
  assert.strictEqual(report.calibration_curve.length, 5);
  const totalCount = report.calibration_curve.reduce((s, b) => s + b.count, 0);
  assert.strictEqual(totalCount, questions.length * 3);

  // Threshold analysis must include C5 threshold 0.8
  const c5Entry = report.threshold_analysis.find((t) => t.threshold === 0.8);
  assert(c5Entry !== undefined, "threshold_analysis must include 0.8 for C5");
  assert(c5Entry.accepted_accuracy > 0.8, "accepted accuracy at 0.8 must be high");

  // Output formatting table helper
  const formatted = formatReportTables(report);
  assert(formatted.includes("=== Tier-1 Prompt Eval Summary ==="));
  assert(formatted.includes("--- Comparisons Against Baseline (real) ---"));
  assert(formatted.includes("--- Calibration Curve (real arm) ---"));
  assert(formatted.includes("--- Escalation Threshold Analysis for C5 (real arm) ---"));
});

test("mutant: score a single run per arm reports inside noise band, not as a result", async () => {
  const promptArms = {
    real: new URL("prompts/tier1.md", root).pathname,
    "no-steps": new URL("prompts/tier1-no-steps.md", root).pathname,
  };

  const reportSingle = await runTier1PromptEval({
    model: "stub-qwen",
    base: `http://127.0.0.1:${port}`,
    promptArms,
    questions,
    runs: 1, // Single run per arm
    concurrency: 1,
  });

  assert.strictEqual(reportSingle.comparisons.length, 1);
  const comp = reportSingle.comparisons[0];

  // With a single run, noise band is not established: reported as inside noise band, not discriminating
  assert.strictEqual(
    comp.status,
    "inside_noise_band",
    "single run per arm must be reported as inside_noise_band",
  );
  assert.strictEqual(
    comp.is_discriminating,
    false,
    "single run per arm must not be reported as a discriminating result",
  );
});
