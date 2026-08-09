// Central Park ground layer (?park=1): the REAL park as a stylized diorama
// under the garden's trees. Baked OSM vector data (scripts/build-central-park.ts
// → public/assets/garden/central-park.json) renders as flat painterly layers —
// lawn/wood/garden patches, the actual water bodies (Reservoir, Lake, Harlem
// Meer…), every footpath as a sand ribbon — plus one InstancedMesh of low-poly
// trees standing where the park's individually-surveyed trees really stand.
// The whole layer is ~7 draw calls. Data © OpenStreetMap contributors (ODbL).

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { mulberry32 } from "./tree/spec";

export interface CentralParkLayout {
  meta: { name: string; lengthM: number; widthM: number; license: string };
  // Rings/polylines are flat [x0, z0, x1, z1, …] arrays in PARK METERS,
  // centered on the park, long axis along +X (see the bake script).
  outline: number[];
  water: number[][];
  lawns: number[][];
  gardens: number[][];
  woods: number[][];
  paths: { k: string; pts: number[] }[];
  trees: number[];
}

let layoutPromise: Promise<CentralParkLayout> | null = null;

// Fetch the baked layout once per page (same caching idea as garden-flora).
export function loadCentralParkLayout(): Promise<CentralParkLayout> {
  layoutPromise ??= fetch("/assets/garden/central-park.json").then((res) => {
    if (!res.ok) {
      throw new Error(`central-park.json fetch failed: ${res.status}`);
    }
    return res.json() as Promise<CentralParkLayout>;
  });
  return layoutPromise;
}

export interface CentralParkBuild {
  group: THREE.Group;
  // World-coordinate water test — the flora scatter uses it so grass and
  // jacarandas never sprout out of the Reservoir.
  isWater: (x: number, z: number) => boolean;
  dispose: () => void;
}

// Painterly layer palette, tuned to the garden's lush ground tint (0xaef29a)
// and hazy sky. Every layer is OPAQUE — transparent stacks would z-sort
// against each other per-frame; flat map colors read intentional instead.
const LAWN_COLOR = 0x9ed273;
const WOOD_COLOR = 0x74b05c;
const GARDEN_COLOR = 0xc4e08b;
const WATER_COLOR = 0x66b0d8;
const PATH_COLOR = 0xe3d5ab;
const BARK_COLOR = 0x6e5138;
const CANOPY_COLOR = 0x69aa55;

// Path ribbon widths by kind, in park METERS (walk 3.5m wide, the old
// carriage drives 6m…). Steps render as a narrow walk ribbon — at diorama
// scale a staircase IS just a thin path.
const PATH_WIDTH_M: Record<string, number> = { walk: 3.5, steps: 2.2, cycle: 5, drive: 6 };

