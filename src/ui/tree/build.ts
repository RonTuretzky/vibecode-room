import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { hashSeed, mulberry32, type TreeAdornmentKind, type TreeSpec3D, type TreeVec3 } from "./spec";

// ── HD tree geometry builder ────────────────────────────────────────────────
// Turns a TreeSpec3D into renderable objects with a strict draw-call budget:
//   • ALL wood (trunk + branches + leaf petioles) = ONE merged tapered-tube
//     mesh under one bark material — a single draw call.
//   • Canopy foliage + every "leaf" adornment = ONE InstancedMesh of alpha-
//     tested leaf cards (per-instance color), swayed by rewriting instance
//     matrices in update(t) — no custom shaders.
//   • "crystal" / "marker" adornments and branch-tip buds = one InstancedMesh
//     per kind.
// ≈3-5 draw calls per tree, so a ~30-tree forest stays in the hundreds.
//
// Determinism: every organic variation (trunk lean, foliage scatter, leaf
// orientation) is seeded from spec/branch/adornment ids via mulberry32 — a
// rebuilt tree regrows the exact same shape, and LOD levels of one tree agree.
//
// Nothing here is pickable: every mesh gets a no-op raycast (consumers own
// their hit volumes), so hover raycasts never pay for canopy triangles.
//
// Lifetime: the small prototype geometries and the two canvas textures are
// module-level singletons that live for the page (same contract as the
// garden-flora photoscan cache); each BuiltTree owns its merged wood geometry,
// its materials and its instance buffers, and frees them in dispose().

export type TreeQuality = "high" | "medium" | "low";

export interface BuiltTree {
  // Add to the scene (a plain Group for buildTree, a THREE.LOD for
  // buildTreeLOD). The consumer positions it; the spec is origin-centred.
  group: THREE.Object3D;
  // Wind sway (vertex-cheap: instance matrices only). Call from the frame
  // loop; skip entirely under prefers-reduced-motion.
  update: (t: number) => void;
  // Removes the group from its parent and frees everything this tree owns.
  dispose: () => void;
}

interface QualityProfile {
  // Radial segments around the wood / the thin petioles.
  radial: number;
  radialThin: number;
  // Tube rings per world unit of curve length (clamped below).
  tubularPerUnit: number;
  // Canopy instance multiplier (0 = bare wood at the far level).
  foliageMul: number;
  // Leaf cards per "leaf" adornment tuft.
  leavesPerTuft: number;
  // Grow petiole stems (skipped far away — the leaves alone read fine).
  petioles: boolean;
}

const QUALITY: Record<TreeQuality, QualityProfile> = {
  high: { radial: 10, radialThin: 5, tubularPerUnit: 3.5, foliageMul: 1, leavesPerTuft: 3, petioles: true },
  medium: { radial: 7, radialThin: 4, tubularPerUnit: 2, foliageMul: 0.45, leavesPerTuft: 2, petioles: true },
  low: { radial: 5, radialThin: 3, tubularPerUnit: 1.2, foliageMul: 0.15, leavesPerTuft: 1, petioles: false },
};

// LOD switch distances (world units camera→tree). The desk rig orbits at
// radius 4-45, so a lone dialogue tree effectively always renders "high";
// a spread-out forest sheds detail across these bands.
export const TREE_LOD_MEDIUM = 48;
export const TREE_LOD_LOW = 110;

const vec3 = (v: TreeVec3): THREE.Vector3 => new THREE.Vector3(v.x, v.y, v.z);

const noRaycast = (): void => {};

// ── shared textures (page-lifetime singletons, like the flora cache) ────────

