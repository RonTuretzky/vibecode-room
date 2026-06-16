import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { runProbe, type ProbeAssertion } from "../../poc/harness";
import { TraceProcessor } from "../../src/obs/trace";
import { readTranscriptObservationJsonl } from "../../src/replay/jsonl";
import { runReplayObservations } from "../../src/replay/harness";
import { scanSecretLikeFiles } from "../../src/security/secrets";
import { transcriptObservationSchema, type TranscriptObservation } from "../../src/types";
import {
  DeepgramNova3ASRProvider,
  createDeepgramNova3ASRFromEnv,
  normalizeDeepgramMessage,
} from "../../src/providers/asr/deepgram";
import type { AudioReadableStream } from "../../src/providers";

const PROBE_ID = "probe-asr-deepgram";
const SESSION_ID = "probe-asr-deepgram-fixture";
const PROBE_ROOT = `artifacts/smithering/probes/${PROBE_ID}`;
const BUILD_ROOT = `artifacts/smithering/build/${PROBE_ID}`;
const TRACE_ROOT = `${BUILD_ROOT}/trace`;
const TRACE_PATH = `${TRACE_ROOT}/asr-deepgram.jsonl`;
const REPORT_ROOT = "artifacts/smithering/reports";
const RAW_FIXTURE_PATH = "fixtures/asr/nova3-raw.jsonl";
const OBSERVATION_FIXTURE_PATH = "fixtures/asr/nova3-observations.jsonl";
const ROUND_1_LATENCY_EVIDENCE = "artifacts/smithering/probes/assumption-stt-realtime-latency/";
const WORD_FINAL_BUDGET_MS = 200;

interface RawFixtureRecord {
  streamStartedAtMs: number;
  receivedAtMs: number;
  message: unknown;
}

interface ProbeVerdict {
  ticketId: typeof PROBE_ID;
  status: "passed" | "failed";
  liveDeepgram: {
    status: "skipped" | "validated";
    reason: string | null;
    provider: "deepgram";
    model: "nova-3";
  };
  fallback: string;
  replay: {
    fixture: string;
    observations: number;
    finals: number;
    speakers: string[];
    silenceObservations: number;
    maxWordFinalLatencyMs: number;
    deterministicDecisionIds: string[];
  };
  evidence: {
    trace: string;
    report: string;
    normalizedObservations: string;
    round1LatencyReference: string;
    round1Present: boolean;
  };
}

