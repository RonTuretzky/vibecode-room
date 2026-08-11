import { describe, expect, test } from "bun:test";
import {
  FRUIT_BUG_COLOR,
  FRUIT_CAP,
  FRUIT_DEFAULT_COLOR,
  FRUIT_ENHANCEMENT_COLOR,
  HOLO_ARC_STEPS,
  LIMB_BUD_COLOR,
  LIMB_BUD_PR_COLOR,
  LIMB_CAP,
  LIMB_HIT_MAX_LENGTH_FRAC,
  LIMB_HIT_MIN_RADIUS,
  LIMB_HIT_SAMPLES,
  LIMB_HIT_SPAN,
  SAPLING_LIMB_SCALE,
  fleetTreeSpec3D,
  fruitColor,
  fruitSignature,
  fruitSpecs,
  holoArcPoints,
  limbPoints,
  limbSignature,
  limbSpecs,
  limbTipCard,
  resolveScenePick,
  roomBranches,
  spineHitPoints,
  type IssueInfo,
  type ScenePickPayload,
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

describe("tree-limbs: fleetTreeSpec3D — the HD fleet-tree body (pure)", () => {
  const adopted = repo([
    { name: "main", commits: 40 },
    { name: "room/spoken-changes", commits: 3 },
    { name: "room/issue-12", commits: 1, prUrl: "https://github.com/acme/pr-triage/pull/7" },
  ]);

  test("adopted trees stand in the self tree's trunk family (5.5–10u, forest scale)", () => {
    const spec = fleetTreeSpec3D({ id: "upid_iris_913", grown: true, treeRepo: adopted });
    expect(spec.trunk.height).toBeGreaterThanOrEqual(5.5);
    expect(spec.trunk.height).toBeLessThanOrEqual(10);
    expect(spec.trunk.radius).toBeGreaterThan(0.25);
  });

  test("every room/* limb becomes a REAL engine branch with the tip-card text + pickable ref", () => {
    const spec = fleetTreeSpec3D({ id: "upid_iris_913", grown: true, treeRepo: adopted });
    const limbs = limbSpecs(adopted);
    const data = spec.branches.filter((branch) => branch.tip !== undefined);
    expect(data.map((branch) => branch.id)).toEqual(limbs.map((limb) => `limb:${limb.branch}`));
    data.forEach((branch, index) => {
      const card = limbTipCard(limbs[index]);
      expect(branch.tip).toMatchObject({
        kind: "status",
        label: card.title,
        sub: card.sub,
        // The pick payload / POST target: the FULL branch ref.
        pickId: limbs[index].branch,
      });
      // Branch tips land EXACTLY where limbPoints puts them — the tip
      // bud/card/hit-sphere contract.
      const expected = limbPoints(limbs[index], spec.trunk.height, 1);
      expect(branch.points).toEqual(expected);
    });
  });

  test("tip buds go CI-green once a PR is open, calm blue before", () => {
    const spec = fleetTreeSpec3D({ id: "upid_iris_913", grown: true, treeRepo: adopted });
    const byRef = new Map(spec.branches.filter((b) => b.tip !== undefined).map((b) => [b.tip!.pickId, b.tip!.color]));
    expect(byRef.get("room/spoken-changes")).toBe(LIMB_BUD_COLOR);
    expect(byRef.get("room/issue-12")).toBe(LIMB_BUD_PR_COLOR);
  });

  test("local concept = a small young sapling; commissioned/built = full grown", () => {
    const sapling = fleetTreeSpec3D({ id: "upid_nova_44c", grown: false });
    const full = fleetTreeSpec3D({ id: "upid_nova_44c", grown: true });
    expect(sapling.trunk.height).toBeLessThan(3.2);
    expect(sapling.trunk.height).toBeLessThan(full.trunk.height / 2);
    expect(sapling.trunk.radius).toBeLessThan(full.trunk.radius);
    expect(sapling.foliage!.density).toBeLessThan(full.foliage!.density);
    // Sapling limbs/decor shrink with the body.
    const saplingReach = Math.max(
      ...sapling.branches.map((b) => Math.hypot(b.points.at(-1)!.x, b.points.at(-1)!.z)),
    );
    const fullReach = Math.max(...full.branches.map((b) => Math.hypot(b.points.at(-1)!.x, b.points.at(-1)!.z)));
    expect(saplingReach).toBeLessThan(fullReach * SAPLING_LIMB_SCALE + 0.01);
  });

  test("decorative fill branches carry NO tips (no cards, no buds, no picks)", () => {
    const spec = fleetTreeSpec3D({ id: "upid_iris_913", grown: true, treeRepo: adopted });
    const decor = spec.branches.filter((branch) => branch.id.startsWith("deco-"));
    expect(decor.length).toBeGreaterThan(0);
    for (const branch of decor) {
      expect(branch.tip).toBeUndefined();
    }
  });

  test("id-seeded determinism: same input regrows the identical individual, different ids differ", () => {
    const a = fleetTreeSpec3D({ id: "upid_iris_913", grown: true, treeRepo: adopted });
    const b = fleetTreeSpec3D({ id: "upid_iris_913", grown: true, treeRepo: adopted });
    expect(a).toEqual(b);
    const other = fleetTreeSpec3D({ id: "upid_nova_44c", grown: true, treeRepo: adopted });
    expect(other.trunk.height).not.toBe(a.trunk.height);
  });

  test("no repo data → still a full tree silhouette (decor only), never bare wood", () => {
    const spec = fleetTreeSpec3D({ id: "upid_solo_001", grown: true, treeRepo: null });
    expect(spec.branches.length).toBeGreaterThanOrEqual(2);
    expect(spec.branches.every((branch) => branch.tip === undefined)).toBe(true);
    expect(spec.foliage!.palette.length).toBeGreaterThan(0);
  });
});


// PER-LIMB HIT VOLUMES: the wood never raycasts, so before these the only
// pick target on a 3-unit branch was a 0.85-unit tip sphere. These spheres
// make the WHOLE limb clickable without covering the trunk (a trunk click
// must still open the tree menu).
describe("tree-limbs: per-limb hit volumes (pure)", () => {
  const limb = () => limbSpecs(repo([{ name: "room/spoken-changes", commits: 3 }]))[0];

  // Distance from `point` to the polyline the spine draws — zero (within
  // float noise) means the volume sits ON the wood.
  const distanceToSpine = (point: { x: number; y: number; z: number }, spine: ReturnType<typeof limbPoints>): number => {
    let best = Infinity;
    for (let index = 1; index < spine.length; index += 1) {
      const a = spine[index - 1];
      const b = spine[index];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dz = b.z - a.z;
      const lengthSq = dx * dx + dy * dy + dz * dz;
      const t =
        lengthSq === 0
          ? 0
          : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy + (point.z - a.z) * dz) / lengthSq));
      best = Math.min(
        best,
        Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t), point.z - (a.z + dz * t)),
      );
    }
    return best;
  };

  test("every volume sits ON the spine, none at the buried attachment or past the tip", () => {
    const spine = limbPoints(limb(), 6, 1);
    const volumes = spineHitPoints(spine, 0.12);
    expect(volumes).toHaveLength(LIMB_HIT_SAMPLES);
    const attachment = spine[0];
    const tip = spine[spine.length - 1];
    const spineLength = Math.hypot(tip.x - attachment.x, tip.y - attachment.y, tip.z - attachment.z);
    for (const volume of volumes) {
      expect(distanceToSpine(volume.at, spine)).toBeLessThan(1e-9);
      // Clear of the trunk: the nearest volume still starts past half the
      // limb, so a click on the trunk keeps opening the whole-tree menu.
      const outward = Math.hypot(volume.at.x - attachment.x, volume.at.z - attachment.z);
      expect(outward).toBeGreaterThan(spineLength * LIMB_HIT_SPAN[0] * 0.6);
      expect(volume.at).not.toEqual(attachment);
      expect(volume.at).not.toEqual(tip);
    }
  });

  test("the count is FIXED per limb — a busy branch never multiplies the mesh budget", () => {
    const quiet = limbSpecs(repo([{ name: "room/a", commits: 0 }]))[0];
    const busy = limbSpecs(repo([{ name: "room/a", commits: 400 }]))[0];
    expect(spineHitPoints(limbPoints(quiet, 6, 1), 0.09)).toHaveLength(LIMB_HIT_SAMPLES);
    expect(spineHitPoints(limbPoints(busy, 6, 1), 0.2)).toHaveLength(LIMB_HIT_SAMPLES);
    // A denser tessellation of the SAME spine is still the same volume count.
    const dense = [...limbPoints(busy, 6, 1), ...limbPoints(busy, 6, 1)];
    expect(spineHitPoints(dense, 0.2)).toHaveLength(LIMB_HIT_SAMPLES);
  });

  test("radius: a projector-coarse floor, capped so a stubby limb never swallows its trunk", () => {
    const arcLength = (spine: ReturnType<typeof limbPoints>): number => {
      let total = 0;
      for (let index = 1; index < spine.length; index += 1) {
        total += Math.hypot(
          spine[index].x - spine[index - 1].x,
          spine[index].y - spine[index - 1].y,
          spine[index].z - spine[index - 1].z,
        );
      }
      return total;
    };
    // A hairline limb still gets a projector-coarse target.
    const full = limbPoints(limb(), 6, 1);
    expect(spineHitPoints(full, 0.001)[0].radius).toBe(LIMB_HIT_MIN_RADIUS);
    // A fat limb grows with its thickness — until the length cap bites.
    const cap = arcLength(full) * LIMB_HIT_MAX_LENGTH_FRAC;
    expect(spineHitPoints(full, 0.1)[0].radius).toBeCloseTo(Math.min(0.5, cap), 5);
    expect(spineHitPoints(full, 0.4)[0].radius).toBeCloseTo(cap, 5);
    // Sapling-scale limb: the cap, not the floor, decides.
    const short = limbPoints(limb(), 6, 0.25);
    expect(spineHitPoints(short, 0.5)[0].radius).toBeCloseTo(arcLength(short) * LIMB_HIT_MAX_LENGTH_FRAC, 5);
    expect(spineHitPoints(short, 0.5)[0].radius).toBeLessThan(LIMB_HIT_MIN_RADIUS);
  });

  test("degenerate spines grow nothing (a point, or all points coincident)", () => {
    expect(spineHitPoints([], 0.1)).toEqual([]);
    expect(spineHitPoints([{ x: 0, y: 1, z: 0 }], 0.1)).toEqual([]);
    expect(spineHitPoints([{ x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 0 }], 0.1)).toEqual([]);
  });
});

