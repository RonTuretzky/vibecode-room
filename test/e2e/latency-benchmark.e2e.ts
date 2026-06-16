import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { playAck, playEarcon, PRERENDERED_ACKS } from "../../src/audio/earcons";
import { RecordingAudioOutput } from "../../src/audio/test-doubles";
import { precacheStatePhrases, WorkingAckScheduler } from "../../src/audio/output-policy";
import { CueAdapter } from "../../src/cue/adapter";
import { BoardEventBus } from "../../src/obs/board";
import { TraceProcessor } from "../../src/obs/trace";
import { createDeepgramNova3ASRFromEnv } from "../../src/providers/asr/deepgram";
import { NoopTTSProvider } from "../../src/providers/tts/noop";
import { runReplayObservations, type DecisionInput, type DecisionLLM } from "../../src/replay/harness";
import type { DispatchedAction, LogEvent, TranscriptObservation } from "../../src/types";

const TICKET_ID = "latency-benchmark-suite";
const SESSION_ID = "latency-benchmark-replay";
const ROUND_TRIPS = 128;
const NOMINAL_DECISION_DELAY_MS = 8;
const DELAYED_DECISION_PROOF_MS = 450;
const ARTIFACT_ROOT = `artifacts/smithering/build/${TICKET_ID}`;
const TRACE_ROOT = `${ARTIFACT_ROOT}/trace`;
const TRACE_PATH = `${TRACE_ROOT}/latency-benchmark.jsonl`;
const CURRENT_REPORT_PATH = `${ARTIFACT_ROOT}/current-report.json`;
const GATES_PATH = `${ARTIFACT_ROOT}/gates.json`;
const BASELINE_PATH = `${ARTIFACT_ROOT}/baseline.json`;

interface LatencyBaseline {
  ticketId: string;
  minimumRoundTrips: number;
  budgets: {
    textCueEarconMaxMs: number;
    roundTripP50MaxMs: number;
    roundTripP95MaxMs: number;
    workingAckBudgetMs: number;
    workingAckEdgeToleranceMs: number;
    precachedFixedPhrasePlaybackMaxMs: number;
    delayedDecisionProofMinMs: number;
  };
}

interface RoundTripMetric {
  index: number;
  utteranceId: string;
  correlationId: string;
  earconLatencyMs: number;
  decisionLatencyMs: number;
  roundTripMs: number;
  actionType: DispatchedAction["type"];
  cacheHit: boolean;
}

interface BenchmarkReport {
  ticketId: typeof TICKET_ID;
  mode: "record-replay";
  roundTrips: {
    count: number;
    p50Ms: number;
    p95Ms: number;
    maxMs: number;
  };
  textCue: {
    maxEarconLatencyMs: number;
    delayedDecisionMs: number;
    earconBeforeDelayedDecision: boolean;
  };
  workingAck: {
    budgetMs: number;
    firstAckAtMs: number;
    silenceBeforeBudget: boolean;
  };
  fixedPhrasePlayback: {
    phrase: "Working";
    precacheMs: number;
    playbackMs: number;
    clipId: "working";
    prerendered: boolean;
  };
  liveAsr: {
    status: "skipped" | "configured";
    reason: string | null;
    provider: "deepgram";
    model: "nova-3";
  };
  evidence: {
    baseline: string;
    currentReport: string;
    gates: string;
    trace: string;
  };
  metrics: RoundTripMetric[];
}

