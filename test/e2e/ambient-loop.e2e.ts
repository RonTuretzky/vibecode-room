import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectorRuntime } from "../../src/server/composition";
import { NoopTTSProvider } from "../../src/providers";
import type { TranscriptObservation } from "../../src/types";

// ISSUE-0014 e2e (GAP-009): the assembled ambient loop end to end, driven through
// the REAL composition (createProjectorRuntime/LiveProjectorRuntime) — replay ASR,
// the heuristic (fireable) DecisionLLM, and Noop TTS — with zero network. This is
// the binding measurable for M2/M4 that the canonical hand-wired harness cannot
// give: mic -> ASR -> suggest -> bubble -> accept -> spawn -> speak, asserted on
// the live runtime objects and reconstructed on one correlation chain.

describe("ambient loop e2e — assembled mic->ASR->suggest->bubble->accept->spawn->speak", () => {
  const realFetch = globalThis.fetch;
  const tempDirs: string[] = [];
  let fetchCalls = 0;
  let priorCapacityGuard: string | undefined;

  beforeEach(() => {
    fetchCalls = 0;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      fetchCalls += 1;
      throw new Error(`unexpected network fetch in the offline ambient loop: ${String(args[0])}`);
    }) as unknown as typeof fetch;
    // The pre-spawn resource check reads this flag from the global process.env. The
    // demo fleet seeds two processes against the default cap of two, so give the
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

  test("the full loop fires, accepts, spawns, and speaks on the live runtime with zero network", async () => {
    const path = writeFixture(tempDirs, [
      final("let's build a dashboard tool to ship the replay prototype today", "utt-build"),
      final("yes", "utt-yes"),
    ]);
    const runtime = await createProjectorRuntime(liveEnv(path));
    const upidsBefore = new Set(runtime.snapshot().processes.map((process) => process.upid));

    const session = runtime.startMicSession("corr-loop-e2e");
    // stop() awaits the background drain loop, so every replayed observation —
    // through the awaited engine/acceptance/spawn/output path — is fully processed.
    await session.stop();
    await runtime.detection.flush();

    // 1) Transcript ingested: the buildable utterance reached the live transcript.
    const transcript = runtime.snapshot().transcript.map((line) => line.text);
    expect(transcript.some((text) => text.includes("dashboard tool"))).toBe(true);

    // 2) A grounded idea was detected (and the spoken accept then consumed it).
    expect(runtime.trace.events().map((event) => event.event)).toContain("detect.candidate.new");

    // 3) Ordered chain on the trace: detect.candidate.new (utt-build) precedes the
    //    acceptance/spawn/ack chain (utt-yes).
    const events = runtime.trace.events();
    const acceptanceCorrelationId = "corr-loop-e2e-utt-yes";
    const firstIndex = (event: string, correlationId?: string): number =>
      events.findIndex((entry) => entry.event === event && (correlationId === undefined || entry.correlationId === correlationId));
    const detectIndex = firstIndex("detect.candidate.new");
    const acceptanceIndex = firstIndex("route.acceptance", acceptanceCorrelationId);
    const spawnIndex = firstIndex("process.spawn", acceptanceCorrelationId);
    const ackIndex = firstIndex("output.tts", acceptanceCorrelationId);
    expect(detectIndex).toBeGreaterThanOrEqual(0);
    expect(detectIndex).toBeLessThan(acceptanceIndex);
    expect(acceptanceIndex).toBeLessThan(spawnIndex);
    expect(spawnIndex).toBeLessThan(ackIndex);

    // 4) One correlation chain reconstructs the acceptance spawn: decision ->
    //    action -> outcome (route.acceptance -> process.spawn -> tts/earcon).
    const chain = runtime.trace.query(acceptanceCorrelationId);
    expect(chain.decision.map((entry) => entry.event)).toContain("route.acceptance");
    expect(chain.action.map((entry) => entry.event)).toContain("process.spawn");
    expect(chain.outcome.some((entry) => entry.event === "output.tts")).toBe(true);
    expect(chain.outcome.some((entry) => entry.event === "earcon.emit" && entry.meta.id === "E3")).toBe(true);

    // 5) Registry spawned exactly one new process, visible on snapshot.processes.
    const spawned = runtime.snapshot().processes.filter((process) => !upidsBefore.has(process.upid));
    expect(spawned.length).toBe(1);
    expect(runtime.snapshot().processes.length).toBe(upidsBefore.size + 1);

    // 6) Spoken affirmative path drove the real TTS provider (Noop, recorded): the
    //    suggestion summary and the spawn confirmation, surfaced on the snapshot.
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

function writeFixture(tempDirs: string[], observations: TranscriptObservation[]): string {
  const dir = mkdtempSync(join(tmpdir(), "vibersyn-loop-"));
  tempDirs.push(dir);
  const path = join(dir, "mic.jsonl");
  writeFileSync(path, observations.map((observation) => JSON.stringify(observation)).join("\n"), "utf8");
  return path;
}

function final(text: string, utteranceId: string): TranscriptObservation {
  return { text, isFinal: true, speaker: "Room", sessionId: "loop-e2e", latencyMs: 20, utteranceId };
}