export function buildCentralPark(
  layout: CentralParkLayout,
  opts: { targetLength?: number } = {},
): CentralParkBuild {
  // Fit the park's 4.1 km long axis across the garden ground disc (radius 110;
  // 205 keeps the corners inside the circle's rim).
  const s = (opts.targetLength ?? 205) / layout.meta.lengthM;
  const group = new THREE.Group();
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];

  // A ShapeGeometry lies in the XY plane; under the ground's rotation.x=-π/2
  // local (x, y) lands at world (x, 0, -y), so shapes take (x, -z).
  const ringToShape = (ring: number[]): THREE.Shape => {
    const shape = new THREE.Shape();
    shape.moveTo(ring[0] * s, -ring[1] * s);
    for (let i = 2; i < ring.length; i += 2) {
      shape.lineTo(ring[i] * s, -ring[i + 1] * s);
    }
    shape.closePath();
    return shape;
  };

  // One mesh per layer, slightly y-staggered (plus a polygonOffset backstop)
  // so the flat stack never z-fights at grazing projector angles.
  const addLayer = (
    rings: number[][],
    color: number,
    y: number,
    order: number,
    extra?: Partial<THREE.MeshStandardMaterialParameters>,
  ) => {
    if (rings.length === 0) {
      return;
    }
    const geometry = new THREE.ShapeGeometry(rings.map(ringToShape));
    const material = new THREE.MeshStandardMaterial({
      color,
      roughness: 1,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -order,
      polygonOffsetUnits: -order,
      ...extra,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = y;
    group.add(mesh);
    geometries.push(geometry);
    materials.push(material);
  };

  addLayer(layout.lawns, LAWN_COLOR, 0.03, 1);
  addLayer(layout.woods, WOOD_COLOR, 0.06, 2);
  addLayer(layout.gardens, GARDEN_COLOR, 0.09, 3);
  addLayer(layout.water, WATER_COLOR, 0.12, 4, { roughness: 0.2 });

  // Footpaths: every polyline becomes a flat ribbon; ALL ribbons share one
  // BufferGeometry + material (a single draw call for ~1800 paths). Ribbon
  // verts are extruded along per-point averaged segment normals.
  {
    const positions: number[] = [];
    const indices: number[] = [];
    for (const path of layout.paths) {
      const pts = path.pts;
      const n = pts.length / 2;
      if (n < 2) {
        continue;
      }
      const half = ((PATH_WIDTH_M[path.k] ?? 3.5) / 2) * s;
      const base = positions.length / 3;
      for (let i = 0; i < n; i++) {
        const x = pts[i * 2] * s;
        const z = pts[i * 2 + 1] * s;
        const px = pts[Math.max(0, i - 1) * 2] * s;
        const pz = pts[Math.max(0, i - 1) * 2 + 1] * s;
        const nx = pts[Math.min(n - 1, i + 1) * 2] * s;
        const nz = pts[Math.min(n - 1, i + 1) * 2 + 1] * s;
        const dx = nx - px;
        const dz = nz - pz;
        const len = Math.hypot(dx, dz) || 1;
        const ox = (-dz / len) * half;
        const oz = (dx / len) * half;
        positions.push(x - ox, 0, z - oz, x + ox, 0, z + oz);
        if (i > 0) {
          const a = base + (i - 1) * 2;
          indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    const normals = new Float32Array(positions.length);
    for (let i = 0; i < normals.length; i += 3) {
      normals[i + 1] = 1;
    }
    geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    const material = new THREE.MeshStandardMaterial({
      color: PATH_COLOR,
      roughness: 1,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -5,
      polygonOffsetUnits: -5,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.y = 0.15;
    mesh.frustumCulled = false;
    group.add(mesh);
    geometries.push(geometry);
    materials.push(material);
  }

  // The surveyed trees: trunk + faceted canopy merged with vertex colors →
  // ONE InstancedMesh (one draw call for all ~1600). Sizes are park meters, so
  // at diorama scale each stands ~0.5 units — miniatures under the garden's
  // full-size story trees, which is exactly the point.
  if (layout.trees.length >= 2) {
    // De-indexed so both halves merge (Cylinder is indexed, Icosahedron not).
    const trunk = new THREE.CylinderGeometry(0.35 * s, 0.55 * s, 4.5 * s, 5).toNonIndexed();
    trunk.translate(0, 2.25 * s, 0);
    const canopy = new THREE.IcosahedronGeometry(3.6 * s, 1);
    canopy.scale(1, 1.2, 1);
    canopy.translate(0, 6.6 * s, 0);
    const paint = (geometry: THREE.BufferGeometry, color: number) => {
      const c = new THREE.Color(color);
      const count = geometry.getAttribute("position").count;
      const colors = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        colors.set([c.r, c.g, c.b], i * 3);
      }
      geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    };
    paint(trunk, BARK_COLOR);
    paint(canopy, CANOPY_COLOR);
    const treeGeometry = mergeGeometries([trunk, canopy]);
    trunk.dispose();
    canopy.dispose();
    const treeMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
    const count = layout.trees.length / 2;
    const instanced = new THREE.InstancedMesh(treeGeometry, treeMaterial, count);
    const rng = mulberry32(0x5041524b);
    const dummy = new THREE.Object3D();
    const tint = new THREE.Color();
    for (let i = 0; i < count; i++) {
      dummy.position.set(layout.trees[i * 2] * s, 0, layout.trees[i * 2 + 1] * s);
      dummy.rotation.y = rng() * Math.PI * 2;
      const grow = 0.7 + rng() * 0.7;
      dummy.scale.set(grow, grow * (0.9 + rng() * 0.25), grow);
      dummy.updateMatrix();
      instanced.setMatrixAt(i, dummy.matrix);
      // Subtle per-tree tint (multiplies the vertex colors) so the canopy
      // field shimmers instead of banding uniform green.
      instanced.setColorAt(i, tint.setHSL(0.29 + rng() * 0.06, 0.25 + rng() * 0.2, 0.55 + rng() * 0.12));
    }
    instanced.frustumCulled = false;
    group.add(instanced);
    geometries.push(treeGeometry);
    materials.push(treeMaterial);
  }

  // Precomputed world-space water rings for the point test.
  const waterRings = layout.water.map((ring) => ring.map((v) => v * s));
  const isWater = (x: number, z: number): boolean => {
    for (const ring of waterRings) {
      const n = ring.length / 2;
      let inside = false;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = ring[i * 2];
        const zi = ring[i * 2 + 1];
        const xj = ring[j * 2];
        const zj = ring[j * 2 + 1];
        if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) {
          inside = !inside;
        }
      }
      if (inside) {
        return true;
      }
    }
    return false;
  };

  // Self-contained teardown: the garden env's dispose traverse treats
  // InstancedMesh geometry/material as shared flora-cache assets, so the park
  // detaches itself and releases its own GPU resources instead.
  const dispose = () => {
    group.parent?.remove(group);
    group.traverse((node) => {
      if (node instanceof THREE.InstancedMesh) {
        node.dispose();
      }
    });
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
  };

  return { group, isWater, dispose };
}
