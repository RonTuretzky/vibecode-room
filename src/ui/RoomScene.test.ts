import { describe, expect, test } from "bun:test";
import {
  AUTO_FIT_CENTER_DRIFT,
  AUTO_FIT_INTERVAL_MS,
  AUTO_FIT_RADIUS_RATIO,
  AUTO_FIT_RESUME_MS,
  SELF_PROCESS_UPID,
  SELF_TREE_UPID,
  autoFitSuspended,
  dialogueBranchLength,
  dialogueBranchPoint,
  dialogueBranches,
  dialogueLeafPosition,
  dialogueLeafT,
  dialogueTrunkHeight,
  selfTreeLabel,
  selfTreeProcessSpec,
  shouldAutoRefit,
  stageWord,
  treeIndicators,
  treeSpecStructurallyChanged,
  treeStatus,
  treeTitle,
  visibleTreeSpecs,
  type AutoFitFraming,
  type DialogueNodeSpec,
  type DialogueTopicSpec,
  type TreeSpec,
} from "./RoomScene";
import type { SelfTreeSpec } from "./self-repo";
import {
  DIALOGUE_FALLBACK_BRANCH_ID,
  DIALOGUE_LEAF_PALETTE,
  DIALOGUE_TREE_ID,
  dialogueTreeSpec3D,
  treeSpecSignature,
} from "./tree";

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

// ── the self-repo garden tree ↔ the mirror process ──────────────────────────
// While self-rebuild is armed the HD repo tree REPLACES the mirror process's
// generic fleet tree and ADOPTS its live spec, so selecting the tree selects
// the mirror (→ click-steer arms → talking steers the room's own source).

// The pinned SELF process as App's treeSpecs useMemo projects it: upid "self"
// (src/self/commission.ts: SELF_UPID), callsign "mirror" (SELF_CALLSIGN).
function mirrorSpec(overrides: Partial<TreeSpec> = {}): TreeSpec {
  return baseSpec({ upid: SELF_PROCESS_UPID, callsign: "mirror", task: "Vibersyn Room", stage: "commissioned", ...overrides });
}

// A minimal forest-derived garden-tree input (two open PRs as branches).
const selfInput: SelfTreeSpec = {
  repo: "acme/vibecode-room",
  spec: {
    id: "repo:acme/vibecode-room",
    trunk: { height: 7, radius: 0.3 },
    branches: [
      { id: "pr-7", points: [{ x: 0, y: 3, z: 0 }, { x: 2, y: 5, z: 0 }], thickness: 0.12, tip: { kind: "status", color: 0x00ff88, label: "#7 Grow the self tree", sub: "pass" } },
      { id: "pr-9", points: [{ x: 0, y: 4, z: 0 }, { x: -2, y: 6, z: 1 }], thickness: 0.12, tip: { kind: "status", color: 0xff3b30, label: "#9 Fix CI", sub: "fail" } },
    ],
  },
};

describe("visibleTreeSpecs — the HD self tree replaces the mirror's fleet tree", () => {
  const fleet = [baseSpec(), mirrorSpec(), baseSpec({ upid: "u2", callsign: "Nova" })];

  test("skips the upid-'self' fleet spec while the self tree is present", () => {
    expect(visibleTreeSpecs(fleet, true).map((spec) => spec.upid)).toEqual(["u1", "u2"]);
  });

  test("keeps the mirror's fleet tree when the self tree is absent — never zero representations", () => {
    expect(visibleTreeSpecs(fleet, false)).toEqual(fleet);
  });

  test("a fleet without the pinned mirror passes through either way", () => {
    const noMirror = [baseSpec(), baseSpec({ upid: "u2", callsign: "Nova" })];
    expect(visibleTreeSpecs(noMirror, true)).toEqual(noMirror);
    expect(visibleTreeSpecs(noMirror, false)).toEqual(noMirror);
  });
});

describe("selfTreeProcessSpec — the HD tree IS the mirror's live spec", () => {
  test("adopts the mirror's TreeSpec verbatim when the fleet carries it", () => {
    const mirror = mirrorSpec({ state: "active", steering: true });
    expect(selfTreeProcessSpec(selfInput, [baseSpec(), mirror])).toBe(mirror);
  });

  test("pick payloads resolve to the MIRROR callsign — selecting the tree steers the room", () => {
    // buildSelfTree stamps every trunk/tip hit volume with
    // { kind: "process", callsign: <this spec's callsign> }.
    expect(selfTreeProcessSpec(selfInput, [mirrorSpec()]).callsign).toBe("mirror");
  });

  test("falls back to a sensible synthetic when the mirror spec is absent", () => {
    const fallback = selfTreeProcessSpec(selfInput, [baseSpec()]);
    expect(fallback).toMatchObject({
      upid: SELF_TREE_UPID,
      callsign: "acme/vibecode-room",
      state: "completed",
      stage: "built",
      steering: false,
    });
  });

  test("structural mirror changes (steering flip) rebuild the entry like any fleet tree", () => {
    // The reconcile gate reuses treeSpecStructurallyChanged on the adopted
    // spec, so the steering ring appears/vanishes with the live target.
    expect(treeSpecStructurallyChanged(mirrorSpec(), mirrorSpec({ steering: true }))).toBe(true);
  });
});

