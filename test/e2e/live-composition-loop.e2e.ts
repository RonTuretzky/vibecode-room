import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { createProjectorRuntime, type ProjectorRuntime } from "../../src/server/composition";
import { NoopTTSProvider } from "../../src/providers";
import type { CanonicalStage } from "../../src/spine/stage-sequencer";
import {
  AFFIRMATION_UTTERANCE_ID,
  buildBuildableOnlyScript,
  buildLoopScript,
  writeLoopScriptFixture,
} from "./fixtures/loop-script";

// ISSUE-0015 e2e (GAP-010): the binding end-to-end test of the live server ambient
// loop through composition. It drives a real LiveProjectorRuntime (createProjector
// Runtime + startMicSession + replay ASR) through a buildable utterance and an
// affirmation, and asserts the canonical spine the wiring (ISSUE-0007..0013) must
// produce: route.suggestion + a pending suggestion, route.acceptance + a real
// spawn, the stage transitions ACTIVE_LISTEN -> SUGGESTION_DELIVERY -> SPAWN ->
// ACK, and a tts OutputDecision with lastSpoken set. Fully offline: replay ASR +
// heuristic decider + Noop (recorded) TTS, so it is deterministic. It would fail
// against the pre-wiring runtime (no engine routing, no stage transitions, no
// speak path) — that is the point.

