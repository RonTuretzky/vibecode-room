// ── TreeSpec3D: the declarative HD-tree input ───────────────────────────────
// One tree = trunk + curved branches + instanced adornments, described as PURE
// DATA (no three.js): pure builders map a data source (today the dialogue
// layout, tomorrow a GitHub repo) into a TreeSpec3D, and build.ts turns a spec
// into geometry at a chosen quality. Keeping the spec pure is what makes the
// mapping unit-testable and the render side swappable (LOD levels are just the
// same spec built at different qualities).

export interface TreeVec3 {
  x: number;
  y: number;
  z: number;
}

export interface TreeTrunkSpec {
  // Trunk top height (world units above the tree origin).
  height: number;
  // Wood radius at breast height — the base flares wider, the top tapers.
  radius: number;
}

// What crowns a branch tip: the dialogue tree hangs a topic label there (via
// consumer-owned sprite chrome); the future forest colors PR tips by CI. The
// module itself renders a small emissive bud in `color` at every tip so a
// chrome-less consumer still reads the tips.
export interface TreeBranchTip {
  kind: "topic" | "status" | "plain";
  color: number;
  label?: string;
  sub?: string;
  // Consumer-side pick target id (the dialogue tree keys tips to their topic's
  // freshest turn). The module renders nothing for it — consumers add their
  // own hit volumes at the tip.
  pickId?: string | null;
}

export interface TreeBranchSpec3D {
  // Stable id — seeds the branch's deterministic organic curvature, so
  // re-renders (and re-builds at other LOD qualities) are pixel-stable.
  id: string;
  // Spine control points, attachment→tip. The first point should sit ON/IN the
  // trunk (the tapered tube starts inside the wood, hiding the joint); the
  // LAST point is the exact tip consumers hang labels/hits on.
  points: TreeVec3[];
  // Wood radius at the attachment; tapers to a fine tip.
  thickness: number;
  tip?: TreeBranchTip;
}

export type TreeAdornmentKind = "leaf" | "crystal" | "marker";

// A data-driven item ON the tree (leaf tuft at a dialogue turn, issue crystal,
// CI marker …). Rendered as ONE InstancedMesh per kind per tree.
export interface TreeAdornmentSpec {
  id: string;
  kind: TreeAdornmentKind;
  position: TreeVec3;
  // Tint (per-instance color).
  color: number;
  scale: number;
  // Where the adornment's petiole/filament meets the wood (leaf kind): the
  // builder grows a thin stem tube from here to `position`, merged into the
  // bark draw call.
  stem?: TreeVec3;
}

// Procedural canopy: leaf cards scattered along the outer branches + crown,
// deterministic per branch id. Density 0..1 scales instance counts (which
// quality then multiplies again for LOD).
export interface TreeFoliageSpec {
  density: number;
  // Leaf tint pool (instanceColor picks per instance, seeded).
  palette: number[];
}

export interface TreeSpec3D {
  // Stable per-tree id: seeds trunk curvature + foliage scatter.
  id: string;
  trunk: TreeTrunkSpec;
  branches: TreeBranchSpec3D[];
  foliage?: TreeFoliageSpec;
  adornments?: TreeAdornmentSpec[];
}

// Deterministic string→uint32 seed (same 31-multiplier family the scene uses
// for speaker colors) — all organic variation derives from ids through this,
// so a rebuilt tree always regrows the exact same shape.
export function hashSeed(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash = (Math.imul(hash, 31) + text.charCodeAt(index)) >>> 0;
  }
  return hash;
}

// Small deterministic PRNG (Mulberry32) for seeded scatter/curvature.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const f3 = (n: number): string => n.toFixed(3);
const v3 = (v: TreeVec3): string => `${f3(v.x)},${f3(v.y)},${f3(v.z)}`;

// Cheap structural signature of a spec: reconcile skips the rebuild when the
// tree it would grow is identical to the one standing (live rooms tick
// snapshots far more often than the conversation layout actually changes).
export function treeSpecSignature(spec: TreeSpec3D): string {
  const parts: string[] = [spec.id, `${f3(spec.trunk.height)}:${f3(spec.trunk.radius)}`];
  for (const branch of spec.branches) {
    const tip = branch.tip;
    const tipSig = tip === undefined ? "" : `${tip.kind}|${tip.color}|${tip.label ?? ""}|${tip.sub ?? ""}|${tip.pickId ?? ""}`;
    parts.push(`b:${branch.id}:${f3(branch.thickness)}:${branch.points.map(v3).join(";")}:${tipSig}`);
  }
  for (const adornment of spec.adornments ?? []) {
    parts.push(
      `a:${adornment.id}:${adornment.kind}:${v3(adornment.position)}:${adornment.color}:${f3(adornment.scale)}:${adornment.stem !== undefined ? v3(adornment.stem) : ""}`,
    );
  }
  const foliage = spec.foliage;
  if (foliage !== undefined) {
    parts.push(`f:${f3(foliage.density)}:${foliage.palette.join(",")}`);
  }
  return parts.join("\n");
}