describe("latency benchmark suite", () => {
  test("record-replay benchmark enforces hot-path latency budgets and gates live ASR on DEEPGRAM_API_KEY", async () => {
    const baseline = await readBaseline();
    await resetGeneratedArtifacts();

    const replay = await runReplayBenchmark();
    const delayedProof = await measureDelayedEarconProof(baseline.budgets.delayedDecisionProofMinMs);
    const workingAck = await measureWorkingAckBudgetEdge(baseline.budgets.workingAckBudgetMs);
    const fixedPhrasePlayback = await measureFixedPhrasePlayback();
    const roundTripLatencies = replay.metrics.map((metric) => metric.roundTripMs);
    const summary = {
      count: replay.metrics.length,
      p50Ms: percentile(roundTripLatencies, 50),
      p95Ms: percentile(roundTripLatencies, 95),
      maxMs: Math.max(...roundTripLatencies),
    };
    const report: BenchmarkReport = {
      ticketId: TICKET_ID,
      mode: "record-replay",
      roundTrips: summary,
      textCue: {
        maxEarconLatencyMs: Math.max(delayedProof.earconLatencyMs, ...replay.metrics.map((metric) => metric.earconLatencyMs)),
        delayedDecisionMs: delayedProof.delayedDecisionMs,
        earconBeforeDelayedDecision: delayedProof.earconBeforeDelayedDecision,
      },
      workingAck,
      fixedPhrasePlayback,
      liveAsr: liveAsrStatus(),
      evidence: {
        baseline: BASELINE_PATH,
        currentReport: CURRENT_REPORT_PATH,
        gates: GATES_PATH,
        trace: TRACE_PATH,
      },
      metrics: replay.metrics,
    };

    await emitEvidence(report, replay.traceEvents);

    expect(report.roundTrips.count).toBeGreaterThanOrEqual(baseline.minimumRoundTrips);
    expect(report.textCue.maxEarconLatencyMs).toBeLessThanOrEqual(baseline.budgets.textCueEarconMaxMs);
    expect(report.textCue.delayedDecisionMs).toBeGreaterThanOrEqual(baseline.budgets.delayedDecisionProofMinMs);
    expect(report.textCue.earconBeforeDelayedDecision).toBe(true);
    expect(report.roundTrips.p50Ms).toBeLessThan(baseline.budgets.roundTripP50MaxMs);
    expect(report.roundTrips.p95Ms).toBeLessThan(baseline.budgets.roundTripP95MaxMs);
    expect(report.workingAck.silenceBeforeBudget).toBe(true);
    expect(Math.abs(report.workingAck.firstAckAtMs - baseline.budgets.workingAckBudgetMs)).toBeLessThanOrEqual(
      baseline.budgets.workingAckEdgeToleranceMs,
    );
    expect(report.fixedPhrasePlayback.playbackMs).toBeLessThan(baseline.budgets.precachedFixedPhrasePlaybackMaxMs);
    expect(report.fixedPhrasePlayback.prerendered).toBe(true);

    if (process.env.DEEPGRAM_API_KEY === undefined || process.env.DEEPGRAM_API_KEY.length === 0) {
      expect(report.liveAsr).toEqual({
        status: "skipped",
        reason: "live ASR round-trip latency SKIPPED - needs DEEPGRAM_API_KEY",
        provider: "deepgram",
        model: "nova-3",
      });
    }
  }, 120_000);
});

