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
  generation_noise_band?: number;
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

export interface PairedBootstrapOptions {
  iterations?: number;
  alpha?: number;
  seed?: number;
}

export interface PairedBootstrapResult {
  sample_mean: number;
  ci_low: number;
  ci_high: number;
  confidence_level: number;
  crosses_zero: boolean;
}

export interface EvalComparison {
  baseline_arm: PromptArm;
  degraded_arm: PromptArm;
  baseline_mean: number;
  degraded_mean: number;
  delta: number;
  ci_low: number;
  ci_high: number;
  confidence_level: number;
  n_paired: number;
  n_missing: number;
  is_discriminating: boolean;
  status: "discriminating" | "inside_noise_band";
}

export interface ExploratoryPredictorResult {
  predictor: string;
  condition: string;
  met_count: number;
  met_accuracy: number;
  unmet_count: number;
  unmet_accuracy: number;
  lift: number;
  auroc: number;
}

export interface ExploratoryAnalysisReport {
  label: string;
  distinct_answered_count: number;
  predictors: ExploratoryPredictorResult[];
}

export interface EvalReport {
  model: string;
  runs_per_arm: number;
  concurrency: number;
  generation_noise_band?: number;
  arms: Record<string, ArmResult>;
  comparisons: EvalComparison[];
  calibration_curve: CalibrationBin[];
  threshold_analysis: ThresholdAnalysis[];
  exploratory_predictors?: ExploratoryAnalysisReport;
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

export function computeGenerationNoiseBand(scores: number[]): number {
  if (scores.length < 2) return 0;
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  return Number((max - min).toFixed(4));
}

// Retained as alias for backward compatibility
export const computeNoiseBand = computeGenerationNoiseBand;

export function createLcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function computePairedBootstrapCI(
  deltas: number[],
  options?: PairedBootstrapOptions,
): PairedBootstrapResult {
  const n = deltas.length;
  const iterations = options?.iterations ?? 10_000;
  const alpha = options?.alpha ?? 0.05;
  const confidence_level = Number((1 - alpha).toFixed(4));

  if (n === 0) {
    return {
      sample_mean: 0,
      ci_low: 0,
      ci_high: 0,
      confidence_level,
      crosses_zero: true,
    };
  }

  const seed = options?.seed ?? 42;
  const rand = createLcg(seed);

  const sampleMean = deltas.reduce((sum, d) => sum + d, 0) / n;
  const bootMeans = new Float64Array(iterations);

  for (let b = 0; b < iterations; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const idx = (rand() * n) | 0;
      sum += deltas[idx];
    }
    bootMeans[b] = sum / n;
  }

  bootMeans.sort();
  const lowIdx = Math.max(0, Math.floor(iterations * (alpha / 2)));
  const highIdx = Math.min(iterations - 1, Math.floor(iterations * (1 - alpha / 2)));
  const ci_low = Number(bootMeans[lowIdx].toFixed(4));
  const ci_high = Number(bootMeans[highIdx].toFixed(4));
  const sample_mean = Number(sampleMean.toFixed(4));
  const crosses_zero = ci_low <= 0 && ci_high >= 0;

  return {
    sample_mean,
    ci_low,
    ci_high,
    confidence_level,
    crosses_zero,
  };
}