describe("live composition loop e2e — suggest -> accept -> spawn -> speak through composition", () => {
  const realFetch = globalThis.fetch;
  const tempDirs: string[] = [];
  let fetchCalls = 0;
  let priorCapacityGuard: string | undefined;

  beforeEach(() => {
    fetchCalls = 0;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      fetchCalls += 1;
      throw new Error(`unexpected network fetch in the offline composition loop: ${String(args[0])}`);
    }) as unknown as typeof fetch;
    // The pre-spawn resource check reads this from the global process.env. The demo
    // fleet seeds two processes against the default cap of two, so give the
    // acceptance spawn headroom.
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

  test("a buildable utterance fires + leaves a pending suggestion, delivered via SUGGESTION_DELIVERY", async () => {
    const path = writeLoopScriptFixture(buildBuildableOnlyScript(), tempDirs);
    const runtime = await createProjectorRuntime(liveEnv(path), {
      // No real coding-agent spawn in e2e: the accept path's build runs a noop.
      builderAgent: async () => undefined,
    });

    await drive(runtime);
    await runtime.detection.flush();

    // A grounded idea was detected, and it is pending — the AcceptanceController is
    // now awaiting an accept/decline.
    expect(traceEvents(runtime)).toContain("detect.candidate.new");
    expect(runtime.detection.primary()).not.toBeNull();
    expect(runtime.acceptanceController.awaitingAcceptance()).toBe(true);

    // The canonical spine opened ACTIVE_LISTEN then SUGGESTION_DELIVERY.
    expect(stageOrder(runtime)).toEqual(["ACTIVE_LISTEN", "SUGGESTION_DELIVERY"]);

    // The delivery carried a spoken (tts) OutputDecision, surfaced as lastSpoken.
    const delivery = transitionTo(runtime, "SUGGESTION_DELIVERY");
    expect(delivery?.audible?.channel).toBe("tts");
    expect(runtime.snapshot().audio.lastSpoken?.length ?? 0).toBeGreaterThan(0);

    // No spawn yet (no affirmation consumed the pending suggestion).
    expect(traceEvents(runtime)).not.toContain("route.acceptance");
    expect(fetchCalls).toBe(0);
  });

  test("buildable + affirmation drives route.acceptance -> spawn -> ACK with a spoken confirmation", async () => {
    const path = writeLoopScriptFixture(buildLoopScript(), tempDirs);
    const runtime = await createProjectorRuntime(liveEnv(path), {
      // No real coding-agent spawn in e2e: the accept path's build runs a noop.
      builderAgent: async () => undefined,
    });
    const upidsBefore = new Set(runtime.snapshot().processes.map((process) => process.upid));

    const session = runtime.startMicSession("corr-comp-loop");
    // stop() awaits the background drain loop, so the whole replayed script —
    // through the awaited detection/acceptance/spawn/output path — is fully processed.
    await session.stop();
    await runtime.detection.flush();

    // 1) A grounded idea was detected (and the spoken accept then consumed it).
    expect(traceEvents(runtime)).toContain("detect.candidate.new");

    // 2) detect.candidate.new preceded route.acceptance + a real spawn (keyed on the
    //    affirmation's correlation id), which preceded the spoken ack.
    const events = runtime.trace.events();
    const acceptanceCorrelationId = `corr-comp-loop-${AFFIRMATION_UTTERANCE_ID}`;
    const firstIndex = (event: string, correlationId?: string): number =>
      events.findIndex((entry) => entry.event === event && (correlationId === undefined || entry.correlationId === correlationId));
    const detectIndex = firstIndex("detect.candidate.new");
    const acceptanceIndex = firstIndex("route.acceptance", acceptanceCorrelationId);
    const spawnIndex = firstIndex("process.spawn", acceptanceCorrelationId);
    const ttsIndex = firstIndex("output.tts", acceptanceCorrelationId);
    expect(detectIndex).toBeGreaterThanOrEqual(0);
    expect(detectIndex).toBeLessThan(acceptanceIndex);
    expect(acceptanceIndex).toBeLessThan(spawnIndex);
    expect(spawnIndex).toBeLessThan(ttsIndex);

    // 3) The canonical stage transitions for the full loop, in order:
    //    ACTIVE_LISTEN -> SUGGESTION_DELIVERY -> SPAWN -> ACK (then reset to IDLE).
    expect(stageOrder(runtime)).toEqual(["ACTIVE_LISTEN", "SUGGESTION_DELIVERY", "SPAWN", "ACK", "IDLE"]);
    // The SPAWN transition carried the E3 earcon; the ACK transition spoke (tts).
    expect(transitionTo(runtime, "SPAWN")?.audible).toEqual({ channel: "earcon", id: "E3" });
    expect(transitionTo(runtime, "ACK")?.audible?.channel).toBe("tts");

    // 4) The acceptance correlation chain reconstructs decision -> action -> outcome.
    const chain = runtime.trace.query(acceptanceCorrelationId);
    expect(chain.decision.map((entry) => entry.event)).toContain("route.acceptance");
    expect(chain.action.map((entry) => entry.event)).toContain("process.spawn");
    expect(chain.outcome.some((entry) => entry.event === "output.tts")).toBe(true);
    expect(chain.outcome.some((entry) => entry.event === "earcon.emit" && entry.meta.id === "E3")).toBe(true);

    // 5) Exactly one new registry process surfaced on snapshot.processes.
    const spawned = runtime.snapshot().processes.filter((process) => !upidsBefore.has(process.upid));
    expect(spawned).toHaveLength(1);
    expect(runtime.snapshot().processes.length).toBe(upidsBefore.size + 1);

    // 6) The real TTS provider (Noop, recorded) spoke the summary + the spawn ack,
    //    and a tts OutputDecision set lastSpoken on the snapshot.
    expect(runtime.tts).toBeInstanceOf(NoopTTSProvider);
    const spoken = (runtime.tts as NoopTTSProvider).calls.map((call) => call.text);
    expect(spoken.length).toBeGreaterThanOrEqual(2);
    expect(spoken.some((text) => text.includes("spawned"))).toBe(true);
    expect(runtime.snapshot().audio.earcon).toBe("E3");
    expect(runtime.snapshot().audio.lastSpoken).toContain("spawned");

    // The whole loop ran offline: heuristic decider + in-memory registry, no fetch.
    expect(fetchCalls).toBe(0);
  });
});

function liveEnv(replayPath: string): Record<string, string> {
  return {
    // Start unmuted so the (mute-protected) replay mic actually streams.
    VIBERSYN_INITIAL_MUTED: "0",
    VIBERSYN_MIC_REPLAY_PATH: replayPath,
    // Deterministic idea detection: heuristic detector, eager scheduling, no tick.
    VIBERSYN_IDEA_DETECTOR: "heuristic",
    VIBERSYN_DETECT_MIN_NEW_TURNS: "1",
    VIBERSYN_DETECT_MIN_INTERVAL_MS: "0",
    VIBERSYN_DETECT_TICK_MS: "0",
  };
}

async function drive(runtime: ProjectorRuntime): Promise<void> {
  const session = runtime.startMicSession("corr-comp-loop");
  await session.stop();
}

function traceEvents(runtime: ProjectorRuntime): string[] {
  return runtime.trace.events().map((event) => event.event);
}

// The ordered list of canonical stages the live loop transitioned INTO.
function stageOrder(runtime: ProjectorRuntime): CanonicalStage[] {
  return runtime.stageSequencer.transitions().map((transition) => transition.to);
}

function transitionTo(runtime: ProjectorRuntime, stage: CanonicalStage) {
  return runtime.stageSequencer.transitions().find((transition) => transition.to === stage);
}
