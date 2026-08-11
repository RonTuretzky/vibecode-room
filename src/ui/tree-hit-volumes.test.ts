import { describe, expect, test } from "bun:test";
import {
  MIN_CANOPY_HIT_RADIUS,
  hitVolumeContains,
  processHitCovers,
  processHitVolumes,
  type HitBounds,
  type HitVec3,
} from "./tree-hit-volumes";
import { fleetTreeSpec3D, holoArcPoints, type TreeRepoInfo } from "./tree-limbs";
import type { TreeSpec3D } from "./tree";

const adopted: TreeRepoInfo = {
  remoteUrl: "https://github.com/RonTuretzky/convent-profile",
  branches: [
    { name: "main", commits: 40 },
    { name: "room/spoken-changes", commits: 3 },
    { name: "room/issue-12", commits: 1, prUrl: "https://github.com/acme/x/pull/7" },
  ],
};

// The body's drawn bounds, modelled the way src/ui/tree/build.ts actually
// grows it: leaf clusters scatter around the branch curves (spreadXZ up to
// 0.97, spreadY 0.7), sub-twigs fork off at t=0.45/0.72 and run another
// 0.7–1.4u, and a crown tuft sits at (0, 0.97·height, 0) with spreadXZ 1.15 /
// spreadY 1.5. The trunk is rooted at y = -0.5. RoomScene measures the real
// thing with a THREE.Box3; this is the same envelope in pure arithmetic, so
// the coverage assertions below run headlessly.
const CANOPY_REACH = 2.4; // foliage spread + twig run past a branch point
const bodyBounds = (spec: TreeSpec3D): HitBounds => {
  const height = spec.trunk.height;
  const bounds: HitBounds = {
    min: { x: -1.15, y: -0.5, z: -1.15 },
    max: { x: 1.15, y: height * 0.97 + 0.975, z: 1.15 },
  };
  for (const branch of spec.branches) {
    for (const at of branch.points) {
      bounds.min.x = Math.min(bounds.min.x, at.x - CANOPY_REACH);
      bounds.min.y = Math.min(bounds.min.y, at.y - 0.25);
      bounds.min.z = Math.min(bounds.min.z, at.z - CANOPY_REACH);
      bounds.max.x = Math.max(bounds.max.x, at.x + CANOPY_REACH);
      bounds.max.y = Math.max(bounds.max.y, at.y + 0.46);
      bounds.max.z = Math.max(bounds.max.z, at.z + CANOPY_REACH);
    }
  }
  return bounds;
};

const reach = (at: HitVec3) => Math.hypot(at.x, at.z);

