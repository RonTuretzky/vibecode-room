import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectorRuntime, type ProjectorRuntime } from "./composition";
import type { TranscriptObservation } from "../types";
import { demoProjectorSnapshot } from "../ui/demo-data";

// ISSUE-0008: live FINAL observations must reach SuggestionEngine.observe with a
// real (heuristic-by-default) decider; interim partials must not drive the engine.

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("LiveProjectorRuntime — live final observations drive the SuggestionEngine", () => {
  test("ingestTranscript forwards only final observations to the engine (spy)", async () => {
    const path = writeReplayFixture([
      interim("let's build", "utt-1"),
      interim("let's build a dashboard", "utt-1"),
      final("let's build a dashboard tool to ship the prototype", "utt-1"),
      interim("and we should", "utt-2"),
      final("and we should deploy the api service today", "utt-2"),
    ]);
    const runtime = await createProjectorRuntime(baseEnv(path));
    const observeSpy = spyOn(runtime.suggestionEngine, "observe");

    await driveMic(runtime);

    // Two finals in the fixture → exactly two observe() calls, both final.
    expect(observeSpy.mock.calls.length).toBe(2);
    for (const call of observeSpy.mock.calls) {
      expect(call[0]?.observation.isFinal).toBe(true);
    }
  });

  test("live runtime queues/fires a suggestion from a buildable utterance (integration)", async () => {
    const path = writeReplayFixture([
      final("let's build a dashboard tool to ship the replay prototype today", "utt-build"),
    ]);
    const runtime = await createProjectorRuntime(baseEnv(path));

    await driveMic(runtime);

    const events = runtime.trace.events().map((event) => event.event);
    expect(events.some((event) => event === "suggestion.queued" || event === "route.suggestion")).toBe(true);
    const decision = runtime.lastSuggestionDecision;
    if (decision === null) {
      throw new Error("expected a suggestion decision from a buildable utterance");
    }
    expect(["queued", "fired"]).toContain(decision.kind);
  });

  test("a non-buildable utterance passes with no queued suggestion (integration)", async () => {
    const path = writeReplayFixture([
      final("the weather has been really nice and the coffee was good this morning", "utt-ambient"),
    ]);
    const runtime = await createProjectorRuntime(baseEnv(path));

    await driveMic(runtime);

    expect(runtime.lastSuggestionDecision?.kind).toBe("pass");
    expect(runtime.pendingSuggestion()).toBeNull();
    const events = runtime.trace.events().map((event) => event.event);
    expect(events.some((event) => event === "suggestion.queued" || event === "route.suggestion")).toBe(false);
  });
});