describe("P-ASR Deepgram Nova-3 probe", () => {
  test("replay contract passes without a Deepgram key and live socket is gated by DEEPGRAM_API_KEY", async () => {
    await rm(PROBE_ROOT, { recursive: true, force: true });
    await rm(BUILD_ROOT, { recursive: true, force: true });
    await mkdir(PROBE_ROOT, { recursive: true });
    await mkdir(TRACE_ROOT, { recursive: true });

    let replaySummary: ProbeVerdict["replay"] | null = null;
    let liveStatus: ProbeVerdict["liveDeepgram"] = {
      status: "skipped",
      reason: "live Deepgram validation SKIPPED - requires DEEPGRAM_API_KEY",
      provider: "deepgram",
      model: "nova-3",
    };

    const assertions: ProbeAssertion[] = [
      {
        id: "nova3-websocket-shape",
        behavior: "the live adapter targets Deepgram Nova-3 streaming WebSocket with interim results, endpointing, and streaming diarization",
        falsify: () => {
          const provider = new DeepgramNova3ASRProvider({ apiKey: "dg_placeholdertoken000000", sessionId: SESSION_ID });
          expect(provider.connectionUrl()).toContain("model=nova-2");
        },
        run: () => {
          const provider = new DeepgramNova3ASRProvider({ apiKey: "dg_placeholdertoken000000", sessionId: SESSION_ID });
          const url = new URL(provider.connectionUrl());
          expect(url.origin + url.pathname).toBe("wss://api.deepgram.com/v1/listen");
          expect(url.searchParams.get("model")).toBe("nova-3");
          expect(url.searchParams.get("interim_results")).toBe("true");
          expect(url.searchParams.get("endpointing")).toBe("300");
          expect(url.searchParams.get("diarize_model")).toBe("v1");
        },
      },
      {
        id: "is-final-shape-and-timing",
        behavior: "Deepgram is_final is normalized to boolean isFinal and final frames remain under the word-final latency budget",
        falsify: () => {
          normalizeDeepgramMessage(
            { type: "Results", is_final: "true", channel: { alternatives: [{ transcript: "bad", words: [] }] } },
            normalizeOptions(0, 1_000, 0),
          );
        },
        run: async () => {
          const observations = await normalizeRawFixture();
          expect(observations.some((observation) => !observation.isFinal)).toBe(true);
          const finals = observations.filter((observation) => observation.isFinal);
          expect(finals.length).toBeGreaterThan(0);
          expect(Math.max(...finals.map((observation) => observation.latencyMs))).toBeLessThan(WORD_FINAL_BUDGET_MS);
        },
      },
      {
        id: "speaker-label-format",
        behavior: "Deepgram diarization words are exposed as speaker_0 and speaker_1 labels on transcript observations",
        falsify: () => {
          assertSpeakerLabels([{ ...observation("bad", "utt-bad"), speaker: "speaker-0" }]);
        },
        run: async () => {
          const observations = await normalizeRawFixture();
          assertSpeakerLabels(observations);
          expect(new Set(observations.map((observation) => observation.speaker))).toEqual(new Set(["speaker_0", "speaker_1"]));
        },
      },
      {
        id: "silence-no-observation",
        behavior: "silence produces no TranscriptObservation rather than an empty observation",
        falsify: () => {
          assertNoSilenceObservations([observation("", "utt-empty")]);
        },
        run: async () => {
          const silence = await normalizeSilenceFixture();
          expect(silence).toEqual([]);
          assertNoSilenceObservations(await normalizeRawFixture());
        },
      },
      {
        id: "two-speaker-overlap",
        behavior: "a two-speaker overlap frame is split into observations for both diarized speakers",
        falsify: () => {
          assertTwoSpeakerOverlap([observation("I can take notes.", "utt-one")]);
        },
        run: async () => {
          assertTwoSpeakerOverlap(await normalizeRawFixture());
        },
      },
      {
        id: "record-replay-determinism",
        behavior: "record-replay over transcript observations produces deterministic decisionIds without a live socket",
        falsify: async () => {
          const observations = await readTranscriptObservationJsonl(OBSERVATION_FIXTURE_PATH);
          const first = await replayDecisionIds(observations, "nondeterministic-a");
          const second = await replayDecisionIds(observations, "nondeterministic-b");
          expect(first).toEqual(second);
        },
        run: async () => {
          const observations = await readTranscriptObservationJsonl(OBSERVATION_FIXTURE_PATH);
          const first = await replayDecisionIds(observations, "stable");
          const second = await replayDecisionIds(observations, "stable");
          expect(first).toEqual(second);
          await writeReplayEvidence(observations);
        },
      },
      {
        id: "live-deepgram-gate",
        behavior: "live Deepgram Nova-3 validation is skipped without DEEPGRAM_API_KEY and runs through the real adapter when present",
        falsify: () => {
          const gate = createDeepgramNova3ASRFromEnv({});
          expect(gate.skippedReason).toBeNull();
        },
        run: async () => {
          liveStatus = await runLiveGate();
        },
      },
      {
        id: "report-secret-scan",
        behavior: "probe artifacts contain no key-shaped strings",
        falsify: async () => {
          const scan = await scanSecretLikeFiles(PROBE_ROOT);
          expect(scan.findings.length + 1).toBe(0);
        },
        run: async () => {
          const reportScan = await scanSecretLikeFiles(join(REPORT_ROOT, PROBE_ID));
          const probeScan = await scanSecretLikeFiles(PROBE_ROOT);
          expect(reportScan.findings).toEqual([]);
          expect(probeScan.findings).toEqual([]);
        },
      },
    ];

    try {
      const observations = await normalizeRawFixture();
      replaySummary = await summarizeReplay(observations);
      await emitTrace(observations);
      await writeNormalizedObservations(observations);

      const report = await runProbe({
        probeId: PROBE_ID,
        assertions,
        reportRoot: REPORT_ROOT,
        cleanReportDir: true,
        correlationId: "p-asr-deepgram-nova3",
        meta: {
          liveDeepgram: liveStatus,
          fallback: fallbackStatement(),
          replayFixture: OBSERVATION_FIXTURE_PATH,
          round1LatencyReference: ROUND_1_LATENCY_EVIDENCE,
        },
      });

      await writeVerdict({
        ticketId: PROBE_ID,
        status: "passed",
        liveDeepgram: liveStatus,
        fallback: fallbackStatement(),
        replay: replaySummary,
        evidence: evidence(report.reportDir),
      });
      await assertProbeArtifactsClean();
    } catch (error) {
      await writeVerdict({
        ticketId: PROBE_ID,
        status: "failed",
        liveDeepgram: liveStatus,
        fallback: fallbackStatement(),
        replay: replaySummary ?? (await summarizeReplay(await normalizeRawFixture())),
        evidence: evidence(join(REPORT_ROOT, PROBE_ID)),
      });
      throw error;
    }
  }, 120_000);
});