let barkTexCache: THREE.CanvasTexture | null = null;
function barkTexture(): THREE.CanvasTexture {
  if (barkTexCache !== null) {
    return barkTexCache;
  }
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  // Base bark tone around the garden trunk brown (0x4a3527), warmed slightly.
  ctx.fillStyle = "#4f3a29";
  ctx.fillRect(0, 0, size, size);
  const rng = mulberry32(0x8a4b17);
  // Vertical ridge streaks: broken light/dark strokes with x-jitter, so the
  // tube's around-the-trunk UVs read as real bark furrows, not banding.
  for (let i = 0; i < 150; i += 1) {
    const light = rng() > 0.52;
    const lum = light ? 96 + rng() * 46 : 34 + rng() * 26;
    ctx.strokeStyle = `rgba(${Math.round(lum * 1.16)},${Math.round(lum * 0.86)},${Math.round(lum * 0.6)},${(0.16 + rng() * 0.22).toFixed(2)})`;
    ctx.lineWidth = 1 + rng() * 2.4;
    const x = rng() * size;
    const drift = (rng() - 0.5) * 10;
    const y0 = rng() * size;
    const len = 22 + rng() * 60;
    ctx.beginPath();
    ctx.moveTo(x, y0);
    ctx.quadraticCurveTo(x + drift, y0 + len * 0.5, x + drift * 0.4, y0 + len);
    ctx.stroke();
  }
  // A few horizontal cracks.
  for (let i = 0; i < 14; i += 1) {
    ctx.strokeStyle = `rgba(24,16,10,${(0.2 + rng() * 0.25).toFixed(2)})`;
    ctx.lineWidth = 0.8 + rng() * 1.2;
    const y = rng() * size;
    const x0 = rng() * size;
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x0 + 8 + rng() * 22, y + (rng() - 0.5) * 6);
    ctx.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  barkTexCache = texture;
  return texture;
}

let leafTexCache: THREE.CanvasTexture | null = null;
function leafTexture(): THREE.CanvasTexture {
  if (leafTexCache !== null) {
    return leafTexCache;
  }
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  // Grayscale-luminance blade (instanceColor supplies the green): pointed
  // ellipse with a bright body, darker rim and midrib. Alpha-tested, so the
  // transparent surround gives the silhouette.
  const blade = (): void => {
    ctx.beginPath();
    ctx.moveTo(32, 62); // stem end (leaf base at canvas bottom)
    ctx.quadraticCurveTo(6, 44, 12, 18);
    ctx.quadraticCurveTo(20, 2, 32, 2); // tip
    ctx.quadraticCurveTo(44, 2, 52, 18);
    ctx.quadraticCurveTo(58, 44, 32, 62);
    ctx.closePath();
  };
  const shade = ctx.createLinearGradient(0, 62, 0, 2);
  shade.addColorStop(0, "#cfe0c2");
  shade.addColorStop(0.55, "#e9f4dd");
  shade.addColorStop(1, "#d8ecc8");
  blade();
  ctx.fillStyle = shade;
  ctx.fill();
  ctx.save();
  blade();
  ctx.clip();
  // Rim darkening.
  blade();
  ctx.strokeStyle = "rgba(52,74,40,0.55)";
  ctx.lineWidth = 5;
  ctx.stroke();
  // Midrib + side veins.
  ctx.strokeStyle = "rgba(84,110,66,0.5)";
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(32, 60);
  ctx.lineTo(32, 4);
  ctx.stroke();
  ctx.lineWidth = 0.9;
  for (const [y, dy] of [[50, -8], [40, -8], [30, -7], [20, -6]] as const) {
    ctx.beginPath();
    ctx.moveTo(32, y);
    ctx.lineTo(14, y + dy);
    ctx.moveTo(32, y);
    ctx.lineTo(50, y + dy);
    ctx.stroke();
  }
  ctx.restore();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  leafTexCache = texture;
  return texture;
}

// ── shared prototype geometries (page-lifetime singletons) ──────────────────

let leafGeoCache: THREE.BufferGeometry | null = null;
function leafGeometry(): THREE.BufferGeometry {
  if (leafGeoCache !== null) {
    return leafGeoCache;
  }
  // A slightly-bent leaf card, origin at the leaf BASE so sway pivots at the
  // stem: 0.5 × 0.72 world units, mid-row bowed 0.07 out of plane.
  const geometry = new THREE.PlaneGeometry(0.5, 0.72, 1, 2);
  geometry.translate(0, 0.36, 0);
  const position = geometry.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < position.count; i += 1) {
    const y = position.getY(i);
    if (y > 0.15 && y < 0.45) {
      position.setZ(i, 0.07);
    }
  }
  geometry.computeVertexNormals();
  leafGeoCache = geometry;
  return leafGeoCache;
}

let crystalGeoCache: THREE.BufferGeometry | null = null;
function crystalGeometry(): THREE.BufferGeometry {
  crystalGeoCache ??= new THREE.OctahedronGeometry(0.5, 0);
  return crystalGeoCache;
}

let markerGeoCache: THREE.BufferGeometry | null = null;
function markerGeometry(): THREE.BufferGeometry {
  markerGeoCache ??= new THREE.SphereGeometry(0.14, 10, 8);
  return markerGeoCache;
}

