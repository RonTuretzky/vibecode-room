import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectorRuntime, type ProjectorRuntime } from "../../src/server/composition";
import { cueSourceBuildAvailable } from "../../src/cue/source";
import type { TranscriptObservation } from "../../src/types";

// ISSUE-0012 e2e (GAP-006): a live 'viber' final observation drives the active
// Cue wake/earcon path exactly once. With a Cue build present the upstream harness
// fast-path is selected; with no build the runtime degrades gracefully to the
// deterministic in-runtime CueAdapter fallback. Either way the wake word emits an
// earcon trace and the runtime never throws.

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("cue-wake e2e — live wake word fast-path (build-gated)", () => {
  test("a 'viber' utterance emits an earcon trace through the active Cue path", async () => {
    const buildPresent = cueSourceBuildAvailable();
    const path = writeReplayFixture([
      final("viber status please", "utt-wake-1"),
    ]);
    const runtime = await createProjectorRuntime(baseEnv(path));

    // Selection reflects build presence and is visible on the runtime.
    expect(runtime.cueBridgeMode).toBe(buildPresent ? "harness" : "fallback");

    await driveMic(runtime);

    // The onboarding listening indicator emits its own authoritative E2 earcon
    // on mic open, so select the Cue-path earcon by source rather than position.
    const earcons = runtime.trace
      .events()
      .filter((event) => event.event === "earcon.emit" && event.meta?.source === "cue-textcue");
    expect(earcons.length).toBeGreaterThanOrEqual(1);
    expect(earcons[0]?.meta).toEqual(expect.objectContaining({ source: "cue-textcue", matchedWord: "viber" }));
  });

  test("with no Cue build the runtime constructs the fallback adapter and does not throw", async () => {
    // The graceful-fallback branch only applies when there is genuinely no build.
    // Other suites build Cue into the shared cache, so force the fallback by
    // pointing the source dir at an empty directory; this keeps the assertion
    // meaningful on every host. Restored in `finally`.
    const priorSourceDir = process.env.VIBERSYN_CUE_SOURCE_DIR;
    const empty = mkdtempSync(join(tmpdir(), "vibersyn-cue-empty-"));
    tempDirs.push(empty);
    process.env.VIBERSYN_CUE_SOURCE_DIR = empty;

    try {
      expect(cueSourceBuildAvailable()).toBe(false);
      const path = writeReplayFixture([final("viber go", "utt-wake-2")]);
      const runtime = await createProjectorRuntime(baseEnv(path));
      expect(runtime.cueBridgeMode).toBe("fallback");

      // The full mic drive completes without throwing despite the missing build.
      await driveMic(runtime);
      // Select the Cue-path earcon by source (the onboarding listening
      // indicator's E2 earcon fires first on mic open).
      const earcons = runtime.trace
        .events()
        .filter((event) => event.event === "earcon.emit" && event.meta?.source === "cue-textcue");
      expect(earcons.length).toBeGreaterThanOrEqual(1);
      expect(earcons[0]?.meta).toEqual(expect.objectContaining({ source: "cue-textcue", matchedWord: "viber" }));
    } finally {
      if (priorSourceDir === undefined) {
        delete process.env.VIBERSYN_CUE_SOURCE_DIR;
      } else {
        process.env.VIBERSYN_CUE_SOURCE_DIR = priorSourceDir;
      }
    }
  });
});

function baseEnv(replayPath: string): Record<string, string> {
  return {
    VIBERSYN_SESSION_ID: "cue-wake-e2e",
    VIBERSYN_INITIAL_MUTED: "0",
    VIBERSYN_MIC_REPLAY_PATH: replayPath,
    VIBERSYN_SUGGEST_WORD_FLOOR: "3",
  };
}

async function driveMic(runtime: ProjectorRuntime): Promise<void> {
  const session = runtime.startMicSession("corr-cue-wake-mic");
  await session.stop();
}

function writeReplayFixture(observations: TranscriptObservation[]): string {
  const dir = mkdtempSync(join(tmpdir(), "vibersyn-cue-wake-"));
  tempDirs.push(dir);
  const path = join(dir, "mic.jsonl");
  writeFileSync(path, observations.map((observation) => JSON.stringify(observation)).join("\n"), "utf8");
  return path;
}

function final(text: string, utteranceId: string): TranscriptObservation {
  return { text, isFinal: true, speaker: "Room", sessionId: "cue-wake-e2e", latencyMs: 20, utteranceId };
}
