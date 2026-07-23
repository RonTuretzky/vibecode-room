import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectorRuntime, type ProjectorRuntime } from "../../src/server/composition";
import { NoopTTSProvider } from "../../src/providers";
import type { TranscriptObservation } from "../../src/types";

// ISSUE-0013 e2e (GAP-005 + GAP-008): on the LIVE runtime a spoken, buildable idea
// delivers a suggestion that is *spoken* (TTS), and a subsequent spoken "yes" both
// earcons (E3) and speaks a confirmation as the process spawns. No key is set, so
// this.tts is the NoopTTSProvider (silent-but-recorded) and nothing hits the
// network — yet the audible OutputDecisions still surface on the snapshot/trace.

describe("ambient feedback e2e — the live loop speaks and earcons on accept", () => {
  const realFetch = globalThis.fetch;
  const tempDirs: string[] = [];
  let fetchCalls = 0;
  let priorCapacityGuard: string | undefined;

  beforeEach(() => {
    fetchCalls = 0;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      fetchCalls += 1;
      throw new Error(`unexpected network fetch in no-key feedback path: ${String(args[0])}`);
    }) as unknown as typeof fetch;
    priorCapacityGuard = process.env.VIBERSYN_RBG_DISABLE_CAPACITY_CHECK;
    process.env.VIBERSYN_RBG_DISABLE_CAPACITY_CHECK = "1";
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
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

  test("buildable utterance then 'yes' yields a tts OutputDecision + an E3 earcon trace with audioSnapshot updated", async () => {
    const path = writeFixture(tempDirs, [
      final("let's build a dashboard tool to ship the replay prototype today", "utt-build"),
      final("yes", "utt-yes"),
    ]);
    const runtime = await createProjectorRuntime(liveEnv(path), {
      // No real coding-agent spawn in e2e: the accept path's build runs a noop.
      builderAgent: async () => undefined,
    });

    await driveMic(runtime);
    await runtime.detection.flush();

    // The idea was detected AND spoken; the accept earconed (E3) and spoke.
    const events = runtime.trace.events();
    expect(events.some((event) => event.event === "detect.candidate.new")).toBe(true);
    expect(events.some((event) => event.event === "output.tts")).toBe(true);
    expect(events.some((event) => event.event === "earcon.emit" && event.meta.id === "E3")).toBe(true);

    // The canonical spine recorded the stage transitions that drove that feedback.
    const transitions = runtime.stageSequencer.transitions().map((transition) => transition.to);
    expect(transitions).toContain("SUGGESTION_DELIVERY");
    expect(transitions).toContain("SPAWN");
    expect(transitions).toContain("ACK");

    // audioSnapshot mirrors the audible decisions: the E3 earcon and the spoken ack.
    const audio = runtime.snapshot().audio;
    expect(audio.earcon).toBe("E3");
    expect(audio.lastSpoken).toContain("spawned");

    // No-key replay mode: NoopTTS recorded the spoken phrases, nothing touched net.
    expect(runtime.tts).toBeInstanceOf(NoopTTSProvider);
    const spoken = (runtime.tts as NoopTTSProvider).calls.map((call) => call.text);
    expect(spoken.some((text) => text.includes("spawned"))).toBe(true);
    expect(spoken.length).toBeGreaterThanOrEqual(2);
    expect(fetchCalls).toBe(0);
  });
});

function liveEnv(replayPath: string): Record<string, string> {
  return {
    VIBERSYN_INITIAL_MUTED: "0",
    VIBERSYN_MIC_REPLAY_PATH: replayPath,
    // Deterministic idea detection: heuristic detector, eager scheduling, no tick.
    VIBERSYN_IDEA_DETECTOR: "heuristic",
    VIBERSYN_DETECT_MIN_NEW_TURNS: "1",
    VIBERSYN_DETECT_MIN_INTERVAL_MS: "0",
    VIBERSYN_DETECT_TICK_MS: "0",
  };
}

async function driveMic(runtime: ProjectorRuntime): Promise<void> {
  const session = runtime.startMicSession("corr-feedback-e2e");
  await session.stop();
  await runtime.detection.flush();
}

function writeFixture(tempDirs: string[], observations: TranscriptObservation[]): string {
  const dir = mkdtempSync(join(tmpdir(), "vibersyn-feedback-"));
  tempDirs.push(dir);
  const path = join(dir, "mic.jsonl");
  writeFileSync(path, observations.map((observation) => JSON.stringify(observation)).join("\n"), "utf8");
  return path;
}

function final(text: string, utteranceId: string): TranscriptObservation {
  return { text, isFinal: true, speaker: "Room", sessionId: "feedback-e2e", latencyMs: 20, utteranceId };
}
