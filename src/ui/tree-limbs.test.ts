import { describe, expect, test } from "bun:test";
import {
  FRUIT_BUG_COLOR,
  FRUIT_CAP,
  FRUIT_DEFAULT_COLOR,
  FRUIT_ENHANCEMENT_COLOR,
  HOLO_ARC_STEPS,
  LIMB_CAP,
  fruitColor,
  fruitSignature,
  fruitSpecs,
  holoArcPoints,
  limbPoints,
  limbSignature,
  limbSpecs,
  limbTipCard,
  roomBranches,
  type IssueInfo,
  type TreeRepoInfo,
} from "./tree-limbs";
import { treeSpecStructurallyChanged, type TreeSpec } from "./RoomScene";

const repo = (branches: TreeRepoInfo["branches"]): TreeRepoInfo => ({
  branches,
  remoteUrl: "https://github.com/acme/pr-triage",
});

describe("tree-limbs: room/* branches → limb specs (pure)", () => {
  test("only room/* branches grow limbs — main and concept lanes never do", () => {
    const info = repo([
      { name: "main", commits: 40 },
      { name: "concept/smithers", commits: 3 },
      { name: "room/spoken-changes", commits: 2 },
      { name: "room/issue-12", commits: 0, prUrl: "https://github.com/acme/pr-triage/pull/7" },
    ]);
    expect(roomBranches(info).map((branch) => branch.name)).toEqual(["room/spoken-changes", "room/issue-12"]);
    const limbs = limbSpecs(info);
    expect(limbs).toHaveLength(2);
    expect(limbs[0].short).toBe("spoken-changes");
    expect(limbs[0].prUrl).toBeNull();
    expect(limbs[1].prUrl).toBe("https://github.com/acme/pr-triage/pull/7");
  });

  test("null/absent treeRepo derives ZERO limbs (local trees stay bare)", () => {
    expect(limbSpecs(null)).toEqual([]);
    expect(limbSpecs(undefined)).toEqual([]);
    expect(limbSpecs({ branches: [], remoteUrl: null })).toEqual([]);
  });

  test("length and thickness grow with commit count and CLAMP", () => {
    const fresh = limbSpecs(repo([{ name: "room/a", commits: 0 }]))[0];
    const worked = limbSpecs(repo([{ name: "room/a", commits: 6 }]))[0];
    const runaway = limbSpecs(repo([{ name: "room/a", commits: 5000 }]))[0];
    expect(worked.length).toBeGreaterThan(fresh.length);
    expect(worked.thickness).toBeGreaterThan(fresh.thickness);
    // The clamp: a runaway branch cannot outgrow the cap-sized limb.
    expect(runaway.length).toBe(limbSpecs(repo([{ name: "room/a", commits: 10 }]))[0].length);
    expect(runaway.thickness).toBe(limbSpecs(repo([{ name: "room/a", commits: 8 }]))[0].thickness);
  });

  test("limbs cap at LIMB_CAP and stay deterministic per branch name", () => {
    const many = repo(
      Array.from({ length: LIMB_CAP + 4 }, (_, index) => ({ name: `room/b${index}`, commits: index })),
    );
    expect(limbSpecs(many)).toHaveLength(LIMB_CAP);
    const a = limbSpecs(repo([{ name: "room/x", commits: 2 }]))[0];
    const b = limbSpecs(repo([{ name: "room/x", commits: 2 }]))[0];
    expect(a).toEqual(b);
  });

  test("limbPoints: attachment buried ON the trunk axis, tip exactly at length", () => {
    const limb = limbSpecs(repo([{ name: "room/spoken-changes", commits: 3 }]))[0];
    const points = limbPoints(limb, 6, 1);
    const first = points[0];
    expect(first.x).toBe(0);
    expect(first.z).toBe(0);
    expect(first.y).toBeCloseTo(6 * limb.yFrac, 5);
    // The seeded sway fades to ZERO at the tip, so the endpoint lands exactly
    // where the bud/card/hit sphere expect it.
    const tip = points[points.length - 1];
    expect(Math.hypot(tip.x, tip.z)).toBeCloseTo(limb.length, 5);
    // Scale shrinks the whole limb (sapling bodies grow smaller limbs).
    const halfTip = limbPoints(limb, 6, 0.5)[points.length - 1];
    expect(Math.hypot(halfTip.x, halfTip.z)).toBeCloseTo(limb.length * 0.5, 5);
  });

  test("limbTipCard: name + commit count, PR ✓ only once a PR exists", () => {
    const [one, three] = limbSpecs(
      repo([
        { name: "room/solo", commits: 1 },
        { name: "room/spoken-changes", commits: 3, prUrl: "https://github.com/acme/pr-triage/pull/9" },
      ]),
    );
    expect(limbTipCard(one)).toEqual({ title: "solo", sub: "1 commit" });
    expect(limbTipCard(three)).toEqual({ title: "spoken-changes", sub: "3 commits · PR ✓" });
  });

  test("limbSignature: commits/PR/branch changes flip it; non-room churn does not", () => {
    const base = repo([{ name: "room/a", commits: 1 }]);
    expect(limbSignature(base)).toBe(limbSignature(repo([{ name: "room/a", commits: 1 }])));
    expect(limbSignature(base)).not.toBe(limbSignature(repo([{ name: "room/a", commits: 2 }])));
    expect(limbSignature(base)).not.toBe(
      limbSignature(repo([{ name: "room/a", commits: 1, prUrl: "https://x/pull/1" }])),
    );
    expect(limbSignature(base)).not.toBe(
      limbSignature(repo([{ name: "room/a", commits: 1 }, { name: "room/b", commits: 0 }])),
    );
    // main ticking commits is NOT a limb change.
    expect(limbSignature(repo([{ name: "main", commits: 9 }, { name: "room/a", commits: 1 }]))).toBe(
      limbSignature(base),
    );
    expect(limbSignature(null)).toBe("");
  });
});

