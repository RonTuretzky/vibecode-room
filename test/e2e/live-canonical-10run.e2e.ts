import { describe, expect, test } from "bun:test";
import { createDeepgramNova3ASRFromEnv } from "../../src/providers/asr/deepgram";
import type { AudioReadableStream } from "../../src/providers";
import { runCanonicalSpineScenario } from "../../src/spine/canonical";
import type { TranscriptObservation } from "../../src/types";

const LIVE_RUNS = 10;
const REQUIRED_PASSES = 9;
const LIVE_GATE_SKIP_REASON = "LIVE canonical scripted-audio gate skipped - requires DEEPGRAM_API_KEY";

interface LiveCanonicalRunResult {
  run: number;
  status: "passed" | "failed";
  cause: string | null;
  liveObservations: number;
  finalObservations: number;
  transcript: string[];
  canonicalCorrelationId: string | null;
}

// Enforcement: a release pipeline sets PANOP_REQUIRE_LIVE_GATE=1 so a missing
// credential FAILS loudly here instead of silently skipping (which a CI summary
// could misread as green). Without that flag, the gate honestly skips.
describe.skipIf(hasDeepgramCredential() || !liveGateRequired())("LIVE RELEASE GATE enforcement", () => {
  test("fails when PANOP_REQUIRE_LIVE_GATE=1 but DEEPGRAM_API_KEY is absent", () => {
    throw new Error(
      "Live canonical 10-run gate is REQUIRED (PANOP_REQUIRE_LIVE_GATE=1) but DEEPGRAM_API_KEY is absent, so the live stack was never exercised. Provide credentials + PANOP_ASR_DEEPGRAM_AUDIO_FIXTURE, or unset PANOP_REQUIRE_LIVE_GATE.",
    );
  });
});

// The live stack can only run with both a Deepgram credential and a scripted
// audio fixture. Without PANOP_REQUIRE_LIVE_GATE the gate honestly skips when
// either is missing; with it set, the gate runs and fails loudly below.
describe.skipIf(!liveGateRequired() && (!hasDeepgramCredential() || !hasAudioFixture()))("LIVE RELEASE GATE: canonical scripted-audio Deepgram stack", () => {
  test(
    "runs the canonical scenario against live scripted audio 10 times and requires at least 9 passes",
    async () => {
      const audioPath = process.env.PANOP_ASR_DEEPGRAM_AUDIO_FIXTURE;
      if (audioPath === undefined || audioPath.length === 0) {
        throw new Error(
          "DEEPGRAM_API_KEY is set, so the live canonical 10-run gate requires PANOP_ASR_DEEPGRAM_AUDIO_FIXTURE with canonical linear16 16kHz mono scripted audio.",
        );
      }

      const results: LiveCanonicalRunResult[] = [];
      for (let run = 1; run <= LIVE_RUNS; run += 1) {
        results.push(await runLiveCanonicalAttempt(run, audioPath));
      }

      console.info(JSON.stringify({ gate: "live-canonical-10run", requiredPasses: REQUIRED_PASSES, results }, null, 2));

      const passes = results.filter((result) => result.status === "passed").length;
      if (passes < REQUIRED_PASSES) {
        throw new Error(`Live canonical gate failed with ${passes}/${LIVE_RUNS} passes:\n${formatRunCauses(results)}`);
      }

      expect(passes).toBeGreaterThanOrEqual(REQUIRED_PASSES);
    },
    600_000,
  );
});

async function runLiveCanonicalAttempt(run: number, audioPath: string): Promise<LiveCanonicalRunResult> {
  const sessionId = `live-canonical-10run-${run.toString().padStart(2, "0")}`;
  const liveObservations: TranscriptObservation[] = [];

  try {
    const gate = createDeepgramNova3ASRFromEnv({
      ...process.env,
      PANOP_ASR_DEEPGRAM_SESSION_ID: sessionId,
    });
    if (gate.provider === null) {
      throw new Error(gate.skippedReason ?? LIVE_GATE_SKIP_REASON);
    }

    for await (const observation of gate.provider.stream(fileAudioStream(audioPath))) {
      liveObservations.push(observation);
    }

    const canonicalObservations = canonicalObservationsFromLiveTranscript(liveObservations, sessionId);
    const canonical = await runCanonicalSpineScenario({ sessionId, observations: canonicalObservations });

    expect(canonical.chain.complete).toBe(true);
    expect(canonical.chain.missingStages).toEqual([]);
    expect(canonical.chain.observation.map((event) => event.event)).toContain("observe.final");
    expect(canonical.chain.decision.map((event) => event.event)).toEqual(
      expect.arrayContaining(["command.wake", "route.suggestion", "route.acceptance"]),
    );
    expect(canonical.chain.action.map((event) => event.event)).toContain("process.spawn");
    expect(canonical.chain.outcome.map((event) => event.event)).toEqual(expect.arrayContaining(["ack.emit", "output.tts"]));

    return {
      run,
      status: "passed",
      cause: null,
      liveObservations: liveObservations.length,
      finalObservations: finalTranscript(liveObservations).length,
      transcript: finalTranscript(liveObservations).map((observation) => observation.text),
      canonicalCorrelationId: canonical.correlationId,
    };
  } catch (error) {
    return {
      run,
      status: "failed",
      cause: error instanceof Error ? error.message : String(error),
      liveObservations: liveObservations.length,
      finalObservations: finalTranscript(liveObservations).length,
      transcript: finalTranscript(liveObservations).map((observation) => observation.text),
      canonicalCorrelationId: null,
    };
  }
}

function canonicalObservationsFromLiveTranscript(observations: readonly TranscriptObservation[], sessionId: string): TranscriptObservation[] {
  const finals = finalTranscript(observations);
  const wakeIndex = finals.findIndex((observation) => /\bpanop\b/iu.test(observation.text));
  if (wakeIndex === -1) {
    throw new Error(`live transcript did not include the canonical wake word "Panop"; finals=${JSON.stringify(finals.map((entry) => entry.text))}`);
  }

  const accept = finals.slice(wakeIndex + 1).find((observation) => /\b(yes|yeah|yep|accept|confirm|proceed)\b/iu.test(observation.text));
  if (accept === undefined) {
    throw new Error(`live transcript did not include a canonical acceptance after wake; finals=${JSON.stringify(finals.map((entry) => entry.text))}`);
  }

  return [
    {
      ...finals[wakeIndex],
      sessionId,
      utteranceId: "utt-wake-build",
      isFinal: true,
    },
    {
      ...accept,
      sessionId,
      utteranceId: "utt-accept",
      isFinal: true,
    },
  ];
}

function finalTranscript(observations: readonly TranscriptObservation[]): TranscriptObservation[] {
  return observations.filter((observation) => observation.isFinal && observation.text.trim().length > 0);
}

function formatRunCauses(results: readonly LiveCanonicalRunResult[]): string {
  return results.map((result) => `run ${result.run}: ${result.status}${result.cause === null ? "" : ` - ${result.cause}`}`).join("\n");
}

function hasDeepgramCredential(): boolean {
  return process.env.DEEPGRAM_API_KEY !== undefined && process.env.DEEPGRAM_API_KEY.length > 0;
}

function liveGateRequired(): boolean {
  return process.env.PANOP_REQUIRE_LIVE_GATE === "1";
}

function hasAudioFixture(): boolean {
  const path = process.env.PANOP_ASR_DEEPGRAM_AUDIO_FIXTURE;
  return path !== undefined && path.length > 0;
}

function fileAudioStream(path: string): AudioReadableStream {
  return Bun.file(path).stream() as AudioReadableStream;
}
