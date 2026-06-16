import { describe, expect, test } from "bun:test";
import { MemoryCorrelationStore } from "../seam/correlation-store";
import { SeamDispatcher } from "../seam/dispatcher";
import type { SmithersClient, SpawnResult, StreamRunEventsOptions } from "../seam/smithers-client";
import {
  CALLSIGN_REUSE_COOLDOWN_MS,
  DEFAULT_CALLSIGN_POOL,
  NATO_CALLSIGNS,
  CallsignAllocator,
  assertCallsignPool,
  doubleMetaphone,
  matchCallsignInUtterance,
  phonemeLevenshtein,
  phoneticProfile,
  reservedControlWords,
  validateCallsignCandidate,
} from "./callsigns";

const NATURAL_DEV_SPEECH = [
  "Let's alpha test the migration before lunch.",
  "Bravo, that fixes the flaky replay harness.",
  "The charlie branch still carries the old schema.",
  "Delta pause here while the deploy catches up.",
  "Echo the environment before you run the benchmark.",
  "Can you accept the premise but not spawn work yet?",
  "Yes, but that is just conversational agreement.",
  "Confirm whether the status query should stay read only.",
] as const;

describe("callsign collision guard", () => {
  test("AC7.2 rejects callsigns colliding with active callsigns and control words", () => {
    const reserved = reservedControlWords({
      PANOP_WAKE_WORDS: "panop",
      PANOP_MUTE_WORDS: "mute",
      PANOP_UNMUTE_WORDS: "unmute",
      PANOP_PANIC_WORDS: "abort",
      PANOP_STOP_WORDS: "halt",
    });
    const active = ["virellium"];
    const nearActive = validateCallsignCandidate("virelium", active, reserved);
    const nearWake = validateCallsignCandidate("panap", active, reserved);
    const nearMute = validateCallsignCandidate("mooter", active, reserved);
    const nearUnmute = validateCallsignCandidate("unmooter", active, reserved);
    const nearPanic = validateCallsignCandidate("abord", active, reserved);
    const nearStop = validateCallsignCandidate("hault", active, reserved);
    const safe = validateCallsignCandidate("quoravex", active, reserved);

    expect(nearActive.accepted).toBe(false);
    expect(nearActive.collision).toEqual(expect.objectContaining({ existing: "virellium" }));
    expect(nearWake.accepted).toBe(false);
    expect(nearMute.accepted).toBe(false);
    expect(nearUnmute.accepted).toBe(false);
    expect(nearPanic.accepted).toBe(false);
    expect(nearStop.accepted).toBe(false);
    expect(safe.accepted).toBe(true);
  });

  test("coined pool contains no NATO or conversational callsigns", () => {
    const pool = process.env.PANOP_RBG_USE_NATO_CALLSIGNS === "1"
      ? [...NATO_CALLSIGNS]
      : [...DEFAULT_CALLSIGN_POOL];

    expect(() => assertCallsignPool(pool)).not.toThrow();
    for (const callsign of pool) {
      expect(NATO_CALLSIGNS).not.toContain(callsign);
      expect(falseAcceptRate(callsign, NATURAL_DEV_SPEECH)).toBe(0);
    }
  });

  test("AC13.2 assigns unique sequential callsigns and rejects proposed collisions", () => {
    const allocator = new CallsignAllocator({ now: () => 1_000 });
    const first = allocator.assign("upid-a");
    const second = allocator.assign("upid-b");

    expect(first.callsign).toBe(DEFAULT_CALLSIGN_POOL[0]);
    expect(second.callsign).toBe(DEFAULT_CALLSIGN_POOL[1]);
    expect(first.callsign).not.toBe(second.callsign);
    expect(() => allocator.assign("upid-c", first.callsign)).toThrow(/collides|available/u);
    expect(() => allocator.assign("upid-c", "virelium")).toThrow(/collides/u);
  });

  test("D-DD-18 keeps halted callsigns unavailable for 60 seconds before reuse", () => {
    let now = 10_000;
    const allocator = new CallsignAllocator({
      pool: ["virellium", "quoravex"],
      now: () => now,
    });

    const first = allocator.assign("upid-a");
    allocator.release("upid-a");
    const duringCooldown = allocator.assign("upid-b");
    expect(duringCooldown.callsign).toBe("quoravex");

    allocator.release("upid-b");
    now += CALLSIGN_REUSE_COOLDOWN_MS - 1;
    expect(() => allocator.assign("upid-c")).toThrow(/No non-colliding/u);

    now += 1;
    const afterCooldown = allocator.assign("upid-c");
    expect(afterCooldown.callsign).toBe(first.callsign);
    expect(afterCooldown.reusedAfterCooldown).toBe(true);
  });

  test("concatenated STT output still selects a callsign without a strict word-boundary regex", () => {
    const active = [
      { upid: "upid-virellium", callsign: "virellium" },
      { upid: "upid-quoravex", callsign: "quoravex" },
    ];

    const separated = matchCallsignInUtterance("Virellium, pause.", active);
    const concatenated = process.env.PANOP_RBG_STRICT_WORD_CALLSIGN_MATCHER === "1"
      ? null
      : matchCallsignInUtterance("VirelliumPause.", active);

    expect(separated).toEqual(
      expect.objectContaining({ upid: "upid-virellium", callsign: "virellium", instruction: "pause" }),
    );
    expect(concatenated).toEqual(
      expect.objectContaining({ upid: "upid-virellium", callsign: "virellium", instruction: "Pause", concatenated: true }),
    );
  });

  test("P-PHONETIC stable reproducible codes and distances across runs", () => {
    const words = ["virellium", "quoravex", "panop", "mute", "unmute", "abort", "halt"];
    const firstRun = words.map((word) => phoneticProfile(word));
    const secondRun = words.map((word) => phoneticProfile(word));

    expect(secondRun).toEqual(firstRun);
    expect(firstRun).toEqual([
      { normalized: "virellium", metaphone: ["FRLM", ""], phonemes: "fArAlAm" },
      { normalized: "quoravex", metaphone: ["KRFKS", ""], phonemes: "kArAfAks" },
      { normalized: "panop", metaphone: ["PNP", ""], phonemes: "pAnAp" },
      { normalized: "mute", metaphone: ["MT", ""], phonemes: "mAtA" },
      { normalized: "unmute", metaphone: ["ANMT", ""], phonemes: "AnmAtA" },
      { normalized: "abort", metaphone: ["APRT", ""], phonemes: "AbArt" },
      { normalized: "halt", metaphone: ["HLT", ""], phonemes: "hAlt" },
    ]);
    expect(doubleMetaphone("virellium")).toEqual(doubleMetaphone("Virellium"));
    expect(phonemeLevenshtein("virellium", "virelium")).toBeLessThanOrEqual(2);
    expect(phonemeLevenshtein("virellium", "quoravex")).toBeGreaterThan(2);
  });

  test("dispatcher assigns callsigns at spawn and records a structured command log", async () => {
    const client = new MockSmithersClient();
    const store = new MemoryCorrelationStore();
    const traces: unknown[] = [];
    const dispatcher = new SeamDispatcher({
      client,
      correlations: store,
      sessionId: "callsign-dispatch",
      onTrace: (event) => traces.push(event),
    });

    const result = await dispatcher.dispatch({
      type: "spawn",
      targetUPID: null,
      payload: { upid: "upid-dispatch-1", workflow: "callsign-test" },
      correlationId: "corr-callsign-dispatch",
    });
    await dispatcher.drain();

    expect(result).toEqual(expect.objectContaining({ accepted: true }));
    expect(client.spawns[0]).toEqual(expect.objectContaining({ callsign: DEFAULT_CALLSIGN_POOL[0] }));
    expect(await store.findByUPID("upid-dispatch-1")).toEqual(
      expect.objectContaining({ callsign: DEFAULT_CALLSIGN_POOL[0] }),
    );
    expect(traces).toContainEqual(
      expect.objectContaining({
        event: "command.callsign",
        correlationId: "corr-callsign-dispatch",
        upid: "upid-dispatch-1",
        meta: expect.objectContaining({ callsign: DEFAULT_CALLSIGN_POOL[0] }),
      }),
    );
  });
});

function falseAcceptRate(callsign: string, corpus: readonly string[]): number {
  const hits = corpus.filter((entry) => new RegExp(`\\b${callsign}\\b`, "iu").test(entry)).length;
  return hits / corpus.length;
}

class MockSmithersClient implements SmithersClient {
  readonly spawns: any[] = [];

  async spawn(seed: any): Promise<SpawnResult> {
    this.spawns.push(seed);
    return {
      upid: seed.upid,
      runId: seed.runId ?? `run-${seed.upid}`,
      workflow: seed.workflow,
      parentId: seed.parentId ?? null,
    };
  }

  async steer(): Promise<unknown> {
    return { ok: true };
  }

  async signal(): Promise<unknown> {
    return { ok: true };
  }

  async pause(): Promise<unknown> {
    return { ok: true };
  }

  async resume(): Promise<unknown> {
    return { ok: true };
  }

  async halt(): Promise<unknown> {
    return { ok: true };
  }

  async *streamRunEvents(_upid: string, _options?: StreamRunEventsOptions): AsyncIterable<never> {}
}