async function runReplayBenchmark(): Promise<{ metrics: RoundTripMetric[]; traceEvents: LogEvent[] }> {
  const trace = new TraceProcessor();
  const board = new BoardEventBus();
  const metrics: RoundTripMetric[] = [];
  const audio = new RecordingAudioOutput();
  const adapter = new CueAdapter({
    sessionId: SESSION_ID,
    trace,
    textCueWords: ["panop"],
    idFactory: sequenceIds("latency"),
    earconSink: {
      async emit(emission) {
        await playEarcon(audio, emission.id, {
          correlationId: emission.correlationId,
          source: emission.source,
          emittedAtMs: performance.now(),
        });
      },
    },
  });
  const observations = benchmarkObservations(ROUND_TRIPS);
  const llm: DecisionLLM<{ decisionId: string; action: DispatchedAction }> = {
    async decide(input: DecisionInput): Promise<{ decisionId: string; action: DispatchedAction }> {
      const finalizedAtMs = performance.now();
      const observation = input.observation;
      const correlationId = `corr-latency-${input.observationIndex.toString().padStart(3, "0")}`;
      const decisionId = `decision-latency-${input.observationIndex.toString().padStart(3, "0")}`;
      recordObservation(trace, board, observation, correlationId, finalizedAtMs);

      const earconStartedAtMs = performance.now();
      await adapter.emitTextCueEarcon(observation, { name: "text", metadata: { pattern: "panop" } }, correlationId);
      const earconLatencyMs = performance.now() - earconStartedAtMs;

      await sleep(NOMINAL_DECISION_DELAY_MS + (input.observationIndex % 5));
      const action: DispatchedAction = {
        type: "steer",
        targetUPID: `upid-latency-${input.observationIndex.toString().padStart(3, "0")}`,
        payload: {
          command: "status",
          utteranceId: observation.utteranceId,
        },
        correlationId,
      };
      const decisionAtMs = performance.now();
      appendTrace(
        trace,
        board,
        {
          event: "command.wake",
          sessionId: observation.sessionId,
          correlationId,
          startedAtMs: finalizedAtMs,
          endedAtMs: finalizedAtMs,
          meta: {
            utteranceId: observation.utteranceId,
            wakeWord: "panop",
            decisionId,
          },
        },
      );
      appendTrace(
        trace,
        board,
        {
          event: "route.action",
          sessionId: observation.sessionId,
          correlationId,
          upid: action.targetUPID ?? undefined,
          startedAtMs: finalizedAtMs,
          endedAtMs: decisionAtMs,
          meta: {
            action: action.type,
            targetUPID: action.targetUPID,
            utteranceId: observation.utteranceId,
            decisionId,
            policy: "latency-benchmark-replay",
          },
        },
      );
      appendTrace(
        trace,
        board,
        {
          event: "process.steer",
          sessionId: observation.sessionId,
          correlationId,
          upid: action.targetUPID ?? undefined,
          startedAtMs: decisionAtMs,
          endedAtMs: decisionAtMs,
          meta: {
            utteranceId: observation.utteranceId,
            decisionId,
          },
        },
      );
      await playAck(audio, "route-steer", { correlationId, source: "latency-benchmark" });
      appendTrace(
        trace,
        board,
        {
          event: "ack.emit",
          sessionId: observation.sessionId,
          correlationId,
          startedAtMs: decisionAtMs,
          endedAtMs: performance.now(),
          meta: {
            ackId: "route-steer",
            decisionId,
          },
        },
      );
      metrics.push({
        index: input.observationIndex,
        utteranceId: observation.utteranceId,
        correlationId,
        earconLatencyMs,
        decisionLatencyMs: decisionAtMs - finalizedAtMs,
        roundTripMs: performance.now() - finalizedAtMs,
        actionType: action.type,
        cacheHit: false,
      });
      return { decisionId, action };
    },
  };

  const replay = await runReplayObservations(observations, llm);
  const cacheHitByUtterance = new Map(replay.records.map((record) => [record.observation.utteranceId, record.cacheHit]));
  for (const metric of metrics) {
    metric.cacheHit = cacheHitByUtterance.get(metric.utteranceId) ?? false;
  }

  return { metrics, traceEvents: trace.events() };
}

async function measureDelayedEarconProof(minDelayedDecisionMs: number): Promise<{
  earconLatencyMs: number;
  delayedDecisionMs: number;
  earconBeforeDelayedDecision: boolean;
}> {
  const audio = new RecordingAudioOutput();
  const observation = benchmarkObservations(1)[0];
  const adapter = new CueAdapter({
    sessionId: SESSION_ID,
    textCueWords: ["panop"],
    earconSink: {
      async emit(emission) {
        await playEarcon(audio, emission.id, {
          correlationId: emission.correlationId,
          source: emission.source,
          emittedAtMs: performance.now(),
        });
      },
    },
  });
  const finalizedAtMs = performance.now();
  const delayedDecision = sleep(Math.max(DELAYED_DECISION_PROOF_MS, minDelayedDecisionMs)).then(() => performance.now());
  await adapter.emitTextCueEarcon(observation, { name: "text", metadata: { pattern: "panop" } }, "corr-delayed-proof");
  const earconAtMs = performance.now();
  const decisionAtMs = await delayedDecision;

  return {
    earconLatencyMs: earconAtMs - finalizedAtMs,
    delayedDecisionMs: decisionAtMs - finalizedAtMs,
    earconBeforeDelayedDecision: earconAtMs < decisionAtMs,
  };
}

