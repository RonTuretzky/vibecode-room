import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cueSourceBuildAvailable } from "../../src/cue/source";
import { createProjectorRuntime, type ProjectorRuntime } from "../../src/server/composition";
import type { TranscriptObservation } from "../../src/types";

// ISSUE-0025 e2e (GAP-006): drive the upstream Cue harness fast-path against a
// real (committed, pre-built) Cue substrate. Pointing VIBERSYN_CUE_SOURCE_DIR at
// the fixture makes the live runtime select mode 'harness'; a 'viber' wake word
// then drives the harness ingest -> adapter to an earcon, surfacing an earcon
// OutputDecision on the snapshot and a harness-tagged earcon trace. With no
// build the runtime degrades deterministically to the in-runtime fallback.

const CUE_BUILD_FIXTURE = join(import.meta.dir, "../../fixtures/cue-build");

const priorSourceDir = process.env.VIBERSYN_CUE_SOURCE_DIR;
const tempDirs: string[] = [];

afterEach(() => {
  if (priorSourceDir === undefined) {
    delete process.env.VIBERSYN_CUE_SOURCE_DIR;
  } else {
    process.env.VIBERSYN_CUE_SOURCE_DIR = priorSourceDir;
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("cue-harness e2e — wake word emits an earcon through the harness path", () => {
  test("a Cue build selects mode 'harness' and a 'viber' wake word emits a harness earcon", async () => {
    process.env.VIBERSYN_CUE_SOURCE_DIR = CUE_BUILD_FIXTURE;
    // Precondition: the fixture is a complete, importable build.
    expect(cueSourceBuildAvailable()).toBe(true);

    const replayPath = writeReplayFixture([final("viber status please", "utt-harness-1")]);
    const runtime = await createProjectorRuntime(baseEnv(replayPath));

    // The harness fast-path is live (not the in-runtime fallback).
    expect(runtime.cueBridgeMode).toBe("harness");

    await driveMic(runtime);

    // The wake word emitted an earcon OutputDecision on the snapshot.
    expect(runtime.snapshot().audio.earcon).toBe("E1");

    // ...and a harness-tagged earcon trace, distinguishable from the fallback
    // path. Select by source: the onboarding listening indicator's authoritative
    // E2 earcon fires first on mic open.
    const earcons = runtime.trace
      .events()
      .filter((event) => event.event === "earcon.emit" && event.meta?.source === "cue-textcue");
    expect(earcons.length).toBeGreaterThanOrEqual(1);
    expect(earcons[0]?.meta).toEqual(
      expect.objectContaining({ source: "cue-textcue", matchedWord: "viber", path: "harness" }),
    );
  });

  test("with no Cue build the runtime falls back deterministically and still emits an earcon", async () => {
    // Force the no-build default by pointing at an empty dir; restored in afterEach.
    const empty = mkdtempSync(join(tmpdir(), "vibersyn-cue-harness-empty-"));
    tempDirs.push(empty);
    process.env.VIBERSYN_CUE_SOURCE_DIR = empty;
    expect(cueSourceBuildAvailable()).toBe(false);

    const replayPath = writeReplayFixture([final("viber go", "utt-harness-2")]);
    const runtime = await createProjectorRuntime(baseEnv(replayPath));

    expect(runtime.cueBridgeMode).toBe("fallback");

    await driveMic(runtime);

    expect(runtime.snapshot().audio.earcon).toBe("E1");
    // Select by source (the onboarding listening indicator's E2 fires first).
    const earcons = runtime.trace
      .events()
      .filter((event) => event.event === "earcon.emit" && event.meta?.source === "cue-textcue");
    expect(earcons.length).toBeGreaterThanOrEqual(1);
    // The fallback path is distinguishable from the harness path via the `path` tag.
    expect(earcons[0]?.meta).toEqual(
      expect.objectContaining({ source: "cue-textcue", matchedWord: "viber", path: "fallback" }),
    );
  });
});

function baseEnv(replayPath: string): Record<string, string> {
  return {
    VIBERSYN_SESSION_ID: "cue-harness-e2e",
    VIBERSYN_INITIAL_MUTED: "0",
    VIBERSYN_MIC_REPLAY_PATH: replayPath,
    VIBERSYN_SUGGEST_WORD_FLOOR: "3",
  };
}

async function driveMic(runtime: ProjectorRuntime): Promise<void> {
  const session = runtime.startMicSession("corr-cue-harness-mic");
  await session.stop();
}

function writeReplayFixture(observations: TranscriptObservation[]): string {
  const dir = mkdtempSync(join(tmpdir(), "vibersyn-cue-harness-"));
  tempDirs.push(dir);
  const path = join(dir, "mic.jsonl");
  writeFileSync(path, observations.map((observation) => JSON.stringify(observation)).join("\n"), "utf8");
  return path;
}

function final(text: string, utteranceId: string): TranscriptObservation {
  return { text, isFinal: true, speaker: "Room", sessionId: "cue-harness-e2e", latencyMs: 20, utteranceId };
}
