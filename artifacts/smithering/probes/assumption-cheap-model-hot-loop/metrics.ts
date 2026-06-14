/**
 * Precision / recall / F1 and cost estimates for each model run.
 */

import type { Label } from "./corpus.ts";
import type { Decision } from "./classify.ts";

export interface SampleResult {
  id: string;
  text: string;
  trueLabel: Label;
  predicted: Decision;
  correct: boolean;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  reasoning: string;
}

export interface RunMetrics {
  model: string;
  provider: "openai" | "anthropic" | "cerebras";
  totalSamples: number;
  truePositives: number;
  falsePositives: number;
  trueNegatives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1: number;
  accuracy: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  /** Estimated cost in USD using provider list pricing */
  estimatedCostUsd: number;
  /** Estimated cost per hour of room conversation at 1 segment / 10s */
  estimatedCostPerHourUsd: number;
  results: SampleResult[];
}

/** OpenAI gpt-4o-mini pricing (as of 2026-06, per 1M tokens) — Haiku-tier stand-in */
const HAIKU_INPUT_PER_M = 0.15;
const HAIKU_OUTPUT_PER_M = 0.60;

/** Cerebras gpt-oss-120b pricing (as of 2026-06, per 1M tokens) */
const CEREBRAS_INPUT_PER_M = 0.60;
const CEREBRAS_OUTPUT_PER_M = 0.60;

function percentile(sorted: number[], p: number): number {
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)];
}

export function computeMetrics(
  model: string,
  provider: "openai" | "anthropic" | "cerebras",
  results: SampleResult[],
): RunMetrics {
  let tp = 0,
    fp = 0,
    tn = 0,
    fn = 0;
  let totalInput = 0,
    totalOutput = 0;
  const latencies: number[] = [];

  for (const r of results) {
    const actual = r.trueLabel === "action";
    const pred = r.predicted === "ACT";
    if (actual && pred) tp++;
    else if (!actual && pred) fp++;
    else if (!actual && !pred) tn++;
    else fn++;
    totalInput += r.inputTokens;
    totalOutput += r.outputTokens;
    latencies.push(r.latencyMs);
  }

  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  const accuracy = results.length > 0 ? (tp + tn) / results.length : 0;

  latencies.sort((a, b) => a - b);
  const avgLatencyMs = latencies.reduce((a, b) => a + b, 0) / latencies.length;

  const inputRatePerM =
    provider === "cerebras" ? CEREBRAS_INPUT_PER_M : HAIKU_INPUT_PER_M;
  const outputRatePerM =
    provider === "cerebras" ? CEREBRAS_OUTPUT_PER_M : HAIKU_OUTPUT_PER_M;

  const estimatedCostUsd =
    (totalInput / 1_000_000) * inputRatePerM +
    (totalOutput / 1_000_000) * outputRatePerM;

  // At 1 segment per 10 seconds → 360 segments/hour
  // Scale per-corpus cost by (360 / corpus size)
  const segmentsPerHour = 360;
  const costPerSample = estimatedCostUsd / results.length;
  const estimatedCostPerHourUsd = costPerSample * segmentsPerHour;

  return {
    model,
    provider,
    totalSamples: results.length,
    truePositives: tp,
    falsePositives: fp,
    trueNegatives: tn,
    falseNegatives: fn,
    precision,
    recall,
    f1,
    accuracy,
    avgLatencyMs,
    p50LatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    estimatedCostUsd,
    estimatedCostPerHourUsd,
    results,
  };
}

/**
 * Pass/fail gate against the assumption.
 *
 * Thresholds (conservative for a voice product where false positives interrupt
 * the room):
 *   - precision ≥ 0.85 (≤15% false-positive rate)
 *   - recall    ≥ 0.75 (miss at most 25% of actionable utterances)
 *   - p95 latency ≤ 800 ms (Cue has a LLM budget; 800 ms is generous for tests)
 *   - cost/hour ≤ $0.10 (10¢/hour of room conversation)
 */
export const THRESHOLDS = {
  minPrecision: 0.85,
  minRecall: 0.75,
  maxP95LatencyMs: 800,
  maxCostPerHourUsd: 0.10,
};

export function checkGates(m: RunMetrics): {
  passed: boolean;
  failures: string[];
} {
  const failures: string[] = [];
  if (m.precision < THRESHOLDS.minPrecision)
    failures.push(
      `precision ${(m.precision * 100).toFixed(1)}% < ${THRESHOLDS.minPrecision * 100}% (too many false-positive interruptions)`,
    );
  if (m.recall < THRESHOLDS.minRecall)
    failures.push(
      `recall ${(m.recall * 100).toFixed(1)}% < ${THRESHOLDS.minRecall * 100}% (misses too many actionable utterances)`,
    );
  if (m.p95LatencyMs > THRESHOLDS.maxP95LatencyMs)
    failures.push(
      `p95 latency ${m.p95LatencyMs.toFixed(0)} ms > ${THRESHOLDS.maxP95LatencyMs} ms budget`,
    );
  if (m.estimatedCostPerHourUsd > THRESHOLDS.maxCostPerHourUsd)
    failures.push(
      `cost $${m.estimatedCostPerHourUsd.toFixed(4)}/hr > $${THRESHOLDS.maxCostPerHourUsd}/hr limit`,
    );
  return { passed: failures.length === 0, failures };
}