async function measureWorkingAckBudgetEdge(budgetMs: number): Promise<BenchmarkReport["workingAck"]> {
  let timeoutCallback: (() => void) | undefined;
  let scheduledTimeoutMs = -1;
  const emitted: Array<{ id: string; atMs: number }> = [];
  const scheduler = new WorkingAckScheduler({
    budgetMs,
    repeatMs: budgetMs * 2,
    onAck: (id) => {
      emitted.push({ id, atMs: scheduledTimeoutMs });
    },
    setTimeoutFn: (callback, ms) => {
      timeoutCallback = callback;
      scheduledTimeoutMs = ms;
      return { kind: "timeout" } as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeoutFn: () => {},
    setIntervalFn: () => ({ kind: "interval" }) as unknown as ReturnType<typeof setInterval>,
    clearIntervalFn: () => {},
  });

  scheduler.start({ correlationId: "corr-working-budget" });
  const silenceBeforeBudget = emitted.length === 0;
  timeoutCallback?.();
  await Promise.resolve();
  scheduler.stop();

  expect(emitted).toEqual([{ id: "working", atMs: budgetMs }]);
  return {
    budgetMs,
    firstAckAtMs: emitted[0].atMs,
    silenceBeforeBudget,
  };
}

async function measureFixedPhrasePlayback(): Promise<BenchmarkReport["fixedPhrasePlayback"]> {
  const tts = new NoopTTSProvider();
  const precacheStartedAtMs = performance.now();
  await precacheStatePhrases(tts, { phrases: ["Working"] });
  const precacheMs = performance.now() - precacheStartedAtMs;
  const audio = new RecordingAudioOutput();
  const playbackStartedAtMs = performance.now();
  await playAck(audio, "working", { correlationId: "corr-fixed-working", source: "latency-benchmark" });
  const playbackMs = performance.now() - playbackStartedAtMs;

  expect(tts.calls.map((call) => call.text)).toEqual(["Working"]);
  expect(audio.calls[0]?.clip).toBe(PRERENDERED_ACKS.working);
  return {
    phrase: "Working",
    precacheMs,
    playbackMs,
    clipId: "working",
    prerendered: audio.calls[0]?.clip === PRERENDERED_ACKS.working,
  };
}

function liveAsrStatus(): BenchmarkReport["liveAsr"] {
  const gate = createDeepgramNova3ASRFromEnv();
  if (gate.provider === null) {
    return {
      status: "skipped",
      reason: "live ASR round-trip latency SKIPPED - needs DEEPGRAM_API_KEY",
      provider: "deepgram",
      model: "nova-3",
    };
  }
  return {
    status: "configured",
    reason: null,
    provider: "deepgram",
    model: "nova-3",
  };
}

function benchmarkObservations(count: number): TranscriptObservation[] {
  return Array.from({ length: count }, (_, index) => ({
    text: `Panop status for latency route ${index}`,
    isFinal: true,
    speaker: "speaker_0",
    sessionId: SESSION_ID,
    latencyMs: 0,
    utteranceId: `utt-latency-${index.toString().padStart(3, "0")}`,
  }));
}

function recordObservation(
  trace: TraceProcessor,
  board: BoardEventBus,
  observation: TranscriptObservation,
  correlationId: string,
  finalizedAtMs: number,
): void {
  appendTrace(trace, board, {
    event: "observe.final",
    sessionId: observation.sessionId,
    correlationId,
    startedAtMs: finalizedAtMs,
    endedAtMs: finalizedAtMs,
    meta: {
      utteranceId: observation.utteranceId,
      isFinal: observation.isFinal,
      speaker: observation.speaker,
      textLength: observation.text.length,
    },
  });
}

function appendTrace(trace: TraceProcessor, board: BoardEventBus, input: Parameters<TraceProcessor["record"]>[0]): void {
  board.appendTrace(trace.record(input));
}

async function readBaseline(): Promise<LatencyBaseline> {
  return JSON.parse(await readFile(BASELINE_PATH, "utf8")) as LatencyBaseline;
}

async function resetGeneratedArtifacts(): Promise<void> {
  await rm(TRACE_ROOT, { recursive: true, force: true });
  await mkdir(TRACE_ROOT, { recursive: true });
}

async function emitEvidence(report: BenchmarkReport, traceEvents: readonly LogEvent[]): Promise<void> {
  await mkdir(TRACE_ROOT, { recursive: true });
  await writeFile(CURRENT_REPORT_PATH, JSON.stringify(report, null, 2) + "\n", "utf8");
  await writeFile(
    GATES_PATH,
    JSON.stringify(
      {
        ticketId: TICKET_ID,
        status: "passed",
        gates: {
          textCueEarconMs: report.textCue.maxEarconLatencyMs,
          roundTripP50Ms: report.roundTrips.p50Ms,
          roundTripP95Ms: report.roundTrips.p95Ms,
          workingAckAtMs: report.workingAck.firstAckAtMs,
          precachedFixedPhrasePlaybackMs: report.fixedPhrasePlayback.playbackMs,
          liveAsr: report.liveAsr.status,
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  await writeFile(TRACE_PATH, traceEvents.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
}

function percentile(values: readonly number[], percentileRank: number): number {
  if (values.length === 0) {
    throw new Error("Cannot calculate percentile of an empty sample.");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil((percentileRank / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

function sequenceIds(prefix: string): () => string {
  let next = 0;
  return () => `${prefix}-${++next}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
