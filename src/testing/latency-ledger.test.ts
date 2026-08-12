import { describe, expect, test } from "bun:test";
import {
  formatStreamCost,
  formatSummary,
  joinLatency,
  missingFinals,
  percentile,
  streamCost,
  summarize,
  type EmitRecord,
  type ObservationRecord,
} from "./latency-ledger";

const emits: EmitRecord[] = [
  { utteranceId: "u1", text: "hello room", final: false, emittedAtMs: 1_000 },
  { utteranceId: "u1", text: "hello room again", final: true, emittedAtMs: 2_000 },
  { utteranceId: "u2", text: "second line", final: true, emittedAtMs: 3_000 },
];

describe("latency ledger", () => {
  test("joins committed lines to their first downstream sighting, per stage", () => {
    const observations: ObservationRecord[] = [
      { stage: "sse", text: "hello room again", atMs: 2_040 },
      { stage: "dom", text: "hello room again", atMs: 2_120 },
      { stage: "sse", text: "second line", atMs: 3_030 },
      { stage: "dom", text: "second line", atMs: 3_260 },
    ];
    const samples = joinLatency(emits, observations);
    expect(samples).toHaveLength(4);
    expect(summarize(samples, "sse").p50Ms).toBe(30);
    expect(summarize(samples, "dom").maxMs).toBe(260);
  });

  test("interims are not sampled — they mutate in place and have no stable identity", () => {
    const samples = joinLatency(emits, [{ stage: "dom", text: "hello room", atMs: 1_050 }]);
    expect(samples).toHaveLength(0);
  });

  test("an observation that predates its emit is ignored (a stale line, not a fast room)", () => {
    const samples = joinLatency(emits, [{ stage: "dom", text: "second line", atMs: 2_500 }]);
    expect(samples).toHaveLength(0);
  });

  test("a line the wall never showed is reported, never silently dropped from the stats", () => {
    const observations: ObservationRecord[] = [{ stage: "dom", text: "hello room again", atMs: 2_100 }];
    expect(missingFinals(emits, observations, "dom")).toEqual(["second line"]);
    expect(summarize(joinLatency(emits, observations), "dom").count).toBe(1);
  });

  test("an empty stage summarizes to zeros and says so out loud", () => {
    const summary = summarize([], "dom");
    expect(summary.count).toBe(0);
    expect(formatSummary(summary)).toContain("NO SAMPLES");
  });

  test("percentiles use nearest-rank so a small sample never interpolates a fake number", () => {
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(20);
    expect(percentile([10, 20, 30, 40], 0.95)).toBe(40);
    expect(percentile([], 0.5)).toBe(0);
  });

  test("stream cost reports publish amplification per spoken line", () => {
    const cost = streamCost([{ bytes: 1_000 }, { bytes: 2_000 }, { bytes: 3_000 }], 2_000, 2);
    expect(cost.bytes).toBe(6_000);
    expect(cost.framesPerSecond).toBe(1.5);
    expect(cost.bytesPerSecond).toBe(3_000);
    expect(cost.framesPerSpokenLine).toBe(1.5);
    expect(formatStreamCost(cost)).toContain("frames per spoken line");
  });

  test("stream cost never divides by zero on a run with no speech", () => {
    expect(streamCost([], 0, 0).framesPerSpokenLine).toBe(0);
  });
});