export function compareArms(
  baseline: ArmResult,
  degraded: ArmResult,
  options?: PairedBootstrapOptions,
): EvalComparison {
  const bRuns = Math.max(1, baseline.runs.length);
  const dRuns = Math.max(1, degraded.runs.length);

  // Score maps: accumulate score per question id across runs.
  // Missing or unanswered (draft === undefined) counts as score 0.
  const baselineMap = new Map<string, number>();
  const baselineAnswered = new Set<string>();
  for (const run of baseline.runs) {
    for (const q of run.questions) {
      if (q.draft) {
        baselineAnswered.add(q.id);
        baselineMap.set(q.id, (baselineMap.get(q.id) ?? 0) + q.overall);
      }
    }
  }

  const degradedMap = new Map<string, number>();
  const degradedAnswered = new Set<string>();
  for (const run of degraded.runs) {
    for (const q of run.questions) {
      if (q.draft) {
        degradedAnswered.add(q.id);
        degradedMap.set(q.id, (degradedMap.get(q.id) ?? 0) + q.overall);
      }
    }
  }

  // Pair strictly by question ID, sorted for determinism and invariant to input order (Amendment 2)
  const allIds = Array.from(
    new Set([
      ...baseline.runs.flatMap((r) => r.questions.map((q) => q.id)),
      ...degraded.runs.flatMap((r) => r.questions.map((q) => q.id)),
    ]),
  ).sort();

  let n_paired = 0;
  let n_missing = 0;
  const deltas: number[] = [];

  for (const id of allIds) {
    const isBAnswered = baselineAnswered.has(id);
    const isDAnswered = degradedAnswered.has(id);

    const bScore = isBAnswered ? (baselineMap.get(id) ?? 0) / bRuns : 0;
    const dScore = isDAnswered ? (degradedMap.get(id) ?? 0) / dRuns : 0;

    if (isBAnswered && isDAnswered) {
      n_paired++;
    } else {
      n_missing++;
    }

    deltas.push(bScore - dScore);
  }

  const bootstrap = computePairedBootstrapCI(deltas, options);
  const delta = Number((baseline.mean_score - degraded.mean_score).toFixed(4));
  const is_discriminating = !bootstrap.crosses_zero && delta > 0;

  return {
    baseline_arm: baseline.arm,
    degraded_arm: degraded.arm,
    baseline_mean: baseline.mean_score,
    degraded_mean: degraded.mean_score,
    delta,
    ci_low: bootstrap.ci_low,
    ci_high: bootstrap.ci_high,
    confidence_level: bootstrap.confidence_level,
    n_paired,
    n_missing,
    is_discriminating,
    status: is_discriminating ? "discriminating" : "inside_noise_band",
  };
}

export function calcAuroc(scores: number[], labels: boolean[]): number {
  const n1 = labels.filter(Boolean).length;
  const n0 = labels.length - n1;
  if (n1 === 0 || n0 === 0) return 0.5;

  let wins = 0;
  for (let i = 0; i < scores.length; i++) {
    if (!labels[i]) continue;
    for (let j = 0; j < scores.length; j++) {
      if (labels[j]) continue;
      if (scores[i] > scores[j]) wins += 1.0;
      else if (scores[i] === scores[j]) wins += 0.5;
    }
  }
  return Number((wins / (n1 * n0)).toFixed(4));
}

