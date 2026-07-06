import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectorRuntime, type ProjectorRuntime } from "../../src/server/composition";
import type { BuilderAgent } from "../../src/server/idea-builder";
import type { TranscriptObservation } from "../../src/types";

// Inject a synthetic builder so NO real `claude` CLI is spawned: the no-op leaves
// the deterministic scaffold in place, which the assertions expect.
const noopBuilder: BuilderAgent = async () => undefined;

// e2e: accepting a suggestion yields a real live preview. On the LIVE runtime
// (createProjectorRuntime + replay ASR + heuristic decider, no network), a fired
// suggestion followed by a spoken "yes" routes through acceptance -> spawn ->
// idea-builder. The spawned process appears on the snapshot with a previewUrl, and
// a genuine GET on that URL serves the scaffolded page. Halting the process tears
// the preview server down (lifecycle).

describe("accept-preview e2e — say yes yields a live, reachable preview", () => {
  const realFetch = globalThis.fetch;
  let buildsRoot: string;
  let priorCapacityGuard: string | undefined;
  let runtime: ProjectorRuntime | undefined;

  beforeEach(async () => {
    buildsRoot = await mkdtemp(join(tmpdir(), "accept-preview-e2e-"));
    priorCapacityGuard = process.env.VIBERSYN_RBG_DISABLE_CAPACITY_CHECK;
    process.env.VIBERSYN_RBG_DISABLE_CAPACITY_CHECK = "1";
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    await runtime?.ideaBuilds.stopAll().catch(() => undefined);
    runtime = undefined;
    if (priorCapacityGuard === undefined) {
      delete process.env.VIBERSYN_RBG_DISABLE_CAPACITY_CHECK;
    } else {
      process.env.VIBERSYN_RBG_DISABLE_CAPACITY_CHECK = priorCapacityGuard;
    }
    await rm(buildsRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  test("accepting a suggestion surfaces a previewUrl and GET serves the page", async () => {
    runtime = await createProjectorRuntime(liveEnv(), {
      buildsRoot,
      builderAgent: noopBuilder,
      replaySource: [
        final("let's build a status board to track the migration dry run", "utt-build"),
        final("yes", "utt-yes"),
      ],
    });
    const upidsBefore = new Set(runtime.snapshot().processes.map((process) => process.upid));

    const session = runtime.startMicSession("corr-accept-preview-e2e");
    await session.stop();
    await runtime.detection.flush();

    const spawned = runtime.snapshot().processes.find((process) => !upidsBefore.has(process.upid));
    expect(spawned).toBeDefined();
    if (spawned === undefined) return;

    await runtime.ideaBuilds.settle(spawned.upid);

    const snapshotProcess = runtime.snapshot().processes.find((process) => process.upid === spawned.upid);
    expect(snapshotProcess?.buildStatus).toBe("ready");
    const previewUrl = snapshotProcess?.previewUrl ?? null;
    expect(previewUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/u);
    if (previewUrl === null) return;

    // The preview URL on the snapshot serves the real scaffolded prototype page.
    const response = await fetch(previewUrl);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("Vibersyn prototype");
    expect(body).toContain('data-testid="prototype-title"');

    // Lifecycle: emergency stop halts the process and tears the preview down.
    await runtime.emergencyStop("corr-accept-preview-emergency");
    const halted = runtime.snapshot().processes.find((process) => process.upid === spawned.upid);
    expect(halted?.previewUrl ?? null).toBeNull();
    await expect(fetch(previewUrl)).rejects.toBeDefined();
  });
});

function liveEnv(): Record<string, string> {
  return {
    VIBERSYN_INITIAL_MUTED: "0",
    VIBERSYN_ASR_PROVIDER: "replay",
    // Deterministic idea detection: heuristic detector, eager scheduling, no tick.
    // A low ready threshold lets the single-cue buildable utterance surface.
    VIBERSYN_IDEA_DETECTOR: "heuristic",
    VIBERSYN_DETECT_MIN_NEW_TURNS: "1",
    VIBERSYN_DETECT_MIN_INTERVAL_MS: "0",
    VIBERSYN_DETECT_TICK_MS: "0",
    VIBERSYN_DETECT_READY_THRESHOLD: "0.5",
  };
}

function final(text: string, utteranceId: string): TranscriptObservation {
  return { text, isFinal: true, speaker: "Room", sessionId: "accept-preview-e2e", latencyMs: 20, utteranceId };
}
