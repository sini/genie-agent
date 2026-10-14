import { readdirSync, readFileSync } from "node:fs";
import { type Draft, draftOf, type Message } from "./draft.ts";
import { type Pi, tier1 } from "./index.ts";

const repoRoot = new URL("../../", import.meta.url);

export function skillsPrompt(dir = new URL("skills", repoRoot).pathname): string {
  try {
    const skills = readdirSync(dir)
      .sort()
      .map((d) => `<skill name="${d}">\n${readFileSync(`${dir}/${d}/SKILL.md`, "utf8")}</skill>`);
    return `# Skills\n\n${skills.join("\n\n")}\n`;
  } catch {
    return "";
  }
}

export type PromptArm = "real" | "no-steps" | "no-citations";

export interface QuestionFixture {
  id: string;
  question: string;
  expected_claims?: string[];
  expected_citations?: string[];
  expected_answer?: string;
}

export interface ScoredQuestion {
  id: string;
  question: string;
  calls: string[];
  finish: string;
  draft?: Draft;
  error?: string;
  correctness: number;
  citation: number;
  calibration: number;
  overall: number;
  last: Message;
}

export interface RunResult {
  run_index: number;
  mean_score: number;
  mean_correctness: number;
  mean_citation: number;
  mean_calibration: number;
  questions: ScoredQuestion[];
}

export interface ArmResult {
  arm: PromptArm;
  prompt_path?: string;
  runs: RunResult[];
  mean_score: number;
  mean_correctness: number;
  mean_citation: number;
  mean_calibration: number;
  noise_band?: number;
}

export interface CalibrationBin {
  bin: string;
  range: [number, number];
  count: number;
  mean_confidence: number;
  accuracy: number;
  error: number;
}

export interface ThresholdAnalysis {
  threshold: number;
  accepted_count: number;
  escalated_count: number;
  escalate_rate: number;
  accepted_accuracy: number;
}

export interface EvalComparison {
  baseline_arm: PromptArm;
  degraded_arm: PromptArm;
  baseline_mean: number;
  degraded_mean: number;
  delta: number;
  noise_band: number;
  is_discriminating: boolean;
  status: "discriminating" | "inside_noise_band";
}

export interface EvalReport {
  model: string;
  runs_per_arm: number;
  concurrency: number;
  noise_band: number;
  arms: Record<string, ArmResult>;
  comparisons: EvalComparison[];
  calibration_curve: CalibrationBin[];
  threshold_analysis: ThresholdAnalysis[];
}

export interface EvalOptions {
  model: string;
  base: string;
  apiKey?: string;
  promptArms: Record<PromptArm, string>;
  questions: QuestionFixture[];
  runs?: number;
  concurrency?: number;
  turns?: number;
  maxTokens?: number;
  fetchFn?: typeof fetch;
}

export function tier1Tools(): { type: "function"; function: { name: string; description: string; parameters: unknown } }[] {
  const tools: { type: "function"; function: { name: string; description: string; parameters: unknown } }[] = [];
  const recorder = {
    registerTool: ({ name, description, parameters }) =>
      tools.push({ type: "function", function: { name, description, parameters } }),
    on() {},
    setActiveTools() {},
  } as Pi;
  const never = () => Promise.reject(new Error("not called"));
  tier1(
    { root: "/nonexistent", searxngUrl: "http://127.0.0.1:1", cluster: [] },
    { host: { eval: never, recall: never, escalate: never, reply: never, propose: never, clone: never, screen: never } },
  )(recorder);
  return tools;
}