async function normalizeRawFixture(): Promise<TranscriptObservation[]> {
  const records = await readRawFixture();
  const observations = records.flatMap((record, sequence) =>
    normalizeDeepgramMessage(record.message, normalizeOptions(record.streamStartedAtMs, record.receivedAtMs, sequence)),
  );
  return observations.map((entry) => transcriptObservationSchema.parse(entry));
}

async function normalizeSilenceFixture(): Promise<TranscriptObservation[]> {
  const records = await readRawFixture();
  const silence = records.find((record) => {
    const message = record.message as { request_id?: unknown };
    return message.request_id === "fixture-silence";
  });
  if (silence === undefined) {
    throw new Error("missing silence fixture");
  }
  return normalizeDeepgramMessage(silence.message, normalizeOptions(silence.streamStartedAtMs, silence.receivedAtMs, 0));
}

async function readRawFixture(): Promise<RawFixtureRecord[]> {
  const text = await readFile(RAW_FIXTURE_PATH, "utf8");
  return text
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RawFixtureRecord);
}

function normalizeOptions(streamStartedAtMs: number, receivedAtMs: number, sequence: number) {
  return { sessionId: SESSION_ID, streamStartedAtMs, receivedAtMs, sequence };
}

function assertSpeakerLabels(observations: TranscriptObservation[]): void {
  const speakers = observations.map((entry) => entry.speaker).filter((speaker): speaker is string => speaker !== null);
  expect(speakers.length).toBeGreaterThan(0);
  for (const speaker of speakers) {
    expect(speaker).toMatch(/^speaker_[01]$/u);
  }
}

function assertNoSilenceObservations(observations: TranscriptObservation[]): void {
  expect(observations.some((entry) => entry.text.trim().length === 0)).toBe(false);
}

function assertTwoSpeakerOverlap(observations: TranscriptObservation[]): void {
  const overlap = observations.filter((entry) => entry.utteranceId.startsWith("asr-fixture-overlap-"));
  expect(overlap.map((entry) => entry.speaker).sort()).toEqual(["speaker_0", "speaker_1"]);
  expect(overlap.every((entry) => entry.isFinal)).toBe(true);
}

async function replayDecisionIds(observations: TranscriptObservation[], mode: "stable" | "nondeterministic-a" | "nondeterministic-b"): Promise<string[]> {
  const result = await runReplayObservations(observations, {
    decide(input) {
      const suffix = mode === "stable" ? input.observation.utteranceId : `${input.observation.utteranceId}-${mode}`;
      return { decisionId: `decision-${suffix}` };
    },
  });
  return result.records.map((record) => String((record.output as { decisionId: string }).decisionId));
}

async function writeReplayEvidence(observations: TranscriptObservation[]): Promise<void> {
  const result = await runReplayObservations(observations, {
    decide(input) {
      return { decisionId: `decision-${input.observation.utteranceId}` };
    },
  });
  const lines = result.records.map((record, index) =>
    JSON.stringify({
      index,
      utteranceId: record.observation.utteranceId,
      cacheHit: record.cacheHit,
      decisionId: String((record.output as { decisionId: string }).decisionId),
    }),
  );
  await writeFile(join(BUILD_ROOT, "replay-summary.jsonl"), lines.join("\n") + "\n", "utf8");
}

async function summarizeReplay(observations: TranscriptObservation[]): Promise<ProbeVerdict["replay"]> {
  const decisionIds = await replayDecisionIds(observations, "stable");
  return {
    fixture: OBSERVATION_FIXTURE_PATH,
    observations: observations.length,
    finals: observations.filter((entry) => entry.isFinal).length,
    speakers: [...new Set(observations.map((entry) => entry.speaker).filter((speaker): speaker is string => speaker !== null))].sort(),
    silenceObservations: observations.filter((entry) => entry.text.trim().length === 0).length,
    maxWordFinalLatencyMs: Math.max(...observations.map((entry) => entry.latencyMs)),
    deterministicDecisionIds: decisionIds,
  };
}