// PICK PRECEDENCE: the coarse whole-tree volume geometrically encloses its
// own limbs and fruit, so nearest-wins hid every sub-target (the live-room
// report: "the whole tree seems to have one hitbox").
describe("tree-limbs: scene pick precedence (pure)", () => {
  // The metres-wide invisible proxy for a body that never raycasts…
  const canopy = (callsign: string): ScenePickPayload => ({ kind: "process", callsign, coarse: true });
  // …and the volume that hugs the actual trunk wood.
  const trunk = (callsign: string): ScenePickPayload => ({ kind: "process", callsign, trunk: true });
  // A limb's TIP: real, visible chrome (bud + PR card) with a modest sphere.
  const branch = (callsign: string, name: string): ScenePickPayload => ({ kind: "branch", callsign, branch: name });
  // A volume strung ALONG the wood: invisible and several times fatter than
  // the limb it stands for.
  const spine = (callsign: string, name: string): ScenePickPayload => ({
    kind: "branch",
    callsign,
    branch: name,
    alongLimb: true,
  });
  const fruit = (callsign: string, number: number): ScenePickPayload => ({ kind: "issue", callsign, number });

  test("a branch INSIDE its own tree's coarse volume outranks that proxy", () => {
    expect(resolveScenePick([canopy("Atlas"), branch("Atlas", "room/spoken-changes")])).toEqual(
      branch("Atlas", "room/spoken-changes"),
    );
    // The NEAREST such branch wins when the ray skewers two limbs.
    expect(
      resolveScenePick([canopy("Atlas"), branch("Atlas", "room/near"), branch("Atlas", "room/far")]),
    ).toEqual(branch("Atlas", "room/near"));
  });

  test("issue fruit resolves the same way", () => {
    expect(resolveScenePick([canopy("Atlas"), fruit("Atlas", 12)])).toEqual(fruit("Atlas", 12));
  });

  test("THE TRUNK STILL OPENS THE TREE MENU: real wood in front of a limb wins", () => {
    // Ray order down a trunk click: the coarse proxy's near face, then the
    // trunk wood, then a limb standing behind it. The limb is occluded.
    expect(resolveScenePick([canopy("Atlas"), trunk("Atlas"), branch("Atlas", "room/behind")])).toEqual(
      trunk("Atlas"),
    );
    // A limb genuinely IN FRONT of the trunk is what the eye sees there.
    expect(resolveScenePick([canopy("Atlas"), branch("Atlas", "room/front"), trunk("Atlas")])).toEqual(
      branch("Atlas", "room/front"),
    );
    // And a nearest tight trunk hit never defers to anything.
    expect(resolveScenePick([trunk("Atlas"), branch("Atlas", "room/behind")])).toEqual(trunk("Atlas"));
  });

  test("a SPINE volume crossing in front of its own trunk yields the trunk back", () => {
    // The one place a sub-target loses: the spine spheres are invisible and
    // 3-15× the hairline wood, so where one blankets its own trunk the whole-
    // tree menu wins anyway. (Measured on the live self tree: this returns
    // 100% of the trunk silhouette for ~5% of each limb's pickable area.)
    expect(resolveScenePick([canopy("Atlas"), spine("Atlas", "room/front"), trunk("Atlas")])).toEqual(
      trunk("Atlas"),
    );
    // Off the trunk the spine volume is the whole point — it still wins.
    expect(resolveScenePick([canopy("Atlas"), spine("Atlas", "room/front")])).toEqual(
      spine("Atlas", "room/front"),
    );
    // A NEIGHBOUR's trunk never claims this tree's limb.
    expect(resolveScenePick([canopy("Atlas"), spine("Atlas", "room/mine"), trunk("Nova")])).toEqual(
      spine("Atlas", "room/mine"),
    );
    // The tip bud and the fruit are real visible chrome — they never yield.
    expect(resolveScenePick([canopy("Atlas"), branch("Atlas", "room/front"), trunk("Atlas")])).toEqual(
      branch("Atlas", "room/front"),
    );
    expect(resolveScenePick([canopy("Atlas"), fruit("Atlas", 12), trunk("Atlas")])).toEqual(fruit("Atlas", 12));
  });

  test("that yield generalises: a spine volume never covers its OWN tree's visible chrome", () => {
    // The trunk is not the only thing the oversized padding can blanket. A
    // neighbouring limb's bud (a glowing sphere with a floating PR card) and an
    // issue fruit are both drawn, both tighter than the 0.5-unit spine sphere,
    // and both belong to the same tree — so the pixel goes to what the eye
    // sees. Real rays over 3 seeded fleet trees: 88.5% of tips and 67.0% of
    // fruit resolve to themselves with this clause, 84.7% / 61.9% without.
    expect(
      resolveScenePick([canopy("Atlas"), spine("Atlas", "room/near"), branch("Atlas", "room/far")]),
    ).toEqual(branch("Atlas", "room/far"));
    expect(resolveScenePick([canopy("Atlas"), spine("Atlas", "room/near"), fruit("Atlas", 12)])).toEqual(
      fruit("Atlas", 12),
    );
    // …but only its OWN tree's: a neighbour's bud never claims this limb.
    expect(resolveScenePick([canopy("Atlas"), spine("Atlas", "room/mine"), branch("Nova", "room/other")])).toEqual(
      spine("Atlas", "room/mine"),
    );
    // A second spine volume is padding too — it cannot be the thing yielded to,
    // so two limbs crossing still resolve to the NEAREST of them.
    expect(resolveScenePick([canopy("Atlas"), spine("Atlas", "room/near"), spine("Atlas", "room/far")])).toEqual(
      spine("Atlas", "room/near"),
    );
    // The coarse canopy proxy is not chrome either — it never wins this way.
    expect(resolveScenePick([canopy("Atlas"), spine("Atlas", "room/mine")])).toEqual(spine("Atlas", "room/mine"));
  });

  test("a DIFFERENT tree's branch never hijacks a nearer trunk", () => {
    expect(resolveScenePick([canopy("Atlas"), branch("Nova", "room/other")])).toEqual(canopy("Atlas"));
    // …but this tree's own branch behind the neighbour's limb still wins.
    expect(
      resolveScenePick([canopy("Atlas"), branch("Nova", "room/other"), branch("Atlas", "room/mine")]),
    ).toEqual(branch("Atlas", "room/mine"));
  });

  test("a canopy-only ray still opens the tree menu — the affordance never lost", () => {
    expect(resolveScenePick([canopy("Atlas"), canopy("Atlas")])).toEqual(canopy("Atlas"));
    expect(resolveScenePick([canopy("Atlas")])).toEqual(canopy("Atlas"));
  });

  test("a nearest non-process payload wins outright (ideas, turns, research)", () => {
    const idea: ScenePickPayload = { kind: "idea", key: "idea_retro_wall" };
    expect(resolveScenePick([idea, canopy("Atlas"), branch("Atlas", "room/x")])).toEqual(idea);
    expect(resolveScenePick([branch("Atlas", "room/x"), canopy("Atlas")])).toEqual(branch("Atlas", "room/x"));
  });

  test("nothing crossed → null (the deliberate ground click that closes glass)", () => {
    expect(resolveScenePick([])).toBeNull();
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

  test("ADOPTION (remoteUrl appearing) is structural even with zero room/* branches", () => {
    // A fresh import lands with no room branches yet — limbSignature stays ""
    // on both sides, but treeIndicators.grown flips, so the HD body must
    // regrow at its adult trunk family the moment the tree is adopted.
    const local = spec({ stage: "concept" });
    const imported = spec({ stage: "concept", treeRepo: { branches: [{ name: "main", commits: 4 }], remoteUrl: "https://x" } });
    expect(treeSpecStructurallyChanged(local, imported)).toBe(true);
    expect(treeSpecStructurallyChanged(imported, spec({ stage: "concept", treeRepo: imported.treeRepo }))).toBe(false);
  });
});
