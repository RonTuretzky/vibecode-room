import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectorRuntime, type ProjectorRuntime } from "../../src/server/composition";
import type { TranscriptObservation } from "../../src/types";
import { demoProjectorSnapshot, emptyProjectorSnapshot } from "../../src/ui/demo-data";

// ISSUE-0008 e2e: a spoken, buildable idea queues/fires a suggestion within two
// turns on the LIVE runtime — createProjectorRuntime + replay ASR, heuristic
// decider (no key, no network).

describe("ambient suggest e2e — live runtime queues a suggestion from spoken buildable ideas", () => {
  const realFetch = globalThis.fetch;
  const tempDirs: string[] = [];
  let fetchCalls = 0;

  beforeEach(() => {
    fetchCalls = 0;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      fetchCalls += 1;
      throw new Error(`unexpected network fetch in no-key ambient path: ${String(args[0])}`);
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir !== undefined) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test("two final buildable observations produce a queued/fired suggestion trace", async () => {
    const path = writeFixture(tempDirs, [
      final("let's design and build a replay dashboard for the fleet", "utt-1"),
      final("then we can ship the prototype and automate the pipeline", "utt-2"),
    ]);
    const runtime = await createProjectorRuntime(liveEnv(path));

    await driveMic(runtime);
    await runtime.detection.flush();

    const events = runtime.trace.events().map((event) => event.event);
    expect(events).toContain("detect.candidate.new");
    const primary = runtime.detection.primary();
    if (primary === null) {
      throw new Error("expected a detected idea from two buildable utterances");
    }
    expect(primary.pitch.length).toBeGreaterThan(0);
    // Heuristic detector only: nothing should have touched the network.
    expect(fetchCalls).toBe(0);
  });

  test("ambient-only speech yields no suggestion on the live runtime", async () => {
    const path = writeFixture(tempDirs, [
      final("the coffee was good and the weather is nice this morning", "utt-1"),
      final("we chatted about the weekend plans for a while", "utt-2"),
    ]);
    const runtime = await createProjectorRuntime(liveEnv(path));

    await driveMic(runtime);
    await runtime.detection.flush();

    const events = runtime.trace.events().map((event) => event.event);
    expect(events).not.toContain("detect.candidate.new");
    expect(runtime.detection.primary()).toBeNull();
    expect(runtime.detection.candidates()).toHaveLength(0);
    expect(fetchCalls).toBe(0);
  });

  // ISSUE-0009: the idea bubble must react to real speech. Driving audio through
  // startMicSession should flip snapshot.suggestion off the demo fixture to a
  // live state carrying the spoken pitch.
  test("idea bubble flips from idle to a live suggestion with the spoken pitch", async () => {
    const path = writeFixture(tempDirs, [
      final("let's design and build a replay dashboard for the fleet", "utt-1"),
      final("then we can ship the prototype and automate the pipeline", "utt-2"),
    ]);
    const runtime = await createProjectorRuntime(liveEnv(path));

    // Before any audio: the neutral idle bubble (empty pitch), not the demo fixture.
    expect(runtime.snapshot().suggestion).toEqual(emptyProjectorSnapshot.suggestion);
    expect(runtime.snapshot().suggestion).not.toEqual(demoProjectorSnapshot.suggestion);

    await driveMic(runtime);
    await runtime.detection.flush();

    const suggestion = runtime.snapshot().suggestion;
    expect(suggestion).not.toEqual(demoProjectorSnapshot.suggestion);
    expect(suggestion.state).toBe("queued");
    // The pitch is derived from the spoken utterance, not the static fixture.
    expect(suggestion.pitch.length).toBeGreaterThan(0);
    expect(suggestion.pitch).not.toBe(demoProjectorSnapshot.suggestion.pitch);
    // Provenance: the bubble carries the span of conversation it was grounded in.
    expect(suggestion.contextSpan?.quote.length ?? 0).toBeGreaterThan(0);
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
  const session = runtime.startMicSession("corr-ambient-e2e");
  await session.stop();
}

function writeFixture(tempDirs: string[], observations: TranscriptObservation[]): string {
  const dir = mkdtempSync(join(tmpdir(), "vibersyn-ambient-"));
  tempDirs.push(dir);
  const path = join(dir, "mic.jsonl");
  writeFileSync(path, observations.map((observation) => JSON.stringify(observation)).join("\n"), "utf8");
  return path;
}

function final(text: string, utteranceId: string): TranscriptObservation {
  return { text, isFinal: true, speaker: "Room", sessionId: "ambient-e2e", latencyMs: 20, utteranceId };
}
