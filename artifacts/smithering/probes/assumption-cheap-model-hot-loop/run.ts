#!/usr/bin/env bun
/**
 * Probe runner: assumption-cheap-model-hot-loop
 *
 * Runs the hot-loop classifier (observe.pass vs ACT) over the ground-truth
 * corpus using two cheap/fast model candidates:
 *   1. claude-haiku-4-5-20251001  (Anthropic Haiku 4.5)
 *   2. llama-3.3-70b              (Cerebras)
 *
 * Writes evidence files to the probe directory and prints a summary.
 * Exit code 0 = assumption holds; non-zero = assumption fails (plan must change).
 */

import { writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CORPUS, PASS_COUNT, ACTION_COUNT } from "./corpus.ts";
import {
  classifyWithOpenAI,
  classifyWithCerebras,
  type Decision,
} from "./classify.ts";
import {
  computeMetrics,
  checkGates,
  THRESHOLDS,
  type SampleResult,
  type RunMetrics,
} from "./metrics.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const CEREBRAS_KEY = process.env.CEREBRAS_API_KEY;

if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY not set");
if (!CEREBRAS_KEY) throw new Error("CEREBRAS_API_KEY not set");

async function runModel(
  label: string,
  provider: "anthropic" | "cerebras",
  model: string,
): Promise<RunMetrics> {
  console.log(`\n── ${label} (${model}) ──`);
  const results: SampleResult[] = [];

  for (const sample of CORPUS) {
    let classified: { decision: Decision; reasoning: string; latencyMs: number; inputTokens: number; outputTokens: number };

    try {
      if (provider === "openai") {
        classified = await classifyWithOpenAI(sample.text, model, OPENAI_KEY!);
      } else {
        classified = await classifyWithCerebras(sample.text, model, CEREBRAS_KEY!);
      }
    } catch (err) {
      console.error(`  [${sample.id}] ERROR: ${err}`);
      // Record as wrong rather than crashing the entire run
      classified = {
        decision: "PASS",
        reasoning: `ERROR: ${err}`,
        latencyMs: 0,
        inputTokens: 0,
        outputTokens: 0,
      };
    }

    const correct =
      (sample.label === "action" && classified.decision === "ACT") ||
      (sample.label === "pass" && classified.decision === "PASS");

    const icon = correct ? "✓" : "✗";
    const tag = sample.label === "action" ? "ACT" : "PASS";
    const pred = classified.decision;
    const mismatch = !correct ? ` ← expected ${tag}, got ${pred}` : "";
    console.log(
      `  ${icon} [${sample.id}] ${pred.padEnd(4)} ${classified.latencyMs.toFixed(0).padStart(4)}ms  "${sample.text.slice(0, 60)}"${mismatch}`,
    );

    results.push({
      id: sample.id,
      text: sample.text,
      trueLabel: sample.label,
      predicted: classified.decision,
      correct,
      latencyMs: classified.latencyMs,
      inputTokens: classified.inputTokens,
      outputTokens: classified.outputTokens,
      reasoning: classified.reasoning,
    });

    // 50 ms between calls to avoid bursting rate limits
    await Bun.sleep(50);
  }

  return computeMetrics(model, provider, results);
}

function printSummary(m: RunMetrics, gates: { passed: boolean; failures: string[] }) {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  console.log(`
  Model:      ${m.model}
  Provider:   ${m.provider}
  Samples:    ${m.totalSamples} (${ACTION_COUNT} action / ${PASS_COUNT} pass)
  Precision:  ${pct(m.precision)}  (TP=${m.truePositives} FP=${m.falsePositives})
  Recall:     ${pct(m.recall)}   (TP=${m.truePositives} FN=${m.falseNegatives})
  F1:         ${pct(m.f1)}
  Accuracy:   ${pct(m.accuracy)}
  Latency:    avg ${m.avgLatencyMs.toFixed(0)}ms  p50 ${m.p50LatencyMs.toFixed(0)}ms  p95 ${m.p95LatencyMs.toFixed(0)}ms
  Tokens:     ${m.totalInputTokens} in / ${m.totalOutputTokens} out  (corpus total)
  Cost/corpus:  $${m.estimatedCostUsd.toFixed(6)}
  Cost/hour:    $${m.estimatedCostPerHourUsd.toFixed(4)}
  Gate:       ${gates.passed ? "PASS ✓" : "FAIL ✗  " + gates.failures.join("; ")}
`);
}

