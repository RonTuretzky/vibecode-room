// ISSUE-0018 e2e: the wired path from a real-speech-shaped FINAL transcript,
// through SuggestionEngine.observe, to a populated snapshot.suggestion idea
// bubble — independent of the ASR backend. The runtime is driven entirely by an
// injected ASR source (an in-memory observation array), so there is no mic,
// child process, or socket, and the deterministic heuristic decider + Noop TTS
// keep the whole loop offline. Any network fetch fails the test.
//
// A buildable utterance must surface the idea bubble (pitch + lead question)
// within a couple of turns; a clearly non-buildable one must leave the bubble at
// the idle/demo baseline.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createProjectorRuntime } from "../../src/server/composition";
import { demoProjectorSnapshot } from "../../src/ui/demo-data";
import type { TranscriptObservation } from "../../src/types";

describe("spoken buildable idea surfaces the idea bubble (e2e)", () => {
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  let priorAsrProvider: string | undefined;
  let priorDeepgramKey: string | undefined;

  beforeEach(() => {
    fetchCalls = 0;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      fetchCalls += 1;
      throw new Error(`unexpected network fetch in the offline suggestion loop: ${String(args[0])}`);
    }) as unknown as typeof fetch;
    // The registry resolves the ASR backend off env, but the injected source makes
    // the backend irrelevant — isolate the test from any ambient settings anyway.
    priorAsrProvider = process.env.PANOP_ASR_PROVIDER;
    priorDeepgramKey = process.env.DEEPGRAM_API_KEY;
    delete process.env.PANOP_ASR_PROVIDER;
    delete process.env.DEEPGRAM_API_KEY;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    restoreEnv("PANOP_ASR_PROVIDER", priorAsrProvider);
    restoreEnv("DEEPGRAM_API_KEY", priorDeepgramKey);
  });

  test("a buildable FINAL transcript populates snapshot.suggestion (pitch + lead question)", async () => {
    const runtime = await createProjectorRuntime(suggestionEnv(), {
      replaySource: [
        final("let's build a dashboard tool to ship the replay prototype today", "utt-build"),
      ],
    });

    // Backend-independent: the injected source drives the runtime with no key and
    // no network — the heuristic decider scores the final offline.
    expect(runtime.tts.constructor.name).toBe("NoopTTSProvider");
    expect(runtime.snapshot().suggestion).toEqual(demoProjectorSnapshot.suggestion);

    await driveMic(runtime);

    // The buildable final went through SuggestionEngine.observe and fired: it is now
    // pending acceptance and the published idea bubble is live.
    const decision = runtime.lastSuggestionDecision;
    if (decision === null || decision.kind !== "fired") {
      throw new Error("expected the buildable final to fire a suggestion");
    }
    expect(runtime.acceptanceController.awaitingAcceptance()).toBe(true);

    const suggestion = runtime.snapshot().suggestion;
    expect(suggestion.state).toBe("speaking");
    expect(suggestion.pitch.length).toBeGreaterThan(0);
    expect(suggestion.pitch).toBe(decision.suggestion.pitch);
    // A lead question (aloud-answerable MCQ) accompanies the pitch.
    expect(suggestion.questions.length).toBeGreaterThan(0);
    expect(suggestion).not.toEqual(demoProjectorSnapshot.suggestion);

    // The gate counters came from the live engine config (WORD_FLOOR=3), not the
    // static demo fixture (minWords 60), and reflect real accumulated speech.
    expect(suggestion.gate.minWords).toBe(3);
    expect(suggestion.gate.words).toBeGreaterThanOrEqual(suggestion.gate.minWords);

    // The whole loop ran offline: no network fetch.
    expect(fetchCalls).toBe(0);
  });

  test("a clearly non-buildable utterance leaves snapshot.suggestion at the idle baseline", async () => {
    const runtime = await createProjectorRuntime(suggestionEnv(), {
      replaySource: [
        final("the weather has been really nice and the coffee was good this morning", "utt-ambient"),
      ],
    });

    await driveMic(runtime);

    // The ambient final was scored and passed: no suggestion fired, nothing pending,
    // and the idea bubble sits at the idle baseline (no pitch, no questions) — never
    // the live "speaking"/"queued" states a buildable utterance produces.
    expect(runtime.lastSuggestionDecision?.kind).toBe("pass");
    expect(runtime.pendingSuggestion()).toBeNull();
    const suggestion = runtime.snapshot().suggestion;
    expect(suggestion.state).toBe("idle");
    expect(suggestion.pitch).toBe("");
    expect(suggestion.questions).toEqual([]);

    expect(fetchCalls).toBe(0);
  });
});

function suggestionEnv(): Record<string, string> {
  return {
    // Start unmuted so the (mute-protected) replay source actually streams.
    PANOP_INITIAL_MUTED: "0",
    // Lower the REQ-3 floors so a single short utterance is eligible, and zero the
    // interrupt weights so a buildable utterance fires deterministically.
    PANOP_SUGGEST_WORD_FLOOR: "3",
    PANOP_SUGGEST_INTERRUPT_VELOCITY_WEIGHT: "0",
    PANOP_SUGGEST_INTERRUPT_RECENCY_WEIGHT: "0",
    PANOP_SUGGEST_INTERRUPT_PENDING_STEERING_WEIGHT: "0",
  };
}

async function driveMic(runtime: Awaited<ReturnType<typeof createProjectorRuntime>>): Promise<void> {
  const session = runtime.startMicSession("corr-suggestion-e2e");
  // stop() awaits the background drain loop, so every injected observation has been
  // fully processed (including the awaited engine.observe) once it resolves.
  await session.stop();
}

function final(text: string, utteranceId: string): TranscriptObservation {
  return { text, isFinal: true, speaker: "Room", sessionId: "test-session", latencyMs: 20, utteranceId };
}

function restoreEnv(key: string, prior: string | undefined): void {
  if (prior === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = prior;
  }
}
