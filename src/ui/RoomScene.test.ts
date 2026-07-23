import { describe, expect, test } from "bun:test";
import { stageWord, treeIndicators, treeStatus, treeTitle, type TreeSpec } from "./RoomScene";

// A minimal legacy TreeSpec: only the fields callers set before the richer
// indicators existed. Every new field is left absent to prove back-compat.
function baseSpec(overrides: Partial<TreeSpec> = {}): TreeSpec {
  return {
    upid: "u1",
    callsign: "Atlas",
    state: "active",
    progress: 40,
    task: "Blocker announcer",
    steering: false,
    ...overrides,
  };
}

describe("treeIndicators — richer per-process state", () => {
  test("legacy spec (no new fields) renders as a bare concept sapling", () => {
    const ind = treeIndicators(baseSpec());
    expect(ind.grown).toBe(false);
    expect(ind.ring).toBe("none");
    expect(ind.lanes).toEqual({ building: 0, ready: 0, failed: 0 });
    expect(ind.published).toBe(false);
    expect(ind.failed).toBe(false);
    // active + mid-flight → a live arc even without an explicit stage.
    expect(ind.progressArc).toBeCloseTo(0.4, 5);
  });

  test("concept stage stays a sapling with no ring", () => {
    const ind = treeIndicators(baseSpec({ stage: "concept" }));
    expect(ind.grown).toBe(false);
    expect(ind.ring).toBe("none");
  });

  test("commissioned grows into a full tree with the commission ring", () => {
    const ind = treeIndicators(baseSpec({ stage: "commissioned" }));
    expect(ind.grown).toBe(true);
    expect(ind.ring).toBe("commission");
  });

  test("built keeps the full tree but switches to the completion ring", () => {
    const ind = treeIndicators(baseSpec({ stage: "built", state: "completed", progress: 100 }));
    expect(ind.grown).toBe(true);
    expect(ind.ring).toBe("built");
    // A finished build is not "executing", so no live arc.
    expect(ind.progressArc).toBeNull();
  });

  test("build-lane summary is clamped to non-negative integers", () => {
    const ind = treeIndicators(baseSpec({ builds: { building: 2.6, ready: 1, failed: -3 } }));
    expect(ind.lanes).toEqual({ building: 3, ready: 1, failed: 0 });
  });

  test("published flag lights the take-home beacon", () => {
    expect(treeIndicators(baseSpec({ published: true })).published).toBe(true);
    expect(treeIndicators(baseSpec()).published).toBe(false);
  });

  test("failure pip shows for failed lanes OR a halted/blocked state", () => {
    expect(treeIndicators(baseSpec({ failedCount: 1 })).failed).toBe(true);
    expect(treeIndicators(baseSpec({ state: "halted" })).failed).toBe(true);
    expect(treeIndicators(baseSpec({ state: "blocked" })).failed).toBe(true);
    expect(treeIndicators(baseSpec({ failedCount: 0, state: "active" })).failed).toBe(false);
  });

  test("progress arc only sweeps while executing and mid-flight", () => {
    expect(treeIndicators(baseSpec({ state: "active", progress: 55 })).progressArc).toBeCloseTo(0.55, 5);
    expect(treeIndicators(baseSpec({ state: "planning", progress: 10 })).progressArc).toBeCloseTo(0.1, 5);
    // Boundaries and non-executing states → no arc.
    expect(treeIndicators(baseSpec({ state: "active", progress: 0 })).progressArc).toBeNull();
    expect(treeIndicators(baseSpec({ state: "active", progress: 100 })).progressArc).toBeNull();
    expect(treeIndicators(baseSpec({ state: "paused", progress: 50 })).progressArc).toBeNull();
    expect(treeIndicators(baseSpec({ state: "completed", progress: 50 })).progressArc).toBeNull();
  });

  test("a built node never shows a live arc even if mislabeled as executing", () => {
    expect(treeIndicators(baseSpec({ stage: "built", state: "active", progress: 50 })).progressArc).toBeNull();
  });

  test("progress is clamped before it drives the arc", () => {
    expect(treeIndicators(baseSpec({ state: "active", progress: 150 })).progressArc).toBeNull();
    expect(treeIndicators(baseSpec({ state: "active", progress: -20 })).progressArc).toBeNull();
  });
});

describe("tree label helpers", () => {
  test("stageWord carries all three stages (and legacy absent = concept)", () => {
    expect(stageWord(undefined)).toBe("concept");
    expect(stageWord("concept")).toBe("concept");
    expect(stageWord("commissioned")).toBe("commissioned");
    expect(stageWord("built")).toBe("built");
  });

  test("treeStatus reads stage · state · progress with a steering marker", () => {
    expect(treeStatus(baseSpec({ stage: "built", state: "completed", progress: 100 }))).toBe(
      "built · completed · 100%",
    );
    expect(treeStatus(baseSpec({ steering: true }))).toContain("⟵ steering");
  });

  test("treeTitle prefers the inferred task, falling back to the callsign", () => {
    expect(treeTitle(baseSpec({ task: "Blocker announcer" }))).toBe("Blocker announcer");
    expect(treeTitle(baseSpec({ task: "" }))).toBe("Atlas");
  });
});
