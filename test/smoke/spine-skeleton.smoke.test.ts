// Walking-skeleton smoke test (ENG-T-06 / ticket: walking-skeleton-smoke).
// Reads a 2-line fixture, runs the deterministic matcher, and asserts exactly ONE structured
// trace line is emitted with a non-empty correlationId. No Cue / network / API keys.
//
// Red-before-green gate:
//   RED : set BREAK_MATCHER=1 → matcher returns only pass decisions → assertion fails
//   GREEN: normal run → exactly one action decision emitted

import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { loadFixture } from "../../src/replay/harness.ts";
import { match } from "../../src/matcher.ts";
import { TraceProcessor } from "../../src/obs/trace.ts";
import type { CueDecision } from "../../src/types.ts";

const FIXTURE = join(import.meta.dir, "../../fixtures/smoke/transcript.jsonl");

describe("spine-skeleton smoke", () => {
  it("reads fixture, matches wake word, emits exactly one action trace with non-empty correlationId", () => {
    const emitted: string[] = [];
    const tracer = new TraceProcessor("sess-smoke-001", (line) => emitted.push(line));

    const decisions: CueDecision[] = [];

    for (const obs of loadFixture(FIXTURE)) {
      tracer.observation(obs);

      // RBG hook: when BREAK_MATCHER is set the matcher is bypassed — simulates zero action decisions
      const decision =
        process.env["BREAK_MATCHER"] === "1"
          ? ({ kind: "pass", addressed: false, reason: "ambient", policy: "broken", decisionId: "x", correlationId: obs.utteranceId, meta: {} } satisfies CueDecision)
          : match(obs);

      tracer.decision(decision);
      decisions.push(decision);
    }

    const actionDecisions = decisions.filter((d) => d.kind === "action");

    // The core gate: exactly one wake-word match in the 2-line fixture
    expect(actionDecisions.length).toBe(1);

    // Every emitted trace line must carry a non-empty correlationId
    for (const line of emitted) {
      const parsed = JSON.parse(line) as { correlationId?: string };
      expect(parsed.correlationId).toBeTruthy();
    }

    // Verify we actually emitted trace lines (2 obs + 2 decisions = 4)
    expect(emitted.length).toBe(4);
  });

  it("every trace line is valid JSON with required LogEvent fields", () => {
    const emitted: string[] = [];
    const tracer = new TraceProcessor("sess-smoke-001", (line) => emitted.push(line));

    for (const obs of loadFixture(FIXTURE)) {
      tracer.observation(obs);
      tracer.decision(match(obs));
    }

    for (const line of emitted) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(typeof parsed["level"]).toBe("string");
      expect(typeof parsed["event"]).toBe("string");
      expect(typeof parsed["sessionId"]).toBe("string");
      expect(parsed["sessionId"]).not.toBe("");
      // verb-noun: must contain a dot
      expect((parsed["event"] as string).includes(".")).toBe(true);
      expect(typeof parsed["meta"]).toBe("object");
    }
  });

  it("fixture loads exactly 2 observations", () => {
    const obs = [...loadFixture(FIXTURE)];
    expect(obs.length).toBe(2);
  });

  it("pass decision has no action field", () => {
    const obs = [...loadFixture(FIXTURE)];
    // First line: no wake word
    const dec = match(obs[0]!);
    expect(dec.kind).toBe("pass");
    expect((dec as { action?: unknown }).action).toBeUndefined();
  });

  it("action decision carries the utterance text in payload", () => {
    const obs = [...loadFixture(FIXTURE)];
    // Second line: contains "daybreak"
    const dec = match(obs[1]!);
    expect(dec.kind).toBe("action");
    if (dec.kind === "action") {
      expect((dec.action.payload as { text: string }).text).toContain("daybreak");
    }
  });

  it("no secret-shaped strings appear in any trace line", () => {
    const emitted: string[] = [];
    const tracer = new TraceProcessor("sess-smoke-001", (line) => emitted.push(line));
    for (const obs of loadFixture(FIXTURE)) {
      tracer.observation(obs);
      tracer.decision(match(obs));
    }
    const SECRET_PATTERN = /sk-[A-Za-z0-9]{10,}|Bearer [A-Za-z0-9._-]{20,}|dg\.[A-Za-z0-9]{10,}/;
    for (const line of emitted) {
      expect(SECRET_PATTERN.test(line)).toBe(false);
    }
  });
});