export function computeExploratoryPredictors(questions: ScoredQuestion[]): ExploratoryAnalysisReport {
  // Deduplicate by question id to count distinct answered questions only (Amendment 4)
  const qMap = new Map<string, ScoredQuestion>();
  for (const q of questions) {
    if (q.draft && !qMap.has(q.id)) {
      qMap.set(q.id, q);
    }
  }
  const distinct = Array.from(qMap.values());
  const distinctCount = distinct.length;
  const label = `exploratory, N=${distinctCount}, no threshold`;

  // Binarize target: correctness >= 0.7
  const target = distinct.map((q) => q.correctness >= 0.7);

  function evalPredictor(
    name: string,
    conditionDesc: string,
    conditionFn: (q: ScoredQuestion) => boolean,
    scoreFn: (q: ScoredQuestion) => number,
  ): ExploratoryPredictorResult {
    const met = distinct.filter(conditionFn);
    const unmet = distinct.filter((q) => !conditionFn(q));
    const metAcc = met.length > 0 ? met.reduce((s, q) => s + q.correctness, 0) / met.length : 0;
    const unmetAcc = unmet.length > 0 ? unmet.reduce((s, q) => s + q.correctness, 0) / unmet.length : 0;
    const lift = metAcc - unmetAcc;
    const auroc = calcAuroc(distinct.map(scoreFn), target);
    return {
      predictor: name,
      condition: conditionDesc,
      met_count: met.length,
      met_accuracy: Number(metAcc.toFixed(4)),
      unmet_count: unmet.length,
      unmet_accuracy: Number(unmetAcc.toFixed(4)),
      lift: Number(lift.toFixed(4)),
      auroc,
    };
  }

  const predictors: ExploratoryPredictorResult[] = [
    evalPredictor(
      "Code Block Presence",
      "answer includes ```",
      (q) => (q.draft?.answer ?? "").includes("```"),
      (q) => ((q.draft?.answer ?? "").includes("```") ? 1 : 0),
    ),
    evalPredictor(
      "Tool Verification Effort",
      "tool calls >= 5",
      (q) => q.calls.length >= 5,
      (q) => q.calls.length,
    ),
    evalPredictor(
      "Citation Completeness",
      "citation score === 1.0",
      (q) => q.citation === 1.0,
      (q) => q.citation,
    ),
    evalPredictor(
      "Self-Reported Confidence (Baseline)",
      "confidence >= 0.8",
      (q) => (q.draft?.confidence ?? 0) >= 0.8,
      (q) => q.draft?.confidence ?? 0,
    ),
  ];

  return {
    label,
    distinct_answered_count: distinctCount,
    predictors,
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
  const generationNoiseBand = computeGenerationNoiseBand(runResults.map((r) => r.mean_score));

  return {
    arm,
    prompt_path: promptTextOrPath,
    runs: runResults,
    mean_score: Number(armMeanScore.toFixed(4)),
    mean_correctness: Number(armMeanCorr.toFixed(4)),
    mean_citation: Number(armMeanCite.toFixed(4)),
    mean_calibration: Number(armMeanCalib.toFixed(4)),
    generation_noise_band: runsCount >= 2 ? generationNoiseBand : undefined,
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
  const generationNoiseBand = baseline?.generation_noise_band;
  const comparisons: EvalComparison[] = [];

  for (const arm of armNames) {
    if (arm !== "real" && armResults[arm] && baseline) {
      comparisons.push(compareArms(baseline, armResults[arm]));
    }
  }

  // Calibration curve computed over all evaluations of the baseline arm
  const allBaselineEvaluations: { confidence: number; correctness: number }[] = [];
  const allBaselineQuestions: ScoredQuestion[] = [];
  if (baseline) {
    for (const run of baseline.runs) {
      for (const q of run.questions) {
        if (q.draft) {
          allBaselineEvaluations.push({
            confidence: q.draft.confidence,
            correctness: q.correctness,
          });
          allBaselineQuestions.push(q);
        }
      }
    }
  }

  const calibration_curve = computeCalibrationCurve(allBaselineEvaluations);
  const threshold_analysis = computeThresholdAnalysis(allBaselineEvaluations);
  const exploratory_predictors = computeExploratoryPredictors(allBaselineQuestions);

  return {
    model: options.model,
    runs_per_arm: options.runs ?? 1,
    concurrency: options.concurrency ?? 1,
    generation_noise_band: generationNoiseBand,
    arms: armResults,
    comparisons,
    calibration_curve,
    threshold_analysis,
    exploratory_predictors,
  };
}

export function formatReportTables(report: EvalReport): string {
  const lines: string[] = [];

  lines.push("=== Tier-1 Prompt Eval Summary ===");
  lines.push(`Model: ${report.model}`);
  lines.push(`Runs per arm: ${report.runs_per_arm}`);
  lines.push(`Concurrency: ${report.concurrency}`);
  if (report.generation_noise_band !== undefined) {
    lines.push(`Generation Noise Band (T>0 diagnostic, spread across runs): ${report.generation_noise_band.toFixed(4)}`);
  }
  lines.push("");

  lines.push("--- Arms Performance ---");
  lines.push(
    "Arm             Score   Correctness  Citation  Calibration  Runs Spread",
  );
  for (const [arm, res] of Object.entries(report.arms)) {
    const spreadStr = res.generation_noise_band !== undefined ? res.generation_noise_band.toFixed(4) : "n/a (N=1)";
    lines.push(
      `${arm.padEnd(15)} ${res.mean_score.toFixed(4).padEnd(7)} ${res.mean_correctness.toFixed(4).padEnd(12)} ${res.mean_citation.toFixed(4).padEnd(9)} ${res.mean_calibration.toFixed(4).padEnd(12)} ${spreadStr}`,
    );
  }
  lines.push("");

  lines.push("--- Comparisons Against Baseline (real) ---");
  lines.push("Degraded Arm    Baseline  Degraded  Delta     Bootstrap 95% CI       n_paired  n_missing  Status");
  for (const comp of report.comparisons) {
    const ciStr = `[${comp.ci_low >= 0 ? "+" : ""}${comp.ci_low.toFixed(4)}, ${comp.ci_high >= 0 ? "+" : ""}${comp.ci_high.toFixed(4)}]`;
    const deltaStr = `${comp.delta >= 0 ? "+" : ""}${comp.delta.toFixed(4)}`;
    lines.push(
      `${comp.degraded_arm.padEnd(15)} ${comp.baseline_mean.toFixed(4).padEnd(9)} ${comp.degraded_mean.toFixed(4).padEnd(9)} ${deltaStr.padEnd(9)} ${ciStr.padEnd(22)} ${String(comp.n_paired).padEnd(9)} ${String(comp.n_missing).padEnd(10)} ${comp.status}`,
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

  if (report.exploratory_predictors) {
    lines.push("");
    lines.push(`--- Exploratory Correctness Predictors (${report.exploratory_predictors.label}) ---`);
    lines.push("Predictor                              Condition                Met Acc (n)    Unmet Acc (n)  Lift     AUROC");
    for (const p of report.exploratory_predictors.predictors) {
      const metStr = `${p.met_accuracy.toFixed(4)} (${p.met_count})`;
      const unmetStr = `${p.unmet_accuracy.toFixed(4)} (${p.unmet_count})`;
      const liftStr = `${p.lift >= 0 ? "+" : ""}${p.lift.toFixed(4)}`;
      lines.push(
        `${p.predictor.padEnd(38)} ${p.condition.padEnd(24)} ${metStr.padEnd(14)} ${unmetStr.padEnd(14)} ${liftStr.padEnd(8)} ${p.auroc.toFixed(4)}`,
      );
    }
  }

  return lines.join("\n");
}

// --- Unit C2.2: Tier-1 Operating Memory (Wiki & Bank) Eval ---

export type MemoryArm = "no-memory" | "wiki" | "bank" | "wiki+bank";

export interface MemoryRecallItem {
  document_id?: string;
  text?: string;
  tags?: string[];
  score?: number;
}

export interface MemoryRecallFixture {
  metadata: {
    bank_id?: string;
    endpoint?: string;
    recorded_at?: string;
    stand_in?: boolean;
  };
  fixtures: Record<
    string,
    {
      query: string;
      results: MemoryRecallItem[];
    }
  >;
}

export interface MemoryRetrievalCheckResult {
  verified: number;
  unindexedSlugs: string[];
  missingFixtureSlugs: string[];
  retrieval_misses: string[];
}

// Amendment 7: Model-free retrieval check verifying for every question:
// (a) expected citation slug is linked from MEMORY.md, and
// (b) expected citation slug is present in the question's recall fixture.
// Amendment 6: harness explicitly refuses stand-in fixture on --live runs.
// Unit C2.2.1: on live runs, a question whose expected slug is absent from its recall fixture
// is recorded in retrieval_misses (and missingFixtureSlugs) rather than throwing, whereas
// a stand-in fixture, an unindexed slug, or a question with no fixture entry at all still throws.
export function verifyModelFreeRetrieval(
  questions: QuestionFixture[],
  memoryMdPath: string,
  recallFixtures: MemoryRecallFixture,
  options: { live?: boolean } = {},
): MemoryRetrievalCheckResult {
  if (options.live && recallFixtures.metadata?.stand_in) {
    throw new Error("refused: cannot use stand-in recall fixture on a live run");
  }

  let memoryText: string;
  try {
    memoryText = readFileSync(memoryMdPath, "utf8");
  } catch {
    throw new Error(`memory index not found: ${memoryMdPath}`);
  }

  // Extract all markdown links [title](path)
  const links = new Set<string>();
  const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(memoryText)) !== null) {
    links.add(match[2].trim());
  }

  const unindexedSlugs: string[] = [];
  const missingFixtureSlugs: string[] = [];
  const retrievalMissSet = new Set<string>();
  let verified = 0;

  for (const q of questions) {
    const citations = q.expected_citations ?? [];
    const fix = recallFixtures.fixtures?.[q.id];

    // If a question has no fixture entry at all, the recorder never ran for it — always fatal.
    if (!fix) {
      for (const slug of citations) {
        if (!links.has(slug)) {
          unindexedSlugs.push(`${q.id}:${slug}`);
          throw new Error(`unindexed citation slug: ${slug} in question ${q.id} not linked from ${memoryMdPath}`);
        }
        missingFixtureSlugs.push(`${q.id}:${slug}`);
      }
      throw new Error(`missing recall fixture for question ${q.id}`);
    }

    for (const slug of citations) {
      // (a) Link check: citation must be linked from MEMORY.md
      if (!links.has(slug)) {
        unindexedSlugs.push(`${q.id}:${slug}`);
        throw new Error(`unindexed citation slug: ${slug} in question ${q.id} not linked from ${memoryMdPath}`);
      }

      // (b) Fixture check: citation must be present in question's recall fixture
      const found = fix.results?.some(
        (r) =>
          r.document_id === slug ||
          r.document_id?.endsWith(slug) ||
          r.tags?.some((t) => t.includes(slug)) ||
          r.text?.includes(slug),
      );

      if (!found) {
        missingFixtureSlugs.push(`${q.id}:${slug}`);
        retrievalMissSet.add(q.id);
        if (!options.live) {
          throw new Error(`expected citation ${slug} not found in recall fixture for ${q.id}`);
        }
        continue;
      }

      verified++;
    }
  }

  return {
    verified,
    unindexedSlugs,
    missingFixtureSlugs,
    retrieval_misses: Array.from(retrievalMissSet),
  };
}

// Oracle 4: An arm that silently loads no memory is reported as such, not scored as a memory arm.
export function assertNotEmptyMemoryArm(
  arm: MemoryArm,
  memoryContent?: string,
  recallFixtures?: Record<string, unknown>,
): void {
  if (arm === "wiki" || arm === "wiki+bank") {
    if (!memoryContent || memoryContent.trim() === "" || !memoryContent.includes("[")) {
      throw new Error(`empty memory arm: ${arm} has no memory loaded`);
    }
  }
  if (arm === "bank" || arm === "wiki+bank") {
    if (!recallFixtures || Object.keys(recallFixtures).length === 0) {
      throw new Error(`empty memory arm: ${arm} has no memory loaded`);
    }
  }
}

export interface MemoryRetrievalResult {
  question_id: string;
  expected_citation: string;
  read_called: boolean;
  recall_called: boolean;
  retrieved: boolean;
}

export interface MemoryArmResult extends ArmResult {
  arm: any;
  retrieval_rate: number;
  retrieval_miss_count: number;
  retrieval_misses: string[];
  retrieval_results: MemoryRetrievalResult[];
}

export interface MemoryEvalComparison extends EvalComparison {
  baseline_arm: any;
  degraded_arm: any;
}

export interface MemoryEvalReport {
  model: string;
  runs_per_arm: number;
  concurrency: number;
  generation_noise_band?: number;
  retrieval_misses: string[];
  arms: Record<MemoryArm, MemoryArmResult>;
  comparisons: MemoryEvalComparison[];
  model_free_retrieval?: MemoryRetrievalCheckResult;
}

export interface MemoryEvalOptions {
  model: string;
  base: string;
  apiKey?: string;
  basePromptPath?: string;
  memoryRoot?: string;
  memoryMdPath?: string;
  recallFixturesPath?: string;
  recallFixtures?: MemoryRecallFixture;
  questions: QuestionFixture[];
  heldOutQuestionsFile?: string;
  arms?: MemoryArm[];
  runs?: number;
  concurrency?: number;
  turns?: number;
  maxTokens?: number;
  live?: boolean;
  fetchFn?: typeof fetch;
}

export function memoryPromptFromIndex(memoryMdPath: string): string {
  try {
    const content = readFileSync(memoryMdPath, "utf8");
    return `# Operating Memory Index\n\n${content}\n`;
  } catch {
    throw new Error(`memory index not found: ${memoryMdPath}`);
  }
}

export async function runTier1MemoryEval(options: MemoryEvalOptions): Promise<MemoryEvalReport> {
  let allQuestions = [...options.questions];
  if (options.heldOutQuestionsFile) {
    try {
      const raw = readFileSync(options.heldOutQuestionsFile, "utf8");
      const heldOut: QuestionFixture[] = raw
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      allQuestions = [...allQuestions, ...heldOut];
    } catch (err) {
      throw new Error(`failed to load held-out questions: ${(err as Error).message}`);
    }
  }

  const memoryMdPath =
    options.memoryMdPath ??
    `${options.memoryRoot ?? new URL("../../operating-memory", import.meta.url).pathname}/MEMORY.md`;

  let recallFixtures = options.recallFixtures;
  if (!recallFixtures) {
    const fixPath =
      options.recallFixturesPath ??
      new URL("tests/fixtures/memory-eval/recall-fixtures.json", repoRoot).pathname;
    const raw = readFileSync(fixPath, "utf8");
    recallFixtures = JSON.parse(raw) as MemoryRecallFixture;
  }

  // Model-free retrieval check (Amendment 6 & 7)
  const retrievalCheck = verifyModelFreeRetrieval(
    allQuestions,
    memoryMdPath,
    recallFixtures,
    { live: options.live },
  );
  const fixtureMissSet = new Set(retrievalCheck.retrieval_misses);

  let memoryContent: string | undefined;
  try {
    memoryContent = readFileSync(memoryMdPath, "utf8");
  } catch {
    memoryContent = undefined;
  }

  const armNames: MemoryArm[] = options.arms ?? ["no-memory", "wiki", "bank", "wiki+bank"];

  // Verify no arm silently loads empty memory (Oracle 4)
  for (const arm of armNames) {
    assertNotEmptyMemoryArm(arm, memoryContent, recallFixtures.fixtures);
  }

  const basePromptPath =
    options.basePromptPath ?? new URL("prompts/tier1.md", repoRoot).pathname;
  const basePrompt = readFileSync(basePromptPath, "utf8");

  const tools = tier1Tools();
  const fetcher = options.fetchFn ?? fetch;
  const runsCount = options.runs ?? 1;
  const turns = options.turns ?? 6;
  const maxTokens = options.maxTokens ?? 16384;
  const concurrency = options.concurrency ?? 1;

  const armResults: Record<string, MemoryArmResult> = {};

  for (const arm of armNames) {
    let system = `${basePrompt}\n\n${skillsPrompt()}`;
    if (arm === "wiki" || arm === "wiki+bank") {
      system = `${system}\n\n${memoryPromptFromIndex(memoryMdPath)}`;
    }

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

    const allRetrievalResults: MemoryRetrievalResult[] = [];

    async function evaluateQuestion(q: QuestionFixture): Promise<ScoredQuestion> {
      const messages: any[] = [
        { role: "system", content: system },
        { role: "user", content: q.question },
      ];
      const calls: string[] = [];
      let last: Message = {};
      let finish = "";
      let readCalled = false;
      let recallCalled = false;

      for (let turn = 0; turn < turns; turn++) {
        ({ message: last, finish } = await completeTurn(messages));
        const toolCalls = (last as any).tool_calls ?? [];
        calls.push(...toolCalls.map((c: any) => c.function.name));
        if (!toolCalls.length || toolCalls.some((c: any) => c.function.name === "reply")) break;
        messages.push({ role: "assistant", content: last.content ?? "", tool_calls: toolCalls });

        for (const c of toolCalls) {
          const fnName = c.function.name;
          let toolArgs: any = {};
          try {
            toolArgs = typeof c.function.arguments === "string" ? JSON.parse(c.function.arguments) : c.function.arguments;
          } catch {}

          if (fnName === "read") {
            const p = toolArgs.path ?? "";
            const matchesCitation = (q.expected_citations ?? []).some((cite) => p.includes(cite));

            let fileContent = "";
            if (arm === "wiki" || arm === "wiki+bank") {
              try {
                fileContent = readFileSync(p, "utf8");
                if (matchesCitation) readCalled = true;
              } catch {
                fileContent = `[wiki content for ${p}]`;
                if (matchesCitation) readCalled = true;
              }
            } else {
              fileContent = `refused: ${p} is outside the thread's worktrees`;
            }
            messages.push({
              role: "tool",
              tool_call_id: c.id,
              content: JSON.stringify({ content: fileContent }),
            });
          } else if (fnName === "recall") {
            const matchesCitation = (q.expected_citations ?? []).some((cite) =>
              (toolArgs.query ?? "").toLowerCase().includes(cite.toLowerCase()),
            );

            let recallResp: any = { results: [] };
            if (arm === "bank" || arm === "wiki+bank") {
              const fix = recallFixtures?.fixtures?.[q.id];
              if (fix && fix.results?.length) {
                recallResp = { results: fix.results };
                if (!fixtureMissSet.has(q.id) && (matchesCitation || toolArgs.bank === "memory")) {
                  recallCalled = true;
                }
              }
            }
            messages.push({
              role: "tool",
              tool_call_id: c.id,
              content: JSON.stringify(recallResp),
            });
          } else {
            messages.push({
              role: "tool",
              tool_call_id: c.id,
              content: JSON.stringify({ error: `${fnName} is unavailable in this evaluation` }),
            });
          }
        }
      }

      const expectedCite = q.expected_citations?.[0] ?? "";
      const retrieved = readCalled || recallCalled;
      allRetrievalResults.push({
        question_id: q.id,
        expected_citation: expectedCite,
        read_called: readCalled,
        recall_called: recallCalled,
        retrieved,
      });

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
      const questionsScored = await pMap(allQuestions, evaluateQuestion, concurrency);
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

    const totalRetrievals = allRetrievalResults.filter((r) => r.retrieved).length;
    const retrievalRate = allRetrievalResults.length > 0 ? totalRetrievals / allRetrievalResults.length : 0;
    const armMissQids = Array.from(
      new Set(allRetrievalResults.filter((r) => !r.retrieved).map((r) => r.question_id)),
    );

    armResults[arm] = {
      arm,
      runs: runResults,
      mean_score: Number(armMeanScore.toFixed(4)),
      mean_correctness: Number(armMeanCorr.toFixed(4)),
      mean_citation: Number(armMeanCite.toFixed(4)),
      mean_calibration: Number(armMeanCalib.toFixed(4)),
      generation_noise_band: runsCount >= 2 ? noiseBand : undefined,
      retrieval_rate: Number(retrievalRate.toFixed(4)),
      retrieval_miss_count: armMissQids.length,
      retrieval_misses: armMissQids,
      retrieval_results: allRetrievalResults,
    };
  }

  // Comparisons: each memory arm beats no-memory baseline
  const noMemoryArm = armResults["no-memory"];
  const genNoiseBand = noMemoryArm?.generation_noise_band ?? armResults["wiki+bank"]?.generation_noise_band;
  const comparisons: MemoryEvalComparison[] = [];

  for (const arm of ["wiki", "bank", "wiki+bank"] as MemoryArm[]) {
    if (armResults[arm] && noMemoryArm) {
      comparisons.push(compareArms(armResults[arm] as any, noMemoryArm as any) as any);
    }
  }

  return {
    model: options.model,
    runs_per_arm: runsCount,
    concurrency,
    generation_noise_band: genNoiseBand,
    retrieval_misses: retrievalCheck.retrieval_misses,
    arms: armResults as Record<MemoryArm, MemoryArmResult>,
    comparisons,
    model_free_retrieval: retrievalCheck,
  };
}

export function formatMemoryReportTables(report: MemoryEvalReport): string {
  const lines: string[] = [];

  lines.push("=== Tier-1 Operating Memory Eval Summary ===");
  lines.push(`Model: ${report.model}`);
  lines.push(`Runs per arm: ${report.runs_per_arm}`);
  lines.push(`Concurrency: ${report.concurrency}`);
  if (report.generation_noise_band !== undefined) {
    lines.push(`Measured Noise Band: ${report.generation_noise_band.toFixed(4)}`);
  }
  lines.push("");

  lines.push("--- Memory Arms Performance ---");
  lines.push(
    "Arm             Score   Correctness  Citation  Calibration  Retrieval  Misses  Runs Spread",
  );
  for (const [arm, res] of Object.entries(report.arms)) {
    const spreadStr = res.generation_noise_band !== undefined ? res.generation_noise_band.toFixed(4) : "n/a (N=1)";
    const missCount = String(res.retrieval_miss_count ?? res.retrieval_misses?.length ?? 0);
    lines.push(
      `${arm.padEnd(15)} ${res.mean_score.toFixed(4).padEnd(7)} ${res.mean_correctness.toFixed(4).padEnd(12)} ${res.mean_citation.toFixed(4).padEnd(9)} ${res.mean_calibration.toFixed(4).padEnd(12)} ${res.retrieval_rate.toFixed(4).padEnd(10)} ${missCount.padEnd(7)} ${spreadStr}`,
    );
  }
  lines.push("");

  lines.push("--- Comparisons Against Baseline (no-memory) ---");
  lines.push("Memory Arm      Memory    No-Memory Delta     Bootstrap 95% CI       n_paired  n_missing  Status");
  for (const comp of report.comparisons) {
    const ciStr = `[${comp.ci_low >= 0 ? "+" : ""}${comp.ci_low.toFixed(4)}, ${comp.ci_high >= 0 ? "+" : ""}${comp.ci_high.toFixed(4)}]`;
    const deltaStr = `${comp.delta >= 0 ? "+" : ""}${comp.delta.toFixed(4)}`;
    lines.push(
      `${String(comp.baseline_arm).padEnd(15)} ${comp.baseline_mean.toFixed(4).padEnd(9)} ${comp.degraded_mean.toFixed(4).padEnd(9)} ${deltaStr.padEnd(9)} ${ciStr.padEnd(22)} ${String(comp.n_paired).padEnd(9)} ${String(comp.n_missing).padEnd(10)} ${comp.status}`,
    );
  }

  if (report.model_free_retrieval) {
    lines.push("");
    lines.push("--- Model-Free Retrieval Check ---");
    lines.push(`Verified Question-Citation Mappings: ${report.model_free_retrieval.verified}`);
    lines.push(`Unindexed Slugs: ${report.model_free_retrieval.unindexedSlugs.length}`);
    lines.push(`Missing Fixture Slugs: ${report.model_free_retrieval.missingFixtureSlugs.length}`);
    lines.push(
      `retrieval_misses: ${JSON.stringify(report.model_free_retrieval.retrieval_misses ?? [])}`,
    );
  }

  return lines.join("\n");
}

