import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectorRuntime, type ProjectorRuntime } from "../../src/server/composition";
import type { TranscriptObservation } from "../../src/types";

// ISSUE-0010 e2e (GAP-003): a spoken, buildable idea delivers a suggestion, and a
// subsequent spoken "yes" accepts it — spawning a process through the registry on
// the LIVE runtime (createProjectorRuntime + replay ASR, heuristic decider, no
// network). The spawned process must be visible on snapshot.processes.

describe("ambient accept e2e — a spoken yes accepts the idea and spawns through the registry", () => {
  const realFetch = globalThis.fetch;
  const tempDirs: string[] = [];
  let fetchCalls = 0;
  let priorCapacityGuard: string | undefined;

  beforeEach(() => {
    fetchCalls = 0;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      fetchCalls += 1;
      throw new Error(`unexpected network fetch in no-key acceptance path: ${String(args[0])}`);
    }) as unknown as typeof fetch;
    // The pre-spawn resource check reads this flag from the global process.env.
    // The demo fleet seeds two processes against the default cap of two, so give
    // the acceptance spawn headroom.
    priorCapacityGuard = process.env.PANOP_RBG_DISABLE_CAPACITY_CHECK;
    process.env.PANOP_RBG_DISABLE_CAPACITY_CHECK = "1";
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
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

  test("buildable utterance then 'yes' drives a process.spawn visible in snapshot.processes", async () => {
    const path = writeFixture(tempDirs, [
      final("let's build a dashboard tool to ship the replay prototype today", "utt-build"),
      final("yes", "utt-yes"),
    ]);
    const runtime = await createProjectorRuntime(liveEnv(path));
    const upidsBefore = new Set(runtime.snapshot().processes.map((process) => process.upid));
    const spawnsBefore = spawnTraceCount(runtime);

    await driveMic(runtime);

    // The suggestion was delivered (fired), then the affirmative routed to
    // acceptance and spawned a brand-new process through the registry seam.
    const events = runtime.trace.events().map((event) => event.event);
    expect(events).toContain("route.suggestion");
    expect(events).toContain("route.acceptance");
    expect(spawnTraceCount(runtime)).toBe(spawnsBefore + 1);

    const processes = runtime.snapshot().processes;
    const spawned = processes.filter((process) => !upidsBefore.has(process.upid));
    expect(spawned.length).toBe(1);
    expect(processes.length).toBe(upidsBefore.size + 1);

    // Heuristic decider + in-memory registry only: nothing touched the network.
    expect(fetchCalls).toBe(0);
  });
});

function liveEnv(replayPath: string): Record<string, string> {
  return {
    PANOP_INITIAL_MUTED: "0",
    PANOP_MIC_REPLAY_PATH: replayPath,
    PANOP_SUGGEST_WORD_FLOOR: "3",
    PANOP_SUGGEST_INTERRUPT_VELOCITY_WEIGHT: "0",
    PANOP_SUGGEST_INTERRUPT_RECENCY_WEIGHT: "0",
    PANOP_SUGGEST_INTERRUPT_PENDING_STEERING_WEIGHT: "0",
  };
}

function spawnTraceCount(runtime: ProjectorRuntime): number {
  return runtime.trace.events().filter((event) => event.event === "process.spawn").length;
}

async function driveMic(runtime: ProjectorRuntime): Promise<void> {
  const session = runtime.startMicSession("corr-accept-e2e");
  await session.stop();
}

function writeFixture(tempDirs: string[], observations: TranscriptObservation[]): string {
  const dir = mkdtempSync(join(tmpdir(), "panop-accept-"));
  tempDirs.push(dir);
  const path = join(dir, "mic.jsonl");
  writeFileSync(path, observations.map((observation) => JSON.stringify(observation)).join("\n"), "utf8");
  return path;
}

function final(text: string, utteranceId: string): TranscriptObservation {
  return { text, isFinal: true, speaker: "Room", sessionId: "accept-e2e", latencyMs: 20, utteranceId };
}
