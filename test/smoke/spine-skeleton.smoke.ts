// Walking-skeleton smoke test (ENG-T-06 / ticket: walking-skeleton-smoke).
// Reads a 2-line fixture, runs the deterministic matcher, and asserts exactly ONE
// structured trace line is emitted with a non-empty correlationId.
// No Cue / network / API keys — pure in-process doubles.
//
// Invoked explicitly: bun test test/smoke/spine-skeleton.smoke.ts
// (Bun treats an explicit file path argument as a direct run, regardless of naming convention.)
//
// Red-before-green gate:
//   RED : BREAK_MATCHER=1 → all decisions are "pass" → 0 trace lines → assertion fails
//   GREEN: normal run → exactly one action decision → exactly one trace line → passes

import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { loadFixture } from "../../src/replay/harness.ts";
import { match } from "../../src/matcher.ts";
import { TraceProcessor } from "../../src/obs/trace.ts";
import type { CueDecision, LogEvent } from "../../src/types.ts";

const FIXTURE = join(import.meta.dir, "../../fixtures/smoke/transcript.jsonl");

describe("spine-skeleton smoke", () => {
  it("reads 2-line fixture, runs matcher, emits exactly one structured trace line with non-empty correlationId", () => {
    const emitted: string[] = [];
    const tracer = new TraceProcessor("sess-smoke-001", (line) => emitted.push(line));

    for (const obs of loadFixture(FIXTURE)) {
      // RBG hook: BREAK_MATCHER=1 forces all decisions to "pass" → no trace lines emitted
      const decision: CueDecision =
        process.env["BREAK_MATCHER"] === "1"
          ? {
              kind: "pass",
              addressed: false,
              reason: "ambient",
              policy: "broken",
              decisionId: "x",
              correlationId: obs.utteranceId,
              meta: {},
            }
          : match(obs);

      tracer.process(obs, decision);
    }

    // Core gate: exactly one trace line (the action decision on the wake-word line)
    expect(emitted.length).toBe(1);

    // Parse and verify full LogEvent shape (not just correlationId)
    const parsed = JSON.parse(emitted[0]!) as LogEvent;

    // Verify required LogEvent fields
    expect(parsed.correlationId).toBeTruthy();
    expect(parsed.correlationId).not.toBe("");
    expect(parsed.event).toBe("emit.spine-action");
    expect(parsed.level).toBe("info");
    expect(parsed.sessionId).toBe("sess-smoke-001");
    expect(parsed.meta).toBeDefined();
    expect(typeof parsed.meta).toBe("object");

    // Verify the action decision meta fields are present
    expect(parsed.meta["utteranceId"]).toBe("utt-smoke-002");
    expect(parsed.meta["actionType"]).toBe("spawn");
    expect(parsed.meta["policy"]).toBe("TextCue/wake-word");
    expect(parsed.meta["decisionId"]).toBeTruthy();
    // Determinism: decisionId must be stable across replays (derived from utteranceId, not random)
    expect(parsed.meta["decisionId"]).toBe("decision:utt-smoke-002");
  });

  it("record-replay determinism: same fixture → identical trace output on repeated runs", () => {
    function runOnce(): string[] {
      const emitted: string[] = [];
      const tracer = new TraceProcessor("sess-replay-det", (line) => emitted.push(line));
      for (const obs of loadFixture(FIXTURE)) {
        tracer.process(obs, match(obs));
      }
      return emitted;
    }

    const run1 = runOnce();
    const run2 = runOnce();
    const run3 = runOnce();

    // All runs must produce identical output — no random ids
    expect(run1).toEqual(run2);
    expect(run2).toEqual(run3);
    expect(run1.length).toBe(1);
  });
});