describe("selfTreeLabel — mirror title over the repo + PR-count chrome", () => {
  test("title reads the live mirror process; sub keeps repo + open-PR count", () => {
    expect(selfTreeLabel(selfInput, mirrorSpec())).toEqual({
      title: "Vibersyn Room",
      sub: "acme/vibecode-room · 2 open PRs",
    });
  });

  test("the live steering marker rides the sub line", () => {
    expect(selfTreeLabel(selfInput, mirrorSpec({ steering: true })).sub).toContain("⟵ steering");
  });

  test("fallback (no mirror pinned) titles by the repo and counts singular PRs", () => {
    const onePr = { ...selfInput, spec: { ...selfInput.spec, branches: selfInput.spec.branches.slice(0, 1) } };
    expect(selfTreeLabel(onePr, selfTreeProcessSpec(onePr, []))).toEqual({
      title: "acme/vibecode-room",
      sub: "acme/vibecode-room · 1 open PR",
    });
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

// ── the HD tree spec (dialogue layout → TreeSpec3D, pure) ───────────────────

describe("dialogueTreeSpec3D — HD tree spec from the tested layout", () => {
  const turns = [turn("t1", "a"), turn("t2", "b"), turn("t3", "a"), turn("t4", "b")];
  const topics = [topic("a"), topic("b")];

  test("trunk height matches dialogueTrunkHeight of the resolved branch count", () => {
    const spec = dialogueTreeSpec3D(turns, topics);
    expect(spec.id).toBe(DIALOGUE_TREE_ID);
    expect(spec.trunk.height).toBe(dialogueTrunkHeight(2));
    expect(spec.trunk.radius).toBeGreaterThan(0);
  });

  test("one branch per dialogueBranches entry, in order, with stable ids", () => {
    const spec = dialogueTreeSpec3D([...turns, turn("t5", "ghost")], topics);
    const branches = dialogueBranches([...turns, turn("t5", "ghost")], topics);
    expect(spec.branches.map((branch) => branch.id)).toEqual(
      branches.map((branch) => branch.topicId ?? DIALOGUE_FALLBACK_BRANCH_ID),
    );
  });

  test("branch endpoints are EXACT layout points — the raycast/label contract", () => {
    const spec = dialogueTreeSpec3D(turns, topics);
    const branches = dialogueBranches(turns, topics);
    const trunkHeight = dialogueTrunkHeight(branches.length);
    spec.branches.forEach((branchSpec, index) => {
      const length = dialogueBranchLength(branches[index].turnIds.length);
      const root = dialogueBranchPoint(index, branches.length, trunkHeight, length, 0);
      const tip = dialogueBranchPoint(index, branches.length, trunkHeight, length, 1);
      const first = branchSpec.points[0];
      const last = branchSpec.points[branchSpec.points.length - 1];
      expect(Math.hypot(first.x - root.x, first.y - root.y, first.z - root.z)).toBeLessThan(1e-9);
      expect(Math.hypot(last.x - tip.x, last.y - tip.y, last.z - tip.z)).toBeLessThan(1e-9);
    });
  });

  test("interior points wobble organically but stay near the tested curve", () => {
    const spec = dialogueTreeSpec3D(turns, topics);
    const branches = dialogueBranches(turns, topics);
    const trunkHeight = dialogueTrunkHeight(branches.length);
    let wobbled = 0;
    spec.branches.forEach((branchSpec, index) => {
      const length = dialogueBranchLength(branches[index].turnIds.length);
      const steps = branchSpec.points.length - 1;
      branchSpec.points.forEach((point, step) => {
        const base = dialogueBranchPoint(index, branches.length, trunkHeight, length, step / steps);
        const drift = Math.hypot(point.x - base.x, point.y - base.y, point.z - base.z);
        // Gentle: never further than ~12% of the branch length off the spine.
        expect(drift).toBeLessThan(length * 0.12);
        if (drift > 1e-6) {
          wobbled += 1;
        }
      });
    });
    expect(wobbled).toBeGreaterThan(0);
  });

  test("deterministic: the same conversation regrows the identical spec", () => {
    expect(dialogueTreeSpec3D(turns, topics)).toEqual(dialogueTreeSpec3D(turns, topics));
  });

  test("different branch ids grow different interior curves (seeded variation)", () => {
    const spec = dialogueTreeSpec3D([turn("t1", "a"), turn("t2", "b")], [topic("a"), topic("b")]);
    // Compare interior wobble OFFSETS (endpoint-relative drift differs even
    // though the two branches share length/membership).
    const branches = dialogueBranches([turn("t1", "a"), turn("t2", "b")], [topic("a"), topic("b")]);
    const trunkHeight = dialogueTrunkHeight(branches.length);
    const drifts = spec.branches.map((branchSpec, index) => {
      const length = dialogueBranchLength(branches[index].turnIds.length);
      const steps = branchSpec.points.length - 1;
      return branchSpec.points.map((point, step) => {
        const base = dialogueBranchPoint(index, branches.length, trunkHeight, length, step / steps);
        return Math.hypot(point.x - base.x, point.y - base.y, point.z - base.z).toFixed(5);
      });
    });
    expect(drifts[0]).not.toEqual(drifts[1]);
  });

  test("tips carry the topic label, member count and the freshest turn pickId", () => {
    const spec = dialogueTreeSpec3D(turns, topics);
    expect(spec.branches[0].tip).toMatchObject({ kind: "topic", label: "label a", sub: "2 turns", pickId: "t3" });
    expect(spec.branches[1].tip).toMatchObject({ sub: "2 turns", pickId: "t4" });
  });

  test("no topics → the fallback branch holds every turn and stays pickable", () => {
    const spec = dialogueTreeSpec3D([turn("t1"), turn("t2")], []);
    expect(spec.branches).toHaveLength(1);
    expect(spec.branches[0].id).toBe(DIALOGUE_FALLBACK_BRANCH_ID);
    expect(spec.branches[0].tip?.pickId).toBe("t2");
  });

  test("a leaf tuft adornment per windowed turn at the EXACT leaf slot, stemmed on the wood", () => {
    const spec = dialogueTreeSpec3D(turns, topics);
    const branches = dialogueBranches(turns, topics);
    const trunkHeight = dialogueTrunkHeight(branches.length);
    const tufts = (spec.adornments ?? []).filter((adornment) => adornment.kind === "leaf");
    expect(tufts.map((tuft) => tuft.id).sort()).toEqual(["tuft:t1", "tuft:t2", "tuft:t3", "tuft:t4"]);
    branches.forEach((branch, branchIndex) => {
      const length = dialogueBranchLength(branch.turnIds.length);
      branch.turnIds.forEach((turnId, memberIndex) => {
        const slot = dialogueLeafPosition(branchIndex, branches.length, trunkHeight, length, memberIndex, branch.turnIds.length);
        const tuft = tufts.find((candidate) => candidate.id === `tuft:${turnId}`)!;
        expect(Math.hypot(tuft.position.x - slot.x, tuft.position.y - slot.y, tuft.position.z - slot.z)).toBeLessThan(1e-9);
        // The petiole stem attaches on the branch, close to (but off) the leaf.
        expect(tuft.stem).toBeDefined();
        const stemGap = Math.hypot(tuft.stem!.x - slot.x, tuft.stem!.y - slot.y, tuft.stem!.z - slot.z);
        expect(stemGap).toBeGreaterThan(0.1);
        expect(stemGap).toBeLessThan(1.5);
        expect(DIALOGUE_LEAF_PALETTE).toContain(tuft.color);
      });
    });
  });

  test("empty conversation → empty spec (the tree costs nothing when research is off)", () => {
    const spec = dialogueTreeSpec3D([], []);
    expect(spec.branches).toEqual([]);
    expect(spec.adornments).toEqual([]);
  });

  test("foliage density grows with conversation size and clamps at 1", () => {
    const few = dialogueTreeSpec3D([turn("t1", "a")], [topic("a")]);
    const many = dialogueTreeSpec3D(
      Array.from({ length: 12 }, (_, i) => turn(`t${i}`, "a")),
      [topic("a")],
    );
    expect(many.foliage!.density).toBeGreaterThan(few.foliage!.density);
    const huge = dialogueTreeSpec3D(
      Array.from({ length: 40 }, (_, i) => turn(`t${i}`, `topic${i % 6}`)),
      Array.from({ length: 6 }, (_, i) => topic(`topic${i}`)),
    );
    expect(huge.foliage!.density).toBe(1);
  });
});

describe("treeSpecSignature — reconcile skips identical regrowth", () => {
  const turns = [turn("t1", "a"), turn("t2", "b")];
  const topics = [topic("a"), topic("b")];

  test("identical conversations sign identically", () => {
    expect(treeSpecSignature(dialogueTreeSpec3D(turns, topics))).toBe(
      treeSpecSignature(dialogueTreeSpec3D(turns, topics)),
    );
  });

  test("a new turn changes the signature (leaves + tip counts move)", () => {
    const before = treeSpecSignature(dialogueTreeSpec3D(turns, topics));
    const after = treeSpecSignature(dialogueTreeSpec3D([...turns, turn("t3", "a")], topics));
    expect(after).not.toBe(before);
  });

  test("a relabeled topic changes the signature (tip chrome must repaint)", () => {
    const renamed = [{ ...topic("a"), label: "renamed" }, topic("b")];
    expect(treeSpecSignature(dialogueTreeSpec3D(turns, renamed))).not.toBe(
      treeSpecSignature(dialogueTreeSpec3D(turns, topics)),
    );
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
    expect(AUTO_FIT_RADIUS_RATIO).toBeCloseTo(0.06, 5);
    expect(AUTO_FIT_CENTER_DRIFT).toBeCloseTo(0.3, 5);
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