// ISSUE-0009: buildSnapshot.suggestion must reflect the live SuggestionEngine
// verdict (state/pitch/confidence/gate/questions) once a final has been scored,
// and keep the demo fixture before any live suggestion exists.
describe("LiveProjectorRuntime — snapshot.suggestion reflects live engine state", () => {
  test("before any live suggestion, the demo bubble is shown (fallback)", async () => {
    const path = writeReplayFixture([]);
    const runtime = await createProjectorRuntime(baseEnv(path));

    // No mic driven yet → no decision → demo fixture verbatim.
    expect(runtime.snapshot().suggestion).toEqual(demoProjectorSnapshot.suggestion);
    expect(runtime.lastSuggestionDecision).toBeNull();
  });

  test("a buildable utterance maps the fired/queued engine state into the bubble (unit)", async () => {
    const path = writeReplayFixture([
      final("let's build a dashboard tool to ship the replay prototype today", "utt-build"),
    ]);
    const runtime = await createProjectorRuntime(baseEnv(path));

    await driveMic(runtime);

    const decision = runtime.lastSuggestionDecision;
    if (decision === null) {
      throw new Error("expected a suggestion decision from a buildable utterance");
    }
    const suggestion = runtime.snapshot().suggestion;
    // fired -> "speaking", queued -> "queued"; never the demo "queued" pitch.
    const expectedState = decision.kind === "fired" ? "speaking" : "queued";
    expect(suggestion.state).toBe(expectedState);
    expect(suggestion.pitch.length).toBeGreaterThan(0);
    expect(suggestion).not.toEqual(demoProjectorSnapshot.suggestion);
    // Gate floors come from the engine config (WORD_FLOOR=3 in baseEnv), not the
    // static fixture (which uses minWords 60 / minSeconds 90).
    expect(suggestion.gate.minWords).toBe(3);
    expect(suggestion.gate.minSeconds).toBe(90);
    expect(suggestion.gate.words).toBeGreaterThanOrEqual(suggestion.gate.minWords);
    expect(suggestion.confidence).toBeGreaterThan(0);
  });

  test("a non-buildable (pass) utterance maps to an idle bubble with live gate counters (unit)", async () => {
    const path = writeReplayFixture([
      final("the weather has been really nice and the coffee was good this morning", "utt-ambient"),
    ]);
    const runtime = await createProjectorRuntime(baseEnv(path));

    await driveMic(runtime);

    expect(runtime.lastSuggestionDecision?.kind).toBe("pass");
    const suggestion = runtime.snapshot().suggestion;
    expect(suggestion.state).toBe("idle");
    expect(suggestion.questions).toEqual([]);
    // Gate counters come from the engine, not the demo fixture.
    expect(suggestion.gate.minWords).toBe(3);
    expect(suggestion.gate.words).toBeGreaterThan(0);
    expect(suggestion).not.toEqual(demoProjectorSnapshot.suggestion);
  });

  test("a subscriber's bubble transitions from demo -> live as observations arrive (integration)", async () => {
    const path = writeReplayFixture([
      final("let's build a dashboard tool to ship the replay prototype today", "utt-build"),
    ]);
    const runtime = await createProjectorRuntime(baseEnv(path));

    const states: string[] = [];
    const pitches: string[] = [];
    const unsubscribe = runtime.subscribe((snapshot) => {
      states.push(snapshot.suggestion.state);
      pitches.push(snapshot.suggestion.pitch);
    });

    // The very first push (on subscribe) is the demo bubble.
    expect(states[0]).toBe(demoProjectorSnapshot.suggestion.state);
    expect(pitches[0]).toBe(demoProjectorSnapshot.suggestion.pitch);

    await driveMic(runtime);
    unsubscribe();

    // After a buildable utterance, the latest published bubble is a live state.
    const finalSuggestion = runtime.snapshot().suggestion;
    expect(["queued", "speaking"]).toContain(finalSuggestion.state);
    expect(finalSuggestion.pitch).not.toBe(demoProjectorSnapshot.suggestion.pitch);
  });
});

function baseEnv(replayPath: string, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    // Start unmuted so the (mute-protected) replay mic actually streams.
    PANOP_INITIAL_MUTED: "0",
    PANOP_MIC_REPLAY_PATH: replayPath,
    // Lower the REQ-3 floors so a single short utterance is eligible, and zero the
    // interrupt weights so a buildable utterance fires deterministically.
    PANOP_SUGGEST_WORD_FLOOR: "3",
    PANOP_SUGGEST_INTERRUPT_VELOCITY_WEIGHT: "0",
    PANOP_SUGGEST_INTERRUPT_RECENCY_WEIGHT: "0",
    PANOP_SUGGEST_INTERRUPT_PENDING_STEERING_WEIGHT: "0",
    ...overrides,
  };
}

async function driveMic(runtime: ProjectorRuntime): Promise<void> {
  const session = runtime.startMicSession("corr-test-mic");
  // stop() awaits the background drain loop, so every replayed observation has
  // been fully processed (including the awaited engine.observe) once it resolves.
  await session.stop();
}

function writeReplayFixture(observations: TranscriptObservation[]): string {
  const dir = mkdtempSync(join(tmpdir(), "panop-mic-"));
  tempDirs.push(dir);
  const path = join(dir, "mic.jsonl");
  writeFileSync(path, observations.map((observation) => JSON.stringify(observation)).join("\n"), "utf8");
  return path;
}

function final(text: string, utteranceId: string): TranscriptObservation {
  return observation(text, true, utteranceId);
}

function interim(text: string, utteranceId: string): TranscriptObservation {
  return observation(text, false, utteranceId);
}

function observation(text: string, isFinal: boolean, utteranceId: string): TranscriptObservation {
  return { text, isFinal, speaker: "Room", sessionId: "test-session", latencyMs: 20, utteranceId };
}
