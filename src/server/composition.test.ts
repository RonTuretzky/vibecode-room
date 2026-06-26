import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectorRuntime, type ProjectorRuntime } from "./composition";
import type { TranscriptObservation } from "../types";

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
    expect(runtime.lastSuggestionDecision).not.toBeNull();
    expect(["queued", "fired"]).toContain(runtime.lastSuggestionDecision?.kind);
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
