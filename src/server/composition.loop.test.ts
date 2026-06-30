import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { createProjectorRuntime, type ProjectorRuntime } from "./composition";
import { NoopTTSProvider } from "../providers";
import { demoProjectorSnapshot } from "../ui/demo-data";
import type { CanonicalStage } from "../spine/stage-sequencer";
import { buildLoopScript, writeLoopScriptFixture } from "../../test/e2e/fixtures/loop-script";

// ISSUE-0015 (integration): after the buildable + affirmation sequence drives the
// live composition loop, the PUBLISHED projector snapshot must reflect the full
// outcome — a fired suggestion bubble, the newly spawned process, and the spoken
// confirmation as lastSpoken — alongside the canonical stage transitions. This is
// the snapshot-side companion to the e2e trace assertions; it would fail against
// the pre-wiring runtime, which never fired/spawned/spoke off the live loop.

describe("LiveProjectorRuntime — composition loop snapshot reflects fire -> spawn -> speak", () => {
  const tempDirs: string[] = [];
  let priorCapacityGuard: string | undefined;

  beforeEach(() => {
    // The pre-spawn resource check reads this from the global process.env; the demo
    // fleet seeds two processes against the default cap of two, so give headroom.
    priorCapacityGuard = process.env.PANOP_RBG_DISABLE_CAPACITY_CHECK;
    process.env.PANOP_RBG_DISABLE_CAPACITY_CHECK = "1";
  });

  afterEach(() => {
    if (priorCapacityGuard === undefined) {
      delete process.env.PANOP_RBG_DISABLE_CAPACITY_CHECK;
    } else {
      process.env.PANOP_RBG_DISABLE_CAPACITY_CHECK = priorCapacityGuard;
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir !== undefined) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test("the published snapshot shows the fired suggestion, the spawned process, and lastSpoken", async () => {
    const path = writeLoopScriptFixture(buildLoopScript(), tempDirs);
    const runtime = await createProjectorRuntime(loopEnv(path));
    const processCountBefore = runtime.snapshot().processes.length;

    // Capture the LAST published snapshot a subscriber sees, so the assertions are
    // about what the projector actually broadcasts — not just internal state.
    let published = runtime.snapshot();
    const unsubscribe = runtime.subscribe((snapshot) => {
      published = snapshot;
    });

    await drive(runtime);
    unsubscribe();

    // The engine fired, so the bubble is the live "speaking" state — not the demo.
    expect(runtime.lastSuggestionDecision?.kind).toBe("fired");
    expect(published.suggestion.state).toBe("speaking");
    expect(published.suggestion.pitch.length).toBeGreaterThan(0);
    expect(published.suggestion).not.toEqual(demoProjectorSnapshot.suggestion);

    // Exactly one new process landed on the published snapshot (the spawn).
    expect(published.processes.length).toBe(processCountBefore + 1);
    expect(runtime.registry.activeRecords().length).toBe(processCountBefore + 1);

    // The spoken spawn confirmation surfaced as lastSpoken, with the E3 earcon.
    expect(published.audio.lastSpoken).toContain("spawned");
    expect(published.audio.earcon).toBe("E3");

    // The canonical stage transitions ran in order through the live loop.
    const stages = runtime.stageSequencer.transitions().map((transition) => transition.to);
    expect(stages).toEqual<CanonicalStage[]>(["ACTIVE_LISTEN", "SUGGESTION_DELIVERY", "SPAWN", "ACK", "IDLE"]);

    // The recorded TTS provider spoke the summary + the spawn ack.
    expect(runtime.tts).toBeInstanceOf(NoopTTSProvider);
    const spoken = (runtime.tts as NoopTTSProvider).calls.map((call) => call.text);
    expect(spoken.length).toBeGreaterThanOrEqual(2);
    expect(spoken.some((text) => text.includes("spawned"))).toBe(true);
  });
});

function loopEnv(replayPath: string): Record<string, string> {
  return {
    PANOP_INITIAL_MUTED: "0",
    PANOP_MIC_REPLAY_PATH: replayPath,
    PANOP_SUGGEST_WORD_FLOOR: "3",
    PANOP_SUGGEST_INTERRUPT_VELOCITY_WEIGHT: "0",
    PANOP_SUGGEST_INTERRUPT_RECENCY_WEIGHT: "0",
    PANOP_SUGGEST_INTERRUPT_PENDING_STEERING_WEIGHT: "0",
  };
}

async function drive(runtime: ProjectorRuntime): Promise<void> {
  const session = runtime.startMicSession("corr-loop-snapshot");
  await session.stop();
}
