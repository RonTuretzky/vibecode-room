import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectorRuntime, type ProjectorRuntime } from "../../src/server/composition";
import type { TranscriptObservation } from "../../src/types";

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

    const events = runtime.trace.events().map((event) => event.event);
    expect(events.some((event) => event === "suggestion.queued" || event === "route.suggestion")).toBe(true);
    const decision = runtime.lastSuggestionDecision;
    if (decision === null) {
      throw new Error("expected a suggestion decision from two buildable utterances");
    }
    expect(["queued", "fired"]).toContain(decision.kind);
    // Heuristic decider only: nothing should have touched the network.
    expect(fetchCalls).toBe(0);
  });

  test("ambient-only speech yields no suggestion on the live runtime", async () => {
    const path = writeFixture(tempDirs, [
      final("the coffee was good and the weather is nice this morning", "utt-1"),
      final("we chatted about the weekend plans for a while", "utt-2"),
    ]);
    const runtime = await createProjectorRuntime(liveEnv(path));

    await driveMic(runtime);

    const events = runtime.trace.events().map((event) => event.event);
    expect(events.some((event) => event === "suggestion.queued" || event === "route.suggestion")).toBe(false);
    expect(runtime.lastSuggestionDecision?.kind).toBe("pass");
    expect(runtime.pendingSuggestion()).toBeNull();
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

async function driveMic(runtime: ProjectorRuntime): Promise<void> {
  const session = runtime.startMicSession("corr-ambient-e2e");
  await session.stop();
}

function writeFixture(tempDirs: string[], observations: TranscriptObservation[]): string {
  const dir = mkdtempSync(join(tmpdir(), "panop-ambient-"));
  tempDirs.push(dir);
  const path = join(dir, "mic.jsonl");
  writeFileSync(path, observations.map((observation) => JSON.stringify(observation)).join("\n"), "utf8");
  return path;
}

function final(text: string, utteranceId: string): TranscriptObservation {
  return { text, isFinal: true, speaker: "Room", sessionId: "ambient-e2e", latencyMs: 20, utteranceId };
}