export function scoreQuestion(q: QuestionFixture, last: Message, calls: string[]): {
  draft?: Draft;
  error?: string;
  correctness: number;
  citation: number;
  calibration: number;
  overall: number;
} {
  const parsed = draftOf(last);
  if ("error" in parsed) {
    return {
      error: parsed.error,
      correctness: 0,
      citation: 0,
      calibration: 0,
      overall: 0,
    };
  }
  const draft = parsed.draft;
  const answer = (draft.answer ?? "").toLowerCase();

  // Correctness: expected checkable claims in answer
  const claims = q.expected_claims ?? [];
  let matchedClaims = 0;
  if (claims.length > 0) {
    for (const claim of claims) {
      if (answer.includes(claim.toLowerCase())) matchedClaims++;
    }
  } else {
    matchedClaims = 1;
  }
  const correctness = claims.length > 0 ? matchedClaims / claims.length : 1.0;

  // Citation: expected citations in answer or tool calls
  const citations = q.expected_citations ?? [];
  let matchedCitations = 0;
  if (citations.length > 0) {
    for (const cite of citations) {
      const clower = cite.toLowerCase();
      if (answer.includes(clower) || calls.some((c) => c.toLowerCase().includes(clower))) {
        matchedCitations++;
      }
    }
  } else {
    matchedCitations = 1;
  }
  const citation = citations.length > 0 ? matchedCitations / citations.length : 1.0;

  // Calibration: 1 - |stated confidence - correctness|
  const calibration = Math.max(0, 1 - Math.abs(draft.confidence - correctness));

  // Overall composite score
  const overall = 0.5 * correctness + 0.3 * citation + 0.2 * calibration;

  return {
    draft,
    correctness,
    citation,
    calibration,
    overall,
  };
}

export function computeNoiseBand(scores: number[]): number {
  if (scores.length < 2) return 0;
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  return Number((max - min).toFixed(4));
}

export function compareArms(baseline: ArmResult, degraded: ArmResult, noiseBand: number): EvalComparison {
  const delta = Number((baseline.mean_score - degraded.mean_score).toFixed(4));
  // A single run per arm does not establish a noise band: reported as inside noise band, not as a result.
  const singleRun = baseline.runs.length < 2 || degraded.runs.length < 2;
  const is_discriminating = !singleRun && delta > noiseBand;
  return {
    baseline_arm: baseline.arm,
    degraded_arm: degraded.arm,
    baseline_mean: baseline.mean_score,
    degraded_mean: degraded.mean_score,
    delta,
    noise_band: noiseBand,
    is_discriminating,
    status: is_discriminating ? "discriminating" : "inside_noise_band",
  };
}

export function computeCalibrationCurve(
  evaluations: { confidence: number; correctness: number }[],
  bins: [number, number][] = [
    [0.0, 0.2],
    [0.2, 0.4],
    [0.4, 0.6],
    [0.6, 0.8],
    [0.8, 1.0],
  ],
): CalibrationBin[] {
  return bins.map(([min, max], idx) => {
    const isLast = idx === bins.length - 1;
    const inBin = evaluations.filter((e) =>
      isLast ? e.confidence >= min && e.confidence <= max : e.confidence >= min && e.confidence < max,
    );
    const count = inBin.length;
    const mean_confidence = count > 0 ? inBin.reduce((s, e) => s + e.confidence, 0) / count : (min + max) / 2;
    const accuracy = count > 0 ? inBin.reduce((s, e) => s + e.correctness, 0) / count : 0;
    const error = Math.abs(mean_confidence - accuracy);
    return {
      bin: `[${min.toFixed(1)}, ${max.toFixed(1)}${isLast ? "]" : ")"}`,
      range: [min, max],
      count,
      mean_confidence: Number(mean_confidence.toFixed(4)),
      accuracy: Number(accuracy.toFixed(4)),
      error: Number(error.toFixed(4)),
    };
  });
}

export function computeThresholdAnalysis(
  evaluations: { confidence: number; correctness: number }[],
  thresholds: number[] = [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9],
): ThresholdAnalysis[] {
  const total = evaluations.length;
  return thresholds.map((threshold) => {
    const accepted = evaluations.filter((e) => e.confidence >= threshold);
    const escalated = evaluations.filter((e) => e.confidence < threshold);
    const accepted_accuracy = accepted.length > 0
      ? accepted.reduce((s, e) => s + e.correctness, 0) / accepted.length
      : 1.0;
    const escalate_rate = total > 0 ? escalated.length / total : 0;
    return {
      threshold,
      accepted_count: accepted.length,
      escalated_count: escalated.length,
      escalate_rate: Number(escalate_rate.toFixed(4)),
      accepted_accuracy: Number(accepted_accuracy.toFixed(4)),
    };
  });
}