let budGeoCache: THREE.BufferGeometry | null = null;
function budGeometry(): THREE.BufferGeometry {
  budGeoCache ??= new THREE.SphereGeometry(0.09, 8, 6);
  return budGeoCache;
}

// ── tapered tube (the wood primitive) ───────────────────────────────────────
// THREE.TubeGeometry is constant-radius; real wood tapers. Same construction
// (Frenet frames along the curve) with a radius profile over t.
function taperedTubeGeometry(
  curve: THREE.Curve<THREE.Vector3>,
  tubularSegments: number,
  radialSegments: number,
  radiusAt: (t: number) => number,
  vScale: number,
): THREE.BufferGeometry {
  const frames = curve.computeFrenetFrames(tubularSegments, false);
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const P = new THREE.Vector3();
  const N = new THREE.Vector3();
  for (let i = 0; i <= tubularSegments; i += 1) {
    const t = i / tubularSegments;
    curve.getPointAt(t, P);
    const radius = radiusAt(t);
    for (let j = 0; j <= radialSegments; j += 1) {
      const v = (j / radialSegments) * Math.PI * 2;
      const sin = Math.sin(v);
      const cos = -Math.cos(v);
      N.copy(frames.normals[i]).multiplyScalar(cos).addScaledVector(frames.binormals[i], sin);
      normals.push(N.x, N.y, N.z);
      positions.push(P.x + radius * N.x, P.y + radius * N.y, P.z + radius * N.z);
      // u wraps the girth twice (denser furrows); v runs along the length,
      // scaled so bark detail density is uniform across trunk and twigs.
      uvs.push((j / radialSegments) * 2, t * vScale);
    }
  }
  const stride = radialSegments + 1;
  for (let i = 0; i < tubularSegments; i += 1) {
    for (let j = 0; j < radialSegments; j += 1) {
      const a = i * stride + j;
      const b = (i + 1) * stride + j;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

// One swaying leaf-card instance: static base transform + its wind params.
interface SwayInstance {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: number;
  phase: number;
  amp: number;
}

// Scratch objects for the per-frame instance-matrix sway (module-level:
// single-threaded, and update() never allocates).
const swayMatrix = new THREE.Matrix4();
const swayEuler = new THREE.Euler();
const swayQuat = new THREE.Quaternion();
const swayScale = new THREE.Vector3();

function randomLeafQuaternion(rng: () => number): THREE.Quaternion {
  swayEuler.set((rng() - 0.5) * 1.9, rng() * Math.PI * 2, (rng() - 0.5) * 1.9);
  return new THREE.Quaternion().setFromEuler(swayEuler);
}

export function buildTree(spec: TreeSpec3D, quality: TreeQuality): BuiltTree {
  const q = QUALITY[quality];
  const group = new THREE.Group();
  const ownedGeometries: THREE.BufferGeometry[] = [];
  const ownedMaterials: THREE.Material[] = [];
  const instancedMeshes: THREE.InstancedMesh[] = [];

  // ── wood: trunk + branches + petioles merged into ONE geometry ────────────
  const woodParts: THREE.BufferGeometry[] = [];
  const trunkRng = mulberry32(hashSeed(`${spec.id}:trunk`));
  const { height, radius } = spec.trunk;
  // Trunk spine: rooted below ground, with a subtle seeded S-lean kept well
  // inside the wood radius so branch attachments (on the axis) stay buried.
  const lean = Math.min(0.35 * radius, 0.16);
  const trunkPoints = [
    new THREE.Vector3(0, -0.5, 0),
    new THREE.Vector3((trunkRng() - 0.5) * 2 * lean, height * 0.3, (trunkRng() - 0.5) * 2 * lean),
    new THREE.Vector3((trunkRng() - 0.5) * 2 * lean, height * 0.62, (trunkRng() - 0.5) * 2 * lean),
    new THREE.Vector3((trunkRng() - 0.5) * 2 * lean, height * 0.86, (trunkRng() - 0.5) * 2 * lean),
    new THREE.Vector3((trunkRng() - 0.5) * lean, height, 0),
  ];
  const trunkCurve = new THREE.CatmullRomCurve3(trunkPoints);
  const trunkLength = height + 0.5;
  const trunkSegments = Math.max(6, Math.round(trunkLength * q.tubularPerUnit));
  woodParts.push(
    taperedTubeGeometry(
      trunkCurve,
      trunkSegments,
      q.radial,
      (t) => {
        // Smooth taper with a root flare at the base.
        const taper = radius * (0.22 + 0.78 * (1 - t) ** 1.3);
        const flare = radius * 0.6 * Math.max(0, 1 - t / 0.14) ** 2;
        return taper + flare;
      },
      trunkLength * 0.8,
    ),
  );
  // Branch curves are shared by the wood, the seeded sub-twigs and the canopy
  // scatter, so build them once.
  const branchCurves = new Map<string, THREE.CatmullRomCurve3>();
  // Small seeded sub-twigs fork off each branch (silhouette complexity — a
  // bare tube with clusters reads synthetic). Deterministic per branch id, so
  // every LOD level agrees; each twig also carries a leaf cluster at its tip.
  interface Twig {
    curve: THREE.CatmullRomCurve3;
    thickness: number;
  }
  const twigsByBranch = new Map<string, Twig[]>();
  const yAxis = new THREE.Vector3(0, 1, 0);
  for (const branch of spec.branches) {
    if (branch.points.length < 2) {
      continue;
    }
    const curve = new THREE.CatmullRomCurve3(branch.points.map(vec3));
    branchCurves.set(branch.id, curve);
    const twigRng = mulberry32(hashSeed(`${spec.id}:twigs:${branch.id}`));
    const twigs: Twig[] = [];
    for (const t0 of [0.45, 0.72]) {
      const base = curve.getPoint(t0);
      const dir = curve.getTangent(t0);
      dir.applyAxisAngle(yAxis, (twigRng() > 0.5 ? 1 : -1) * (0.6 + twigRng() * 0.5));
      dir.y = Math.abs(dir.y) * 0.4 + 0.3 + twigRng() * 0.25;
      dir.normalize();
      const twigLength = 0.7 + twigRng() * 0.7;
      const mid = base.clone().addScaledVector(dir, twigLength * 0.5).add(new THREE.Vector3(0, 0.08, 0));
      const tip = base
        .clone()
        .addScaledVector(dir, twigLength)
        .add(new THREE.Vector3(0, 0.18 + twigRng() * 0.15, 0));
      twigs.push({
        curve: new THREE.CatmullRomCurve3([base, mid, tip]),
        thickness: Math.max(0.035, branch.thickness * 0.45),
      });
    }
    twigsByBranch.set(branch.id, twigs);
  }
  for (const branch of spec.branches) {
    const curve = branchCurves.get(branch.id);
    if (curve === undefined) {
      continue;
    }
    const length = curve.getLength();
    const segments = Math.max(5, Math.round(length * q.tubularPerUnit));
    woodParts.push(
      taperedTubeGeometry(
        curve,
        segments,
        q.radial,
        (t) => Math.max(0.02, branch.thickness * (1 - t) ** 1.2 + 0.012),
        length * 0.8,
      ),
    );
    for (const twig of twigsByBranch.get(branch.id) ?? []) {
      woodParts.push(taperedTubeGeometry(twig.curve, 5, q.radialThin, (t) => twig.thickness * (1 - t) + 0.014, 1.2));
    }
  }
  if (q.petioles) {
    for (const adornment of spec.adornments ?? []) {
      if (adornment.kind !== "leaf" || adornment.stem === undefined) {
        continue;
      }
      const stem = vec3(adornment.stem);
      const tip = vec3(adornment.position);
      const mid = stem.clone().lerp(tip, 0.5).add(new THREE.Vector3(0, -0.06, 0));
      const curve = new THREE.CatmullRomCurve3([stem, mid, tip]);
      woodParts.push(taperedTubeGeometry(curve, 4, q.radialThin, (t) => 0.026 - t * 0.012, 1));
    }
  }
  const woodGeometry = mergeGeometries(woodParts, false);
  for (const part of woodParts) {
    part.dispose(); // merged copy owns the data now
  }
  if (woodGeometry !== null) {
    const barkMat = new THREE.MeshStandardMaterial({
      map: barkTexture(),
      roughness: 0.92,
      metalness: 0,
      emissive: new THREE.Color(0x3a2b1e),
      emissiveIntensity: 0.08,
    });
    const wood = new THREE.Mesh(woodGeometry, barkMat);
    wood.raycast = noRaycast;
    group.add(wood);
    ownedGeometries.push(woodGeometry);
    ownedMaterials.push(barkMat);
  }

  // ── foliage: canopy scatter + leaf-adornment tufts, ONE InstancedMesh ─────
  const sway: SwayInstance[] = [];
  const swayColors: THREE.Color[] = [];
  const foliage = spec.foliage;
  if (foliage !== undefined && foliage.density > 0 && q.foliageMul > 0 && foliage.palette.length > 0) {
    const palette = foliage.palette.map((c) => new THREE.Color(c));
    const scatter = (rng: () => number, at: THREE.Vector3, spreadXZ: number, spreadY: number, count: number) => {
      for (let i = 0; i < count; i += 1) {
        const theta = rng() * Math.PI * 2;
        const r = spreadXZ * Math.sqrt(rng());
        const position = new THREE.Vector3(
          at.x + Math.cos(theta) * r,
          at.y + (rng() - 0.35) * spreadY,
          at.z + Math.sin(theta) * r,
        );
        sway.push({
          position,
          quaternion: randomLeafQuaternion(rng),
          scale: 0.8 + rng() * 0.8,
          phase: rng() * Math.PI * 2,
          amp: 0.05 + rng() * 0.06,
        });
        swayColors.push(palette[Math.floor(rng() * palette.length)].clone().offsetHSL(0, 0, (rng() - 0.5) * 0.07));
      }
    };
    const P = new THREE.Vector3();
    for (const branch of spec.branches) {
      const curve = branchCurves.get(branch.id);
      if (curve === undefined) {
        continue;
      }
      const length = curve.getLength();
      const rng = mulberry32(hashSeed(`${spec.id}:foliage:${branch.id}`));
      const count = Math.round(Math.min(90, Math.max(28, length * 14)) * foliage.density * q.foliageMul);
      for (let i = 0; i < count; i += 1) {
        // Bias clusters toward the outer branch (sqrt skews t → 1).
        const t = 0.34 + 0.66 * Math.sqrt(rng());
        curve.getPoint(t, P);
        scatter(rng, P, 0.42 + t * 0.55, 0.7, 1);
      }
      // A tuft at every sub-twig tip.
      for (const twig of twigsByBranch.get(branch.id) ?? []) {
        twig.curve.getPoint(1, P);
        scatter(rng, P, 0.5, 0.55, Math.round(9 * foliage.density * q.foliageMul));
      }
    }
    // Crown tuft at the trunk top so the tree reads as a full canopy.
    const crownRng = mulberry32(hashSeed(`${spec.id}:crown`));
    scatter(
      crownRng,
      new THREE.Vector3(0, height * 0.97, 0),
      1.15,
      1.5,
      Math.round(80 * foliage.density * q.foliageMul),
    );
  }
  // Leaf-adornment tufts (every quality: they carry data, not just looks).
  for (const adornment of spec.adornments ?? []) {
    if (adornment.kind !== "leaf") {
      continue;
    }
    const rng = mulberry32(hashSeed(`tuft:${adornment.id}`));
    const color = new THREE.Color(adornment.color);
    const at = vec3(adornment.position);
    for (let i = 0; i < q.leavesPerTuft; i += 1) {
      const theta = rng() * Math.PI * 2;
      const r = 0.12 + rng() * 0.16;
      sway.push({
        position: new THREE.Vector3(at.x + Math.cos(theta) * r, at.y - 0.06 + rng() * 0.1, at.z + Math.sin(theta) * r),
        quaternion: randomLeafQuaternion(rng),
        scale: (0.75 + rng() * 0.45) * adornment.scale,
        phase: rng() * Math.PI * 2,
        amp: 0.07 + rng() * 0.05,
      });
      swayColors.push(color.clone().offsetHSL(0, 0, (rng() - 0.5) * 0.06));
    }
  }
  let leaves: THREE.InstancedMesh | null = null;
  if (sway.length > 0) {
    const leafMat = new THREE.MeshStandardMaterial({
      map: leafTexture(),
      alphaTest: 0.45,
      side: THREE.DoubleSide,
      roughness: 0.85,
      metalness: 0,
    });
    leaves = new THREE.InstancedMesh(leafGeometry(), leafMat, sway.length);
    leaves.raycast = noRaycast;
    // Instance positions live in the matrices; geometry bounds would cull the
    // whole canopy wrongly.
    leaves.frustumCulled = false;
    for (let i = 0; i < sway.length; i += 1) {
      const inst = sway[i];
      swayMatrix.compose(inst.position, inst.quaternion, swayScale.setScalar(inst.scale));
      leaves.setMatrixAt(i, swayMatrix);
      leaves.setColorAt(i, swayColors[i]);
    }
    leaves.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    group.add(leaves);
    ownedMaterials.push(leafMat);
    instancedMeshes.push(leaves);
  }

  // ── crystal / marker adornments: one InstancedMesh per present kind ───────
  const staticKinds: [TreeAdornmentKind, () => THREE.BufferGeometry, THREE.MeshStandardMaterialParameters][] = [
    ["crystal", crystalGeometry, { roughness: 0.25, metalness: 0.2, flatShading: true }],
    ["marker", markerGeometry, { roughness: 0.5, metalness: 0 }],
  ];
  for (const [kind, protoGeometry, matParams] of staticKinds) {
    const items = (spec.adornments ?? []).filter((adornment) => adornment.kind === kind);
    if (items.length === 0) {
      continue;
    }
    const material = new THREE.MeshStandardMaterial(matParams);
    const mesh = new THREE.InstancedMesh(protoGeometry(), material, items.length);
    mesh.raycast = noRaycast;
    mesh.frustumCulled = false;
    const color = new THREE.Color();
    items.forEach((adornment, index) => {
      const rng = mulberry32(hashSeed(adornment.id));
      swayEuler.set(0, rng() * Math.PI * 2, 0);
      swayQuat.setFromEuler(swayEuler);
      swayMatrix.compose(vec3(adornment.position), swayQuat, swayScale.setScalar(adornment.scale));
      mesh.setMatrixAt(index, swayMatrix);
      mesh.setColorAt(index, color.set(adornment.color));
    });
    group.add(mesh);
    ownedMaterials.push(material);
    instancedMeshes.push(mesh);
  }

  // ── branch-tip buds: a small bright dot at every tip (chrome-less tips
  // still read; the dialogue tree layers its label sprites on top) ──────────
  const tips = spec.branches.filter((branch) => branch.tip !== undefined && branch.points.length > 0);
  if (tips.length > 0) {
    const budMat = new THREE.MeshBasicMaterial();
    const buds = new THREE.InstancedMesh(budGeometry(), budMat, tips.length);
    buds.raycast = noRaycast;
    buds.frustumCulled = false;
    const color = new THREE.Color();
    tips.forEach((branch, index) => {
      const tip = branch.points[branch.points.length - 1];
      swayMatrix.makeTranslation(tip.x, tip.y, tip.z);
      buds.setMatrixAt(index, swayMatrix);
      buds.setColorAt(index, color.set(branch.tip!.color));
    });
    group.add(buds);
    ownedMaterials.push(budMat);
    instancedMeshes.push(buds);
  }

  const update = (t: number): void => {
    if (leaves === null) {
      return;
    }
    for (let i = 0; i < sway.length; i += 1) {
      const inst = sway[i];
      swayEuler.set(
        Math.sin(t * 1.05 + inst.phase) * inst.amp,
        0,
        Math.cos(t * 0.83 + inst.phase * 1.31) * inst.amp,
      );
      swayQuat.setFromEuler(swayEuler).multiply(inst.quaternion);
      swayMatrix.compose(inst.position, swayQuat, swayScale.setScalar(inst.scale));
      leaves.setMatrixAt(i, swayMatrix);
    }
    leaves.instanceMatrix.needsUpdate = true;
  };

  const dispose = (): void => {
    group.removeFromParent();
    for (const mesh of instancedMeshes) {
      mesh.dispose(); // frees instanceMatrix/instanceColor GPU buffers
    }
    for (const geometry of ownedGeometries) {
      geometry.dispose();
    }
    for (const material of ownedMaterials) {
      material.dispose();
    }
  };

  return { group, update, dispose };
}

// A THREE.LOD wrapper: the same spec built at all three qualities, swapped by
// camera distance so a whole forest stays smooth. Only the visible level pays
// its sway update.
export function buildTreeLOD(spec: TreeSpec3D): BuiltTree {
  const levels: [BuiltTree, number][] = [
    [buildTree(spec, "high"), 0],
    [buildTree(spec, "medium"), TREE_LOD_MEDIUM],
    [buildTree(spec, "low"), TREE_LOD_LOW],
  ];
  const lod = new THREE.LOD();
  for (const [level, distance] of levels) {
    lod.addLevel(level.group, distance);
  }
  return {
    group: lod,
    update: (t) => {
      levels[lod.getCurrentLevel()]?.[0].update(t);
    },
    dispose: () => {
      lod.removeFromParent();
      for (const [level] of levels) {
        level.dispose();
      }
    },
  };
}
