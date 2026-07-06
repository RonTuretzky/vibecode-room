import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { createProjectorRuntime, type ProjectorRuntime } from "./composition";
import { NoopTTSProvider } from "../providers";
import { demoProjectorSnapshot } from "../ui/demo-data";
import type { CanonicalStage } from "../spine/stage-sequencer";
import type { TranscriptObservation } from "../types";
import { AFFIRMATION, AFFIRMATION_UTTERANCE_ID, buildBuildableOnlyScript, writeLoopScriptFixture, serializeLoopScript } from "../../test/e2e/fixtures/loop-script";

// Integration: a buildable utterance is DETECTED into a grounded idea bubble, and
// a spoken affirmation accepts it (-> spawn -> spoken ack). The PUBLISHED projector
// snapshot reflects the full outcome across the two phases, alongside the canonical
// stage transitions ACTIVE_LISTEN -> SUGGESTION_DELIVERY -> SPAWN -> ACK -> IDLE.

describe("LiveProjectorRuntime — composition loop snapshot reflects detect -> spawn -> speak", () => {
  const tempDirs: string[] = [];
  let priorCapacityGuard: string | undefined;

  beforeEach(() => {
    priorCapacityGuard = process.env.VIBERSYN_RBG_DISABLE_CAPACITY_CHECK;
    process.env.VIBERSYN_RBG_DISABLE_CAPACITY_CHECK = "1";
  });

  afterEach(() => {
    if (priorCapacityGuard === undefined) {
      delete process.env.VIBERSYN_RBG_DISABLE_CAPACITY_CHECK;
    } else {
      process.env.VIBERSYN_RBG_DISABLE_CAPACITY_CHECK = priorCapacityGuard;
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir !== undefined) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test("the published snapshot shows the detected idea, the spawned process, and lastSpoken", async () => {
    const path = writeLoopScriptFixture(buildBuildableOnlyScript(), tempDirs);
    const runtime = await createProjectorRuntime(loopEnv(path));
    const processCountBefore = runtime.snapshot().processes.length;

    let published = runtime.snapshot();
    const unsubscribe = runtime.subscribe((snapshot) => {
      published = snapshot;
    });

    // Phase 1: the buildable utterance is detected → a grounded idea bubble.
    await driveFixture(runtime, path, buildBuildableOnlyScript());
    expect(runtime.detection.primary()).not.toBeNull();
    expect(published.suggestion.state).toBe("queued");
    expect(published.suggestion.pitch.length).toBeGreaterThan(0);
    expect(published.suggestion.contextSpan?.quote.length ?? 0).toBeGreaterThan(0);
    expect(published.suggestion).not.toEqual(demoProjectorSnapshot.suggestion);

    // Phase 2: the spoken affirmation accepts it → spawn → spoken ack.
    await driveFixture(runtime, path, [affirmation()]);
    unsubscribe();

    expect(published.processes.length).toBe(processCountBefore + 1);
    expect(runtime.registry.activeRecords().length).toBe(processCountBefore + 1);
    expect(published.audio.lastSpoken).toContain("spawned");
    expect(published.audio.earcon).toBe("E3");

    // The canonical stage transitions ran in order across the two phases.
    const stages = runtime.stageSequencer.transitions().map((transition) => transition.to);
    expect(stages).toEqual<CanonicalStage[]>(["ACTIVE_LISTEN", "SUGGESTION_DELIVERY", "SPAWN", "ACK", "IDLE"]);

    expect(runtime.tts).toBeInstanceOf(NoopTTSProvider);
    const spoken = (runtime.tts as NoopTTSProvider).calls.map((call) => call.text);
    expect(spoken.length).toBeGreaterThanOrEqual(2);
    expect(spoken.some((text) => text.includes("spawned"))).toBe(true);
  });
});

function loopEnv(replayPath: string): Record<string, string> {
  return {
    VIBERSYN_INITIAL_MUTED: "0",
    VIBERSYN_MIC_REPLAY_PATH: replayPath,
    VIBERSYN_IDEA_DETECTOR: "heuristic",
    VIBERSYN_DETECT_MIN_NEW_TURNS: "1",
    VIBERSYN_DETECT_MIN_INTERVAL_MS: "0",
    VIBERSYN_DETECT_TICK_MS: "0",
  };
}

function affirmation(): TranscriptObservation {
  return { text: AFFIRMATION, isFinal: true, speaker: "Room", sessionId: "loop-composition-e2e", latencyMs: 20, utteranceId: AFFIRMATION_UTTERANCE_ID };
}

async function driveFixture(runtime: ProjectorRuntime, path: string, obs: TranscriptObservation[]): Promise<void> {
  writeFileSync(path, serializeLoopScript(obs), "utf8");
  const session = runtime.startMicSession("corr-loop-snapshot");
  await session.stop();
  await runtime.detection.flush();
}
