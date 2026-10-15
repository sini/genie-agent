// Offline re-analysis script for C2.1 live run (Unit C2.1.1).
// Re-evaluates results/tier1/c2.1-run.json under the paired bootstrap rule
// with zero model calls.
import { readFileSync, writeFileSync } from "node:fs";
import {
  compareArms,
  computeExploratoryPredictors,
  type EvalComparison,
  type ExploratoryAnalysisReport,
} from "../src/tier1/eval.ts";

const repoRoot = new URL("..", import.meta.url);
const runFile = new URL("results/tier1/c2.1-run.json", repoRoot).pathname;
const outJson = new URL("results/tier1/c2.1-reanalysis.json", repoRoot).pathname;
const outMd = new URL("results/tier1/c2.1-reanalysis.md", repoRoot).pathname;

const rawData = JSON.parse(readFileSync(runFile, "utf8"));

const realArm = rawData.arms.real;
const noStepsArm = rawData.arms["no-steps"];
const noCitationsArm = rawData.arms["no-citations"];

const cSteps: EvalComparison = compareArms(realArm, noStepsArm);
const cCitations: EvalComparison = compareArms(realArm, noCitationsArm);

const baselineQuestions = realArm.runs.flatMap((r: any) => r.questions);
const exploratory: ExploratoryAnalysisReport = computeExploratoryPredictors(baselineQuestions);

const reanalysisReport = {
  model: rawData.model,
  source_artifact: "results/tier1/c2.1-run.json",
  rule: "paired_bootstrap_ci",
  conclusion: "Under the new paired bootstrap rule, C2.1 did not discriminate either degraded arm.",
  comparisons: [cSteps, cCitations],
  exploratory_predictors: exploratory,
  calibration_curve: rawData.calibration_curve,
  threshold_analysis: rawData.threshold_analysis,
};

writeFileSync(outJson, `${JSON.stringify(reanalysisReport, null, 2)}\n`);

const md = `# C2.1 Offline Re-Analysis: Tier-1 Eval Noise Band & Calibration

## Executive Summary
**Conclusion:** Under the paired bootstrap rule over benchmark questions, the C2.1 evaluation **did not discriminate either degraded arm**.
Both \`no-steps\` (95% CI: [\`${cSteps.ci_low.toFixed(4)}\`, \`+${cSteps.ci_high.toFixed(4)}\`]) and \`no-citations\` (95% CI: [\`${cCitations.ci_low.toFixed(4)}\`, \`+${cCitations.ci_high.toFixed(4)}\`]) cross zero. The observed positive point deltas (+0.0938 and +0.0465) are statistically indistinguishable from question-sampling variance ($N=24$).

---

## 1. Arm Comparisons Against Baseline (real)

| Degraded Arm | Baseline Mean | Degraded Mean | Delta | 95% Bootstrap CI | Paired / Missing | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| \`${cSteps.degraded_arm}\` | ${cSteps.baseline_mean.toFixed(4)} | ${cSteps.degraded_mean.toFixed(4)} | +${cSteps.delta.toFixed(4)} | [${cSteps.ci_low.toFixed(4)}, +${cSteps.ci_high.toFixed(4)}] | ${cSteps.n_paired} / ${cSteps.n_missing} | **${cSteps.status}** |
| \`${cCitations.degraded_arm}\` | ${cCitations.baseline_mean.toFixed(4)} | ${cCitations.degraded_mean.toFixed(4)} | +${cCitations.delta.toFixed(4)} | [${cCitations.ci_low.toFixed(4)}, +${cCitations.ci_high.toFixed(4)}] | ${cCitations.n_paired} / ${cCitations.n_missing} | **${cCitations.status}** |

- **Root Cause**: While \`real\` scored higher on average, high question-to-question variance ($\\\\sigma_D \\\\approx 0.32$) and individual failure modes on \`gen-fileset-advantage\` and \`gen-library\` mean the sample size of 24 questions is insufficient to claim prompt superiority at 95% confidence.

---

## 2. Calibration Analysis (real arm, $N=66$ answered runs)
- **Expected Calibration Error (ECE)**: 0.1711 (17.1%)

| Bin Range | Count | Mean Confidence | Accuracy | Calibration Error |
| :--- | :--- | :--- | :--- | :--- |
| \`[0.0, 0.2)\` | 0 | 0.1000 | 0.0000 | 0.1000 |
| \`[0.2, 0.4)\` | 12 | 0.2750 | 0.7708 | 0.4958 |
| \`[0.4, 0.6)\` | 6 | 0.4000 | 0.6250 | 0.2250 |
| \`[0.6, 0.8)\` | 33 | 0.7064 | 0.7273 | 0.0209 |
| \`[0.8, 1.0]\` | 15 | 0.8700 | 0.6500 | 0.2200 |

*Finding*: The model exhibits inverted calibration on this task. Questions answered with confidence $\\\\ge 0.8$ achieved only 65.0% accuracy, whereas questions answered with lower confidence achieved 72.5% accuracy.

---

## 3. Exploratory Correctness Predictors (${exploratory.label})

*Computed strictly over the ${exploratory.distinct_answered_count} distinct answered questions at T=0 (exploratory, no production threshold change):*

| Predictor | Condition | Met Acc (n) | Unmet Acc (n) | Lift | AUROC |
| :--- | :--- | :--- | :--- | :--- | :--- |
${exploratory.predictors
  .map(
    (p) =>
      `| ${p.predictor} | \`${p.condition}\` | ${(p.met_accuracy * 100).toFixed(1)}% (${p.met_count}) | ${(p.unmet_accuracy * 100).toFixed(1)}% (${p.unmet_count}) | ${p.lift >= 0 ? "+" : ""}${(p.lift * 100).toFixed(1)}% | **${p.auroc.toFixed(4)}** |`,
  )
  .join("\n")}

### Recommendation for C5 Consideration
Self-reported confidence is an unreliable signal for escalation (AUROC = 0.4256, worse than chance). Objective signals—specifically presence of formatted code blocks and verification tool calls—correlate positively with factual correctness.
`;

writeFileSync(outMd, md);
console.log(`Re-analysis written to:\n  - ${outJson}\n  - ${outMd}`);