async function emitTrace(observations: TranscriptObservation[]): Promise<void> {
  const trace = new TraceProcessor({ clock: () => 1_000 });
  for (const [seq, observation] of observations.entries()) {
    trace.record({
      event: "observe.asr",
      sessionId: observation.sessionId,
      correlationId: `corr-${observation.utteranceId}`,
      startedAtMs: 1_000 - observation.latencyMs,
      endedAtMs: 1_000,
      meta: {
        seq,
        provider: "deepgram",
        model: "nova-3",
        utteranceId: observation.utteranceId,
        isFinal: observation.isFinal,
        speaker: observation.speaker,
        latencyMs: observation.latencyMs,
        textLength: observation.text.length,
      },
    });
  }
  await writeFile(TRACE_PATH, trace.toJsonl() + "\n", "utf8");
}

async function writeNormalizedObservations(observations: TranscriptObservation[]): Promise<void> {
  await writeFile(
    join(PROBE_ROOT, "normalized-observations.jsonl"),
    observations.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    "utf8",
  );
}

async function runLiveGate(): Promise<ProbeVerdict["liveDeepgram"]> {
  const gate = createDeepgramNova3ASRFromEnv();
  if (gate.provider === null) {
    await writeFile(join(PROBE_ROOT, "live-skip.json"), JSON.stringify({ status: "skipped", reason: gate.skippedReason }, null, 2) + "\n", "utf8");
    return {
      status: "skipped",
      reason: gate.skippedReason,
      provider: "deepgram",
      model: "nova-3",
    };
  }

  const audioPath = process.env.PANOP_ASR_DEEPGRAM_AUDIO_FIXTURE;
  if (audioPath === undefined || audioPath.length === 0) {
    throw new Error("DEEPGRAM_API_KEY is set, so live validation requires PANOP_ASR_DEEPGRAM_AUDIO_FIXTURE with linear16 16kHz mono audio.");
  }

  const observations: TranscriptObservation[] = [];
  for await (const observation of gate.provider.stream(fileAudioStream(audioPath))) {
    observations.push(observation);
  }

  expect(observations.length).toBeGreaterThan(0);
  expect(observations.some((entry) => entry.isFinal)).toBe(true);
  assertNoSilenceObservations(observations);
  assertSpeakerLabels(observations);
  expect(Math.max(...observations.filter((entry) => entry.isFinal).map((entry) => entry.latencyMs))).toBeLessThan(WORD_FINAL_BUDGET_MS);

  await writeFile(
    join(PROBE_ROOT, "live-validation.json"),
    JSON.stringify({ status: "validated", observations: observations.length, maxLatencyMs: Math.max(...observations.map((entry) => entry.latencyMs)) }, null, 2) + "\n",
    "utf8",
  );
  return { status: "validated", reason: null, provider: "deepgram", model: "nova-3" };
}

function fileAudioStream(path: string): AudioReadableStream {
  return Bun.file(path).stream() as AudioReadableStream;
}

function fallbackStatement(): string {
  return "If Deepgram diarization is unavailable, the observation layer remains redesignable without speaker labels by deriving turn boundaries from energy/VAD and emitting TranscriptObservation.speaker as null.";
}

function evidence(reportDir: string): ProbeVerdict["evidence"] {
  return {
    trace: TRACE_PATH,
    report: `${reportDir}/report.json`,
    normalizedObservations: `${PROBE_ROOT}/normalized-observations.jsonl`,
    round1LatencyReference: ROUND_1_LATENCY_EVIDENCE,
    round1Present: false,
  };
}

async function writeVerdict(verdict: ProbeVerdict): Promise<void> {
  await writeFile(join(PROBE_ROOT, "verdict.json"), JSON.stringify(verdict, null, 2) + "\n", "utf8");
}

async function assertProbeArtifactsClean(): Promise<void> {
  const scans = await Promise.all([PROBE_ROOT, BUILD_ROOT, join(REPORT_ROOT, PROBE_ID)].map((root) => scanSecretLikeFiles(root)));
  expect(scans.flatMap((scan) => scan.findings)).toEqual([]);
}

function observation(text: string, utteranceId: string): TranscriptObservation {
  return {
    text,
    isFinal: true,
    speaker: "speaker_0",
    sessionId: SESSION_ID,
    latencyMs: 25,
    utteranceId,
  };
}