export async function pMap<T, R>(items: T[], fn: (item: T) => Promise<R>, concurrency = 1): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (idx < items.length) {
      const current = idx++;
      results[current] = await fn(items[current]);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function runArm(
  arm: PromptArm,
  promptTextOrPath: string,
  options: EvalOptions,
  tools: unknown[],
): Promise<ArmResult> {
  const fetcher = options.fetchFn ?? fetch;
  const runsCount = options.runs ?? 1;
  const turns = options.turns ?? 6;
  const maxTokens = options.maxTokens ?? 16384;
  const concurrency = options.concurrency ?? 1;

  let promptContent = promptTextOrPath;
  if (!promptTextOrPath.includes("\n") && promptTextOrPath.endsWith(".md")) {
    promptContent = readFileSync(promptTextOrPath, "utf8");
  }
  const system = `${promptContent}\n\n${skillsPrompt()}`;

  async function completeTurn(messages: unknown[]): Promise<{ message: Message; finish: string }> {
    const res = await fetcher(`${options.base}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: options.model,
        temperature: 0,
        max_tokens: maxTokens,
        messages,
        tools,
      }),
      signal: AbortSignal.timeout(300_000),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    const choice = JSON.parse(body).choices?.[0];
    if (!choice?.message) throw new Error(`No message choice in response: ${body.slice(0, 200)}`);
    return { message: choice.message, finish: choice.finish_reason ?? "" };
  }

  async function evaluateQuestion(q: QuestionFixture): Promise<ScoredQuestion> {
    const messages: any[] = [
      { role: "system", content: system },
      { role: "user", content: q.question },
    ];
    const calls: string[] = [];
    let last: Message = {};
    let finish = "";

    for (let turn = 0; turn < turns; turn++) {
      ({ message: last, finish } = await completeTurn(messages));
      const toolCalls = (last as any).tool_calls ?? [];
      calls.push(...toolCalls.map((c: any) => c.function.name));
      if (!toolCalls.length || toolCalls.some((c: any) => c.function.name === "reply")) break;
      messages.push({ role: "assistant", content: last.content ?? "", tool_calls: toolCalls });
      for (const c of toolCalls) {
        messages.push({
          role: "tool",
          tool_call_id: c.id,
          content: JSON.stringify({ error: `${c.function.name} is unavailable in this evaluation` }),
        });
      }
    }

    const scored = scoreQuestion(q, last, calls);
    return {
      id: q.id,
      question: q.question,
      calls,
      finish,
      last,
      ...scored,
    };
  }

  const runResults: RunResult[] = [];
  for (let runIdx = 0; runIdx < runsCount; runIdx++) {
    const questionsScored = await pMap(options.questions, evaluateQuestion, concurrency);
    const meanScore = questionsScored.reduce((s, q) => s + q.overall, 0) / questionsScored.length;
    const meanCorr = questionsScored.reduce((s, q) => s + q.correctness, 0) / questionsScored.length;
    const meanCite = questionsScored.reduce((s, q) => s + q.citation, 0) / questionsScored.length;
    const meanCalib = questionsScored.reduce((s, q) => s + q.calibration, 0) / questionsScored.length;

    runResults.push({
      run_index: runIdx + 1,
      mean_score: Number(meanScore.toFixed(4)),
      mean_correctness: Number(meanCorr.toFixed(4)),
      mean_citation: Number(meanCite.toFixed(4)),
      mean_calibration: Number(meanCalib.toFixed(4)),
      questions: questionsScored,
    });
  }

  const armMeanScore = runResults.reduce((s, r) => s + r.mean_score, 0) / runResults.length;
  const armMeanCorr = runResults.reduce((s, r) => s + r.mean_correctness, 0) / runResults.length;
  const armMeanCite = runResults.reduce((s, r) => s + r.mean_citation, 0) / runResults.length;
  const armMeanCalib = runResults.reduce((s, r) => s + r.mean_calibration, 0) / runResults.length;
  const noiseBand = computeNoiseBand(runResults.map((r) => r.mean_score));

  return {
    arm,
    prompt_path: promptTextOrPath,
    runs: runResults,
    mean_score: Number(armMeanScore.toFixed(4)),
    mean_correctness: Number(armMeanCorr.toFixed(4)),
    mean_citation: Number(armMeanCite.toFixed(4)),
    mean_calibration: Number(armMeanCalib.toFixed(4)),
    noise_band: runsCount >= 2 ? noiseBand : undefined,
  };
}

export async function runTier1PromptEval(options: EvalOptions): Promise<EvalReport> {
  const tools = tier1Tools();
  const armResults: Record<string, ArmResult> = {};

  const armNames: PromptArm[] = ["real", "no-steps", "no-citations"];
  for (const arm of armNames) {
    if (options.promptArms[arm]) {
      armResults[arm] = await runArm(arm, options.promptArms[arm], options, tools);
    }
  }

  const baseline = armResults["real"];
  const noiseBand = baseline?.noise_band ?? 0;
  const comparisons: EvalComparison[] = [];

  for (const arm of armNames) {
    if (arm !== "real" && armResults[arm] && baseline) {
      comparisons.push(compareArms(baseline, armResults[arm], noiseBand));
    }
  }

  // Calibration curve computed over all evaluations of the baseline arm
  const allBaselineEvaluations: { confidence: number; correctness: number }[] = [];
  if (baseline) {
    for (const run of baseline.runs) {
      for (const q of run.questions) {
        if (q.draft) {
          allBaselineEvaluations.push({
            confidence: q.draft.confidence,
            correctness: q.correctness,
          });
        }
      }
    }
  }

  const calibration_curve = computeCalibrationCurve(allBaselineEvaluations);
  const threshold_analysis = computeThresholdAnalysis(allBaselineEvaluations);

  return {
    model: options.model,
    runs_per_arm: options.runs ?? 1,
    concurrency: options.concurrency ?? 1,
    noise_band: noiseBand,
    arms: armResults,
    comparisons,
    calibration_curve,
    threshold_analysis,
  };
}

export function formatReportTables(report: EvalReport): string {
  const lines: string[] = [];

  lines.push("=== Tier-1 Prompt Eval Summary ===");
  lines.push(`Model: ${report.model}`);
  lines.push(`Runs per arm: ${report.runs_per_arm}`);
  lines.push(`Concurrency: ${report.concurrency}`);
  lines.push(`Measured Noise Band (spread of real arm): ${report.noise_band.toFixed(4)}`);
  lines.push("");

  lines.push("--- Arms Performance ---");
  lines.push(
    "Arm             Score   Correctness  Citation  Calibration  Runs Spread",
  );
  for (const [arm, res] of Object.entries(report.arms)) {
    const spreadStr = res.noise_band !== undefined ? res.noise_band.toFixed(4) : "n/a (N=1)";
    lines.push(
      `${arm.padEnd(15)} ${res.mean_score.toFixed(4).padEnd(7)} ${res.mean_correctness.toFixed(4).padEnd(12)} ${res.mean_citation.toFixed(4).padEnd(9)} ${res.mean_calibration.toFixed(4).padEnd(12)} ${spreadStr}`,
    );
  }
  lines.push("");

  lines.push("--- Comparisons Against Baseline (real) ---");
  lines.push("Degraded Arm    Baseline  Degraded  Delta    NoiseBand  Status");
  for (const comp of report.comparisons) {
    lines.push(
      `${comp.degraded_arm.padEnd(15)} ${comp.baseline_mean.toFixed(4).padEnd(9)} ${comp.degraded_mean.toFixed(4).padEnd(9)} ${comp.delta.toFixed(4).padEnd(8)} ${comp.noise_band.toFixed(4).padEnd(10)} ${comp.status}`,
    );
  }
  lines.push("");

  lines.push("--- Calibration Curve (real arm) ---");
  lines.push("Confidence Bin  Count  Mean Conf  Accuracy  Error");
  for (const bin of report.calibration_curve) {
    lines.push(
      `${bin.bin.padEnd(15)} ${String(bin.count).padEnd(6)} ${bin.mean_confidence.toFixed(4).padEnd(10)} ${bin.accuracy.toFixed(4).padEnd(9)} ${bin.error.toFixed(4)}`,
    );
  }
  lines.push("");

  lines.push("--- Escalation Threshold Analysis for C5 (real arm) ---");
  lines.push("Threshold  Escalate Rate  Accepted Acc  Accepted / Escalated");
  for (const t of report.threshold_analysis) {
    const pct = `${(t.escalate_rate * 100).toFixed(1)}%`;
    lines.push(
      `${t.threshold.toFixed(2).padEnd(10)} ${pct.padEnd(14)} ${t.accepted_accuracy.toFixed(4).padEnd(13)} ${t.accepted_count} / ${t.escalated_count}`,
    );
  }

  return lines.join("\n");
}