describe("tree-limbs: issue fruit (pure)", () => {
  const issue = (number: number, labels: string[], title = `Issue ${number}`): IssueInfo => ({
    number,
    title,
    labels,
  });

  test("fruit color from labels: bug=red, enhancement=green, else amber", () => {
    expect(fruitColor(["bug"])).toBe(FRUIT_BUG_COLOR);
    expect(fruitColor(["BUG"])).toBe(FRUIT_BUG_COLOR);
    expect(fruitColor(["enhancement"])).toBe(FRUIT_ENHANCEMENT_COLOR);
    expect(fruitColor(["Enhancement", "docs"])).toBe(FRUIT_ENHANCEMENT_COLOR);
    expect(fruitColor(["docs"])).toBe(FRUIT_DEFAULT_COLOR);
    expect(fruitColor([])).toBe(FRUIT_DEFAULT_COLOR);
    // Bug outranks enhancement when both hang on one issue.
    expect(fruitColor(["enhancement", "bug"])).toBe(FRUIT_BUG_COLOR);
  });

  test("fruitSpecs: caps at FRUIT_CAP, spaces t along the arc, keeps titles", () => {
    const specs = fruitSpecs([
      issue(1, ["bug"]),
      issue(2, ["enhancement"]),
      issue(3, []),
    ]);
    expect(specs.map((spec) => spec.number)).toEqual([1, 2, 3]);
    expect(specs.map((spec) => spec.color)).toEqual([
      FRUIT_BUG_COLOR,
      FRUIT_ENHANCEMENT_COLOR,
      FRUIT_DEFAULT_COLOR,
    ]);
    expect(specs.map((spec) => spec.t)).toEqual([1 / 4, 2 / 4, 3 / 4]);
    // Never bunched at either end.
    expect(specs[0].t).toBeGreaterThan(0);
    expect(specs[specs.length - 1].t).toBeLessThan(1);
    const many = fruitSpecs(Array.from({ length: FRUIT_CAP + 5 }, (_, index) => issue(index, [])));
    expect(many).toHaveLength(FRUIT_CAP);
    expect(fruitSpecs(null)).toEqual([]);
    expect(fruitSpecs(undefined)).toEqual([]);
  });

  test("holoArcPoints: deterministic, starts ON the trunk axis, full step count", () => {
    const a = holoArcPoints("upid_iris_913", 6, 1);
    const b = holoArcPoints("upid_iris_913", 6, 1);
    expect(a).toEqual(b);
    expect(a).toHaveLength(HOLO_ARC_STEPS + 1);
    expect(a[0].x).toBeCloseTo(0, 10);
    expect(a[0].z).toBeCloseTo(0, 10);
    // A different tree seeds a different azimuth (no lock-step boughs).
    const other = holoArcPoints("upid_nova_44c", 6, 1);
    expect(other[HOLO_ARC_STEPS].x).not.toBeCloseTo(a[HOLO_ARC_STEPS].x, 3);
  });

  test("fruitSignature: number/label changes flip it; title edits do not", () => {
    const base = [issue(1, ["bug"], "old title")];
    expect(fruitSignature(base)).toBe(fruitSignature([issue(1, ["bug"], "NEW title")]));
    expect(fruitSignature(base)).not.toBe(fruitSignature([issue(1, ["docs"])]));
    expect(fruitSignature(base)).not.toBe(fruitSignature([issue(1, ["bug"]), issue(2, [])]));
    expect(fruitSignature([])).toBe("");
    expect(fruitSignature(undefined)).toBe("");
  });
});

describe("tree-limbs: the scene's structural gate picks up limb/fruit changes", () => {
  const spec = (extra: Partial<TreeSpec>): TreeSpec => ({
    upid: "upid_iris_913",
    callsign: "Iris",
    state: "active",
    progress: 40,
    task: "PR triage dashboard",
    steering: false,
    stage: "commissioned",
    ...extra,
  });

  test("a room/* branch appearing (or committing, or opening a PR) regrows the entry", () => {
    const bare = spec({ treeRepo: { branches: [{ name: "main", commits: 4 }], remoteUrl: "https://x" } });
    const grown = spec({
      treeRepo: { branches: [{ name: "main", commits: 4 }, { name: "room/spoken-changes", commits: 0 }], remoteUrl: "https://x" },
    });
    expect(treeSpecStructurallyChanged(bare, grown)).toBe(true);
    const committed = spec({
      treeRepo: { branches: [{ name: "main", commits: 4 }, { name: "room/spoken-changes", commits: 1 }], remoteUrl: "https://x" },
    });
    expect(treeSpecStructurallyChanged(grown, committed)).toBe(true);
    // An unchanged snapshot tick stays a no-op.
    expect(treeSpecStructurallyChanged(grown, spec({ treeRepo: grown.treeRepo }))).toBe(false);
  });

  test("the issue set shifting regrows the entry; a title edit does not", () => {
    const bare = spec({});
    const fruity = spec({ issues: [{ number: 12, title: "Fix the drip", labels: ["bug"] }] });
    expect(treeSpecStructurallyChanged(bare, fruity)).toBe(true);
    expect(
      treeSpecStructurallyChanged(fruity, spec({ issues: [{ number: 12, title: "Fix the drip!", labels: ["bug"] }] })),
    ).toBe(false);
  });
});
