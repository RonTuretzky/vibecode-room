// LATENCY LEDGER — turns "the responsivity sucks" into numbers.
//
// The harness stamps three clocks for every spoken line:
//   1. SPOKEN   — scripts/fake-voxterm.ts wrote the final frame (its ledger file)
//   2. PUBLISHED— the server's /api/events SSE frame carrying that line arrived
//   3. PAINTED  — the text became visible in the real browser's DOM
// Joining them gives spoken→published (server lag) and spoken→painted (what a
// human waits), separated, so a regression can be blamed on the right half.
//
// Pure functions only: no I/O, no clock. The harness feeds it records; this
// module joins, summarizes and formats. That keeps it unit-testable under the
// plain `bun test` sweep alongside the rest of the repo.

/** One frame as scripts/fake-voxterm.ts appended it to the ledger file. */
export interface EmitRecord {
  utteranceId: string;
  text: string;
  final: boolean;
  emittedAtMs: number;
  scriptAtMs?: number;
}

/** One observation of that text somewhere downstream (SSE frame, DOM paint). */
export interface ObservationRecord {
  /** Where it was seen: "sse", "dom", "state", ... */
  stage: string;
  /** Text that was observed. Matched against emits by exact trimmed equality. */
  text: string;
  atMs: number;
}

export interface LatencySample {
  text: string;
  stage: string;
  spokenAtMs: number;
  observedAtMs: number;
  latencyMs: number;
}

export interface LatencySummary {
  stage: string;
  count: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

/**
 * Join emitted finals to their first downstream observation. Interims are
 * ignored (they mutate in place and have no stable identity on the wall — see
 * src/ui/App.tsx TranscriptStream, which renders interim and committed lines
 * identically). Unobserved finals are reported by {@link missingFinals}, never
 * silently dropped: a line the wall never showed is the headline defect, not a
 * gap in the sample set.
 */
export function joinLatency(emits: EmitRecord[], observations: ObservationRecord[]): LatencySample[] {
  const samples: LatencySample[] = [];
  const byStage = new Map<string, ObservationRecord[]>();
  for (const observation of observations) {
    const bucket = byStage.get(observation.stage) ?? [];
    bucket.push(observation);
    byStage.set(observation.stage, bucket);
  }

  for (const emit of emits) {
    if (!emit.final) {
      continue;
    }
    const wanted = emit.text.trim();
    for (const [stage, bucket] of byStage) {
      const hit = bucket
        .filter((observation) => observation.text.trim() === wanted && observation.atMs >= emit.emittedAtMs)
        .sort((left, right) => left.atMs - right.atMs)[0];
      if (hit === undefined) {
        continue;
      }
      samples.push({
        text: wanted,
        stage,
        spokenAtMs: emit.emittedAtMs,
        observedAtMs: hit.atMs,
        latencyMs: hit.atMs - emit.emittedAtMs,
      });
    }
  }
  return samples;
}

/** Finals that never showed up at `stage` — the "the wall never said it" list. */
export function missingFinals(emits: EmitRecord[], observations: ObservationRecord[], stage: string): string[] {
  const seen = new Set(
    observations.filter((observation) => observation.stage === stage).map((observation) => observation.text.trim()),
  );
  return emits.filter((emit) => emit.final).map((emit) => emit.text.trim()).filter((text) => !seen.has(text));
}

export function summarize(samples: LatencySample[], stage: string): LatencySummary {
  const values = samples.filter((sample) => sample.stage === stage).map((sample) => sample.latencyMs).sort((a, b) => a - b);
  if (values.length === 0) {
    return { stage, count: 0, minMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 };
  }
  return {
    stage,
    count: values.length,
    minMs: values[0]!,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: values[values.length - 1]!,
  };
}

/** Nearest-rank percentile over a pre-sorted array. */
export function percentile(sortedValues: number[], fraction: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }
  const rank = Math.max(1, Math.ceil(fraction * sortedValues.length));
  return sortedValues[Math.min(sortedValues.length, rank) - 1]!;
}

/** SSE traffic accounting — the "publish amplification" half of responsivity. */
export interface StreamCost {
  frames: number;
  bytes: number;
  windowMs: number;
  framesPerSecond: number;
  bytesPerSecond: number;
  /** SSE frames emitted per committed spoken line. */
  framesPerSpokenLine: number;
}

export function streamCost(
  frames: ReadonlyArray<{ bytes: number }>,
  windowMs: number,
  spokenLines: number,
): StreamCost {
  const bytes = frames.reduce((total, frame) => total + frame.bytes, 0);
  const seconds = Math.max(1, windowMs) / 1000;
  return {
    frames: frames.length,
    bytes,
    windowMs,
    framesPerSecond: round2(frames.length / seconds),
    bytesPerSecond: Math.round(bytes / seconds),
    framesPerSpokenLine: spokenLines > 0 ? round2(frames.length / spokenLines) : 0,
  };
}

/** One-line human/CI readable report. Printed by every scenario. */
export function formatSummary(summary: LatencySummary): string {
  if (summary.count === 0) {
    return `${summary.stage}: NO SAMPLES (nothing was observed downstream)`;
  }
  return `${summary.stage}: n=${summary.count} min=${summary.minMs}ms p50=${summary.p50Ms}ms p95=${summary.p95Ms}ms max=${summary.maxMs}ms`;
}

export function formatStreamCost(cost: StreamCost): string {
  return `sse: ${cost.frames} frames / ${cost.bytes} bytes over ${cost.windowMs}ms (${cost.framesPerSecond}/s, ${cost.bytesPerSecond} B/s, ${cost.framesPerSpokenLine} frames per spoken line)`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
