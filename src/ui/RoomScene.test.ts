import { describe, expect, test } from "bun:test";
import {
  AUTO_FIT_CENTER_DRIFT,
  AUTO_FIT_INTERVAL_MS,
  AUTO_FIT_RADIUS_RATIO,
  AUTO_FIT_RESUME_MS,
  autoFitSuspended,
  dialogueBranchLength,
  dialogueBranchPoint,
  dialogueBranches,
  dialogueLeafPosition,
  dialogueLeafT,
  dialogueTrunkHeight,
  shouldAutoRefit,
  stageWord,
  treeIndicators,
  treeSpecStructurallyChanged,
  treeStatus,
  treeTitle,
  type AutoFitFraming,
  type DialogueNodeSpec,
  type DialogueTopicSpec,
  type TreeSpec,
} from "./RoomScene";

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

describe("treeSpecStructurallyChanged — rebuild only on shape changes", () => {
  test("identical specs are not structural", () => {
    expect(treeSpecStructurallyChanged(baseSpec(), baseSpec())).toBe(false);
  });

  test("progress ticks alone are NOT structural — live builds update in place", () => {
    // The old comparison keyed on Math.round(progress), so a live build tore
    // down and regrew the whole entry on every 1% tick. Mid-flight ticks must
    // stay in-place updates.
    expect(treeSpecStructurallyChanged(baseSpec({ progress: 41 }), baseSpec({ progress: 42 }))).toBe(false);
    expect(treeSpecStructurallyChanged(baseSpec({ progress: 5 }), baseSpec({ progress: 95 }))).toBe(false);
  });

  test("identity / state / stage / steering / title transitions still rebuild", () => {
    expect(treeSpecStructurallyChanged(baseSpec(), baseSpec({ callsign: "Zephyr" }))).toBe(true);
    expect(treeSpecStructurallyChanged(baseSpec(), baseSpec({ state: "completed" }))).toBe(true);
    expect(treeSpecStructurallyChanged(baseSpec(), baseSpec({ stage: "commissioned" }))).toBe(true);
    expect(treeSpecStructurallyChanged(baseSpec({ stage: "commissioned" }), baseSpec({ stage: "built" }))).toBe(true);
    expect(treeSpecStructurallyChanged(baseSpec(), baseSpec({ steering: true }))).toBe(true);
    expect(treeSpecStructurallyChanged(baseSpec(), baseSpec({ task: "Renamed project" }))).toBe(true);
  });

  test("indicator changes (lanes, published, failures) still rebuild", () => {
    expect(treeSpecStructurallyChanged(baseSpec(), baseSpec({ builds: { building: 1, ready: 0, failed: 0 } }))).toBe(true);
    expect(treeSpecStructurallyChanged(baseSpec(), baseSpec({ published: true }))).toBe(true);
    expect(treeSpecStructurallyChanged(baseSpec(), baseSpec({ failedCount: 1 }))).toBe(true);
  });

  test("the live arc appearing or vanishing IS structural (its mesh only exists mid-flight)", () => {
    // 0% → mid-flight grows the arc mesh; hitting 100% removes it.
    expect(treeSpecStructurallyChanged(baseSpec({ progress: 0 }), baseSpec({ progress: 5 }))).toBe(true);
    expect(treeSpecStructurallyChanged(baseSpec({ progress: 95 }), baseSpec({ progress: 100 }))).toBe(true);
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

// ── the conversation tree layout ────────────────────────────────────────────

function turn(id: string, topicId?: string | null): DialogueNodeSpec {
  return { id, speaker: "speaker-1", text: `text of ${id}`, atMs: 0, topicId };
}

function topic(id: string, turnIds: string[] = []): DialogueTopicSpec {
  return { id, label: `label ${id}`, turnIds, freshAtMs: 0 };
}

describe("dialogueBranches — topic grouping with the never-vanish fallback", () => {
  test("groups turns under their topicId in window order", () => {
    const branches = dialogueBranches(
      [turn("t1", "a"), turn("t2", "b"), turn("t3", "a")],
      [topic("a"), topic("b")],
    );
    expect(branches.map((branch) => branch.topicId)).toEqual(["a", "b"]);
    expect(branches[0].turnIds).toEqual(["t1", "t3"]);
    expect(branches[1].turnIds).toEqual(["t2"]);
  });

  test("honors the topic's turnIds when the turn carries no topicId", () => {
    const branches = dialogueBranches([turn("t1"), turn("t2")], [topic("a", ["t2"])]);
    expect(branches.find((branch) => branch.topicId === "a")?.turnIds).toEqual(["t2"]);
    expect(branches.find((branch) => branch.topicId === null)?.turnIds).toEqual(["t1"]);
  });

  test("unmatched turns (unknown topicId) fall to a single fallback branch", () => {
    const branches = dialogueBranches([turn("t1", "ghost"), turn("t2", "ghost")], [topic("a")]);
    const fallback = branches[branches.length - 1];
    expect(fallback.topicId).toBeNull();
    expect(fallback.turnIds).toEqual(["t1", "t2"]);
  });

  test("no topics at all (server degraded) → one fallback branch holds every turn", () => {
    const branches = dialogueBranches([turn("t1"), turn("t2"), turn("t3")], []);
    expect(branches).toHaveLength(1);
    expect(branches[0].topicId).toBeNull();
    expect(branches[0].turnIds).toEqual(["t1", "t2", "t3"]);
  });

  test("every windowed turn lands on exactly one branch", () => {
    const turns = [turn("t1", "a"), turn("t2"), turn("t3", "nope"), turn("t4", "b")];
    const branches = dialogueBranches(turns, [topic("a"), topic("b", ["t2"])]);
    const placed = branches.flatMap((branch) => branch.turnIds);
    expect([...placed].sort()).toEqual(["t1", "t2", "t3", "t4"]);
    expect(placed).toHaveLength(new Set(placed).size);
  });

  test("empty in, empty out — the tree costs nothing when research is off", () => {
    expect(dialogueBranches([], [])).toEqual([]);
  });
});

describe("conversation tree layout math", () => {
  test("trunk height scales gently with topic count, clamped to ~4-9", () => {
    expect(dialogueTrunkHeight(0)).toBe(4);
    expect(dialogueTrunkHeight(3)).toBeGreaterThan(dialogueTrunkHeight(1));
    expect(dialogueTrunkHeight(50)).toBe(9);
  });

  test("branch length grows with membership and caps out", () => {
    expect(dialogueBranchLength(1)).toBe(3.2);
    expect(dialogueBranchLength(8)).toBeGreaterThan(dialogueBranchLength(4));
    expect(dialogueBranchLength(100)).toBe(7.5);
  });

  test("branches attach to the trunk axis and curve outward + upward", () => {
    const h = dialogueTrunkHeight(3);
    const root = dialogueBranchPoint(1, 3, h, 4, 0);
    // t=0 sits ON the trunk axis, above the meadow and below the crown.
    expect(Math.hypot(root.x, root.z)).toBeLessThan(1e-9);
    expect(root.y).toBeGreaterThan(0);
    expect(root.y).toBeLessThan(h);
    // Outward reach and height both rise monotonically along the branch.
    let lastRadial = 0;
    let lastY = root.y;
    for (const t of [0.25, 0.5, 0.75, 1]) {
      const p = dialogueBranchPoint(1, 3, h, 4, t);
      const radial = Math.hypot(p.x, p.z);
      expect(radial).toBeGreaterThan(lastRadial);
      expect(p.y).toBeGreaterThan(lastY);
      lastRadial = radial;
      lastY = p.y;
    }
    expect(lastRadial).toBeCloseTo(4, 5);
  });

  test("oldest topic attaches lowest; golden-angle azimuths separate branches", () => {
    const h = dialogueTrunkHeight(3);
    const first = dialogueBranchPoint(0, 3, h, 4, 0);
    const last = dialogueBranchPoint(2, 3, h, 4, 0);
    expect(first.y).toBeLessThan(last.y);
    const tipA = dialogueBranchPoint(0, 3, h, 4, 1);
    const tipB = dialogueBranchPoint(1, 3, h, 4, 1);
    expect(tipA.distanceTo(tipB)).toBeGreaterThan(2);
  });

  test("leaves order along the branch by recency, newest nearest the tip", () => {
    let last = 0;
    for (let j = 0; j < 5; j += 1) {
      const t = dialogueLeafT(j, 5);
      expect(t).toBeGreaterThan(last);
      expect(t).toBeLessThan(1);
      last = t;
    }
  });

  test("alternating leaf offsets keep neighbors separated", () => {
    const h = dialogueTrunkHeight(2);
    const len = dialogueBranchLength(6);
    for (let j = 0; j < 5; j += 1) {
      const a = dialogueLeafPosition(0, 2, h, len, j, 6);
      const b = dialogueLeafPosition(0, 2, h, len, j + 1, 6);
      expect(a.distanceTo(b)).toBeGreaterThan(0.5);
    }
  });
});

// ── continuous auto-framing (the ceiling projector's self-driving camera) ───

function framing(targetX: number, targetZ: number, radius: number): AutoFitFraming {
  return { targetX, targetZ, radius };
}

describe("shouldAutoRefit — hysteresis so idle scenes never twitch", () => {
  test("tuning constants pin the contract: 0.75s poll, 4s resume, 6% / 0.3u bands", () => {
    expect(AUTO_FIT_INTERVAL_MS).toBe(750);
    expect(AUTO_FIT_RESUME_MS).toBe(4000);
    expect(AUTO_FIT_RADIUS_RATIO).toBeCloseTo(0.1, 5);
    expect(AUTO_FIT_CENTER_DRIFT).toBeCloseTo(0.8, 5);
  });

  test("identical framing never refits — a completed refit is a fixed point", () => {
    const ideal = framing(4.2, -1.7, 23.4);
    expect(shouldAutoRefit({ ...ideal }, ideal)).toBe(false);
  });

  test("radius drift beyond 10% refits, growing out AND zooming back in", () => {
    expect(shouldAutoRefit(framing(0, 0, 10), framing(0, 0, 11.1))).toBe(true);
    expect(shouldAutoRefit(framing(0, 0, 10), framing(0, 0, 8.9))).toBe(true);
  });

  test("radius drift within 6% stays put", () => {
    expect(shouldAutoRefit(framing(0, 0, 10), framing(0, 0, 10.5))).toBe(false);
    expect(shouldAutoRefit(framing(0, 0, 10), framing(0, 0, 9.5))).toBe(false);
  });

  test("the 6% band is relative to the CURRENT radius", () => {
    // Same absolute +2 delta: negligible on a wide shot, decisive close in.
    expect(shouldAutoRefit(framing(0, 0, 40), framing(0, 0, 42))).toBe(false);
    expect(shouldAutoRefit(framing(0, 0, 8), framing(0, 0, 10))).toBe(true);
  });

  test("centre drift beyond 0.8 world units refits (euclidean — diagonals count)", () => {
    expect(shouldAutoRefit(framing(0, 0, 15), framing(0.9, 0, 15))).toBe(true);
    expect(shouldAutoRefit(framing(0, 0, 15), framing(0, -0.9, 15))).toBe(true);
    // hypot(0.6, 0.6) ≈ 0.85 > 0.8 although neither axis alone crosses it.
    expect(shouldAutoRefit(framing(0, 0, 15), framing(0.6, 0.6, 15))).toBe(true);
  });

  test("centre drift within 0.3 world units stays put (tight centering for the ceiling)", () => {
    expect(shouldAutoRefit(framing(0, 0, 15), framing(0.2, 0.1, 15))).toBe(false); // hypot ≈ 0.22
    expect(shouldAutoRefit(framing(3, -3, 15), framing(3.25, -3, 15))).toBe(false);
  });
});

describe("autoFitSuspended — manual camera input pauses the auto-framing", () => {
  test("a live drag or external pinch grab suspends regardless of timing", () => {
    expect(autoFitSuspended(1_000_000, -AUTO_FIT_RESUME_MS, true)).toBe(true);
  });

  test("stays suspended within 4s of the last input, resumes right after", () => {
    const lastInput = 10_000;
    expect(autoFitSuspended(lastInput + AUTO_FIT_RESUME_MS - 1, lastInput, false)).toBe(true);
    expect(autoFitSuspended(lastInput + AUTO_FIT_RESUME_MS, lastInput, false)).toBe(false);
  });

  test("a fresh window (input stamp seeded one resume-window in the past) is eligible at t=0", () => {
    expect(autoFitSuspended(0, -AUTO_FIT_RESUME_MS, false)).toBe(false);
  });
});