describe("tree-hit-volumes: the whole-tree process pick surface (pure)", () => {
  const grownSpec = fleetTreeSpec3D({ id: "upid_iris_913", grown: true, treeRepo: adopted });
  const grownBounds = bodyBounds(grownSpec);
  const grown = processHitVolumes(grownBounds, grownSpec.trunk);

  test("the plan is one fitted canopy ellipsoid plus one slim trunk column", () => {
    expect(grown.map((volume) => volume.id)).toEqual(["canopy", "trunk"]);
    expect(grown.map((volume) => volume.shape)).toEqual(["ellipsoid", "column"]);
  });

  test("THE REGRESSION: the drawn CROWN is clickable — a trunk-sized sphere leaves it dead", () => {
    const height = grownSpec.trunk.height;
    // Where build.ts puts the crown tuft: (0, 0.97·height, 0), scattering up
    // to 0.975 above it. This is the fattest thing on the projector wall and
    // the thing a hand naturally reaches for.
    const crown = { x: 0, y: height * 0.97, z: 0 };
    const crownTop = { x: 0, y: height * 0.97 + 0.9, z: 0 };
    expect(processHitCovers(grown, crown)).toBe(true);
    expect(processHitCovers(grown, crownTop)).toBe(true);
    // The pre-unification volume — SphereGeometry(max(1.6, H*0.34)) at 0.58H —
    // reached only y ≈ 7.1 on a 7.7u tree: the crown carried NO payload, the
    // click resolved to null and the pointer path read that as empty ground,
    // which CLOSES the menu. Lock the old shape as a proven miss so nobody
    // "simplifies" the plan back into it.
    const legacyRadius = Math.max(1.6, height * 0.34);
    const legacyCentreY = height * 0.58;
    expect(Math.hypot(crown.x, crown.y - legacyCentreY, crown.z)).toBeGreaterThan(legacyRadius);
  });

  test("every leaf-bearing branch point of the real body is covered", () => {
    for (const branch of grownSpec.branches) {
      for (const at of branch.points) {
        expect(processHitCovers(grown, at)).toBe(true);
      }
    }
  });

  test("every room/* branch TIP is covered, so a limb never hangs off a dead tree", () => {
    const tips = grownSpec.branches
      .filter((branch) => branch.tip?.pickId != null)
      .map((branch) => branch.points[branch.points.length - 1]);
    expect(tips.length).toBe(2);
    for (const tip of tips) {
      expect(processHitCovers(grown, tip)).toBe(true);
    }
  });

  test("DIAGONAL foliage is covered — the ellipsoid-in-a-box corner gap", () => {
    // An ellipsoid inscribed in the body's bounding box touches it only at the
    // six face centres, so leaf clusters thrown out along a DIAGONAL sit
    // nearer the corner and fall outside a snug fit — fully drawn on the wall,
    // yet carrying no payload. Clicking them resolves to nothing, and the
    // pointer path reads nothing as empty ground and CLOSES the menu.
    // Sampling the real engine's instance matrices found 41 such points across
    // 24 seeded bodies at the old 1.08 slack (10 at 1.15, 2 at 1.20, 0 at
    // 1.25); this is that failure in pure form. The scatter model is build.ts
    // verbatim: r = spreadXZ*sqrt(rng) around a branch curve point, so a
    // cluster reaches at most spreadXZ = 0.42 + t*0.55 in ANY xz direction,
    // including the diagonal, and (rng - 0.35)*0.7 in y.
    for (const branch of grownSpec.branches) {
      branch.points.forEach((at, index) => {
        const t = index / Math.max(branch.points.length - 1, 1);
        const spreadXZ = 0.42 + t * 0.55;
        for (const theta of [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4]) {
          for (const dy of [-0.35 * 0.7, 0.65 * 0.7]) {
            expect(
              processHitCovers(grown, {
                x: at.x + Math.cos(theta) * spreadXZ,
                y: at.y + dy,
                z: at.z + Math.sin(theta) * spreadXZ,
              }),
            ).toBe(true);
          }
        }
      });
    }
    // The crown tuft scatters widest of all: spreadXZ 1.15 / spreadY 1.5 about
    // (0, 0.97·height, 0) — the fattest target on the wall, diagonal included.
    const crownY = grownSpec.trunk.height * 0.97;
    for (const theta of [Math.PI / 4, (5 * Math.PI) / 4]) {
      expect(
        processHitCovers(grown, {
          x: Math.cos(theta) * 1.15,
          y: crownY + 0.65 * 1.5,
          z: Math.sin(theta) * 1.15,
        }),
      ).toBe(true);
    }
  });

  test("the issue-fruit bough hangs inside the pick surface", () => {
    for (const at of holoArcPoints("upid_iris_913", grownSpec.trunk.height, 1)) {
      expect(processHitCovers(grown, { x: at.x, y: at.y - 0.14, z: at.z })).toBe(true);
    }
  });

  test("the whole trunk axis is covered, root flare to top", () => {
    const height = grownSpec.trunk.height;
    for (let t = 0; t <= 1.0001; t += 0.1) {
      expect(processHitCovers(grown, { x: 0, y: height * t, z: 0 })).toBe(true);
    }
  });

  test("the trunk column stays slimmer than the shortest limb reach — trunk clicks are not stolen", () => {
    // A ray aimed at the trunk exits the column about `radius.x` behind the
    // axis. Any far-side limb volume sits at least `minReach` behind it, so
    // the column's far face is reported FIRST and the click opens the tree
    // menu rather than a branch popup.
    const column = grown[1];
    const minReach = Math.min(
      ...grownSpec.branches
        .filter((branch) => branch.tip?.pickId != null)
        .map((branch) => reach(branch.points[branch.points.length - 1])),
    );
    expect(column.radius.x).toBe(column.radius.z);
    expect(column.radius.x).toBeLessThan(minReach);
    // …and it still swallows the wood it is meant to cover.
    expect(column.radius.x).toBeGreaterThan(grownSpec.trunk.radius * 1.6);
  });

  test("the column TAPERS with the drawn wood — an untapered pole eats branch picks", () => {
    // build.ts draws the trunk tube at radius*(0.22 + 0.78*(1-t)^1.3) plus a
    // root flare of radius*0.6 at the base. The column must sheathe that
    // profile with a small, CONSTANT slop at every height: a straight column
    // of the flare radius is 5-9x the wood up top, and every branch bud behind
    // that phantom pole silently becomes a tree-menu click instead.
    const column = grown[1];
    const { height, radius } = grownSpec.trunk;
    expect(column.radiusTop).toBeLessThan(column.radius.x);
    const half = column.radius.y;
    for (let t = 0; t <= 1.0001; t += 0.1) {
      const y = column.center.y - half + 2 * half * t;
      const wood = radius * (0.22 + 0.78 * (1 - t) ** 1.3) + radius * 0.6 * Math.max(0, 1 - t / 0.14) ** 2;
      // Sheathes the wood…
      expect(hitVolumeContains(column, { x: wood, y, z: 0 })).toBe(true);
      // …but never balloons more than a hand's width past it.
      expect(hitVolumeContains(column, { x: wood + 0.9, y, z: 0 })).toBe(false);
    }
    // It spans the whole drawn stem: the engine roots the spine at y = -0.5.
    expect(column.center.y - half).toBeCloseTo(-0.5, 6);
    expect(column.center.y + half).toBeCloseTo(height, 6);
    // Above the tip and below the root it stops — only the canopy answers there.
    expect(hitVolumeContains(column, { x: 0, y: height + 0.2, z: 0 })).toBe(false);
    expect(hitVolumeContains(column, { x: 0, y: -0.8, z: 0 })).toBe(false);
  });

  test("empty ground stays empty — a deliberate click on nothing still closes the menu", () => {
    const away = { x: grownBounds.max.x + 3, y: 1, z: 0 };
    const overhead = { x: 0, y: grownBounds.max.y + 4, z: 0 };
    const nextSlot = { x: 13, y: 1, z: 0 }; // treePosition's 13-unit garden slots
    expect(processHitCovers(grown, away)).toBe(false);
    expect(processHitCovers(grown, overhead)).toBe(false);
    expect(processHitCovers(grown, nextSlot)).toBe(false);
  });

  test("a sapling still gets a target a dwell cursor can land on", () => {
    const spec = fleetTreeSpec3D({ id: "upid_seed_1", grown: false, treeRepo: null });
    const volumes = processHitVolumes(bodyBounds(spec), spec.trunk);
    expect(volumes[0].radius.x).toBeGreaterThanOrEqual(MIN_CANOPY_HIT_RADIUS);
    expect(volumes[0].radius.y).toBeGreaterThanOrEqual(MIN_CANOPY_HIT_RADIUS);
    for (const branch of spec.branches) {
      for (const at of branch.points) {
        expect(processHitCovers(volumes, at)).toBe(true);
      }
    }
    expect(processHitCovers(volumes, { x: 0, y: spec.trunk.height * 0.97, z: 0 })).toBe(true);
  });

  test("a degenerate/empty body still yields usable volumes rather than none", () => {
    const volumes = processHitVolumes({ min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } }, { height: 0, radius: 0 });
    expect(volumes.length).toBe(2);
    for (const volume of volumes) {
      expect(volume.radius.x).toBeGreaterThan(0);
      expect(volume.radius.y).toBeGreaterThan(0);
      expect(volume.radius.z).toBeGreaterThan(0);
    }
    expect(hitVolumeContains(volumes[0], { x: 0, y: 0, z: 0 })).toBe(true);
  });

  test("the plan is a pure function of bounds + trunk (same in, same out)", () => {
    expect(processHitVolumes(grownBounds, grownSpec.trunk)).toEqual(grown);
  });
});
