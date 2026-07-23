import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createProjectorRuntime, type ProjectorRuntime } from "../../src/server/composition";
import type { TranscriptObservation } from "../../src/types";

// ISSUE-0019 e2e: on the LIVE runtime (createProjectorRuntime + injected replay
// ASR, heuristic decider, no network), a fired suggestion followed by a spoken
// affirmative routes through the AcceptanceController -> ProcessRegistry.spawn and
// adds exactly one active ProjectorProcess to snapshot.processes. The negative —
// a fired suggestion followed by a non-affirmative — must NOT add a process.

describe("accept-spawn e2e — say yes spawns a process on the snapshot", () => {
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  let priorCapacityGuard: string | undefined;

  beforeEach(() => {
    fetchCalls = 0;
    // No credentials in this path: any network call is a bug, so fail loudly.
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      fetchCalls += 1;
      throw new Error(`unexpected network fetch in no-key acceptance path: ${String(args[0])}`);
    }) as unknown as typeof fetch;
    // The demo fleet seeds two processes against the default cap of two; give the
    // acceptance spawn headroom (the pre-spawn check reads this from process.env).
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
  });

  test("a fired suggestion followed by 'yes' adds one active process via the registry", async () => {
    const runtime = await createProjectorRuntime(liveEnv(), {
      // No real coding-agent spawn in e2e: the accept path's build runs a noop.
      builderAgent: async () => undefined,
      replaySource: [
        final("let's build a dashboard tool to ship the replay prototype today", "utt-build"),
        final("yes", "utt-yes"),
      ],
    });
    const upidsBefore = new Set(runtime.snapshot().processes.map((process) => process.upid));
    const spawnsBefore = spawnTraceCount(runtime);

    await driveMic(runtime);

    // The suggestion fired and was delivered, then the affirmative routed to
    // acceptance and spawned a brand-new process through the registry seam.
    const events = runtime.trace.events().map((event) => event.event);
    expect(events).toContain("route.acceptance");
    expect(spawnTraceCount(runtime)).toBe(spawnsBefore + 1);

    const processes = runtime.snapshot().processes;
    const spawned = processes.filter((process) => !upidsBefore.has(process.upid));
    expect(spawned).toHaveLength(1);
    expect(processes).toHaveLength(upidsBefore.size + 1);
    // The new process is live (planning/active), not halted.
    expect(["planning", "active"]).toContain(spawned[0]?.state);

    // Heuristic decider + in-memory registry only: nothing touched the network.
    expect(fetchCalls).toBe(0);
  });

  test("a fired suggestion followed by a non-affirmative does NOT add a process", async () => {
    const runtime = await createProjectorRuntime(liveEnv(), {
      // No real coding-agent spawn in e2e: the accept path's build runs a noop.
      builderAgent: async () => undefined,
      replaySource: [
        final("let's build a dashboard tool to ship the replay prototype today", "utt-build"),
        final("no, skip it", "utt-no"),
      ],
    });
    const upidsBefore = new Set(runtime.snapshot().processes.map((process) => process.upid));
    const spawnsBefore = spawnTraceCount(runtime);

    await driveMic(runtime);

    // The decline still routes through acceptance, but it clears the pending
    // suggestion without spawning — no new process appears on the snapshot.
    expect(runtime.trace.events().map((event) => event.event)).toContain("route.acceptance");
    expect(spawnTraceCount(runtime)).toBe(spawnsBefore);

    const processes = runtime.snapshot().processes;
    expect(processes.filter((process) => !upidsBefore.has(process.upid))).toHaveLength(0);
    expect(processes).toHaveLength(upidsBefore.size);
    expect(fetchCalls).toBe(0);
  });
});

function liveEnv(): Record<string, string> {
  return {
    VIBERSYN_INITIAL_MUTED: "0",
    VIBERSYN_ASR_PROVIDER: "replay",
    // Deterministic idea detection: heuristic detector, eager scheduling, no tick.
    VIBERSYN_IDEA_DETECTOR: "heuristic",
    VIBERSYN_DETECT_MIN_NEW_TURNS: "1",
    VIBERSYN_DETECT_MIN_INTERVAL_MS: "0",
    VIBERSYN_DETECT_TICK_MS: "0",
  };
}

function spawnTraceCount(runtime: ProjectorRuntime): number {
  return runtime.trace.events().filter((event) => event.event === "process.spawn").length;
}

async function driveMic(runtime: ProjectorRuntime): Promise<void> {
  const session = runtime.startMicSession("corr-accept-spawn-e2e");
  await session.stop();
  await runtime.detection.flush();
}

function final(text: string, utteranceId: string): TranscriptObservation {
  return { text, isFinal: true, speaker: "Room", sessionId: "accept-spawn-e2e", latencyMs: 20, utteranceId };
}