async function main() {
  console.log("Probe: assumption-cheap-model-hot-loop");
  console.log(`Corpus: ${CORPUS.length} samples (${ACTION_COUNT} action, ${PASS_COUNT} pass)`);
  console.log(`Thresholds: precision≥${THRESHOLDS.minPrecision} recall≥${THRESHOLDS.minRecall} p95≤${THRESHOLDS.maxP95LatencyMs}ms cost≤$${THRESHOLDS.maxCostPerHourUsd}/hr`);

  const allRuns: RunMetrics[] = [];

  // gpt-4o-mini: OpenAI's Haiku-tier equivalent (cheap, fast, capable)
  const haikuMetrics = await runModel("gpt-4o-mini (Haiku-tier)", "openai", "gpt-4o-mini");
  const haikuGates = checkGates(haikuMetrics);
  printSummary(haikuMetrics, haikuGates);
  allRuns.push(haikuMetrics);

  // gpt-oss-120b: Cerebras fast inference (only model available in this account)
  const cerebrasMetrics = await runModel("Cerebras gpt-oss-120b", "cerebras", "gpt-oss-120b");
  const cerebrasGates = checkGates(cerebrasMetrics);
  printSummary(cerebrasMetrics, cerebrasGates);
  allRuns.push(cerebrasMetrics);

  // Serialize results (strip circular refs)
  const evidence = allRuns.map((m) => ({
    model: m.model,
    provider: m.provider,
    metrics: {
      totalSamples: m.totalSamples,
      truePositives: m.truePositives,
      falsePositives: m.falsePositives,
      trueNegatives: m.trueNegatives,
      falseNegatives: m.falseNegatives,
      precision: m.precision,
      recall: m.recall,
      f1: m.f1,
      accuracy: m.accuracy,
      avgLatencyMs: m.avgLatencyMs,
      p50LatencyMs: m.p50LatencyMs,
      p95LatencyMs: m.p95LatencyMs,
      totalInputTokens: m.totalInputTokens,
      totalOutputTokens: m.totalOutputTokens,
      estimatedCostUsd: m.estimatedCostUsd,
      estimatedCostPerHourUsd: m.estimatedCostPerHourUsd,
    },
    gates: checkGates(m),
    results: m.results,
  }));

  // Write per-model JSONL evidence files
  for (const e of evidence) {
    const slug = e.model.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    const path = join(HERE, `evidence-${slug}.json`);
    await writeFile(path, JSON.stringify(e, null, 2));
    console.log(`Wrote: ${path}`);
  }

  // Write combined summary
  const anyPassed = allRuns.some((m) => checkGates(m).passed);
  const summary = {
    assumptionId: "assumption-cheap-model-hot-loop",
    runDate: new Date().toISOString(),
    corporusSize: CORPUS.length,
    actionSamples: ACTION_COUNT,
    passSamples: PASS_COUNT,
    thresholds: THRESHOLDS,
    models: evidence.map((e) => ({ model: e.model, ...e.metrics, gates: e.gates })),
    overallPassed: anyPassed,
    recommendation: anyPassed
      ? "At least one cheap/fast model meets all gates. Use it for the Cue hot loop."
      : "No cheap/fast model met all gates. See planImpact in probe output.",
  };

  const summaryPath = join(HERE, "summary.json");
  await writeFile(summaryPath, JSON.stringify(summary, null, 2));
  console.log(`Wrote: ${summaryPath}`);

  console.log(`\nOverall: ${anyPassed ? "ASSUMPTION HOLDS ✓" : "ASSUMPTION FAILS ✗"}`);
  process.exit(anyPassed ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(2);
});
