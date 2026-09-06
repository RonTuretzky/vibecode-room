import * as THREE from 'three';
import { walkMaterial, walkSurface, type WalkSurface } from './park-walk-materials';
import type { ParkWalk } from './park-walks';
import { walkJunctions } from './park-walk-junctions';
import { yieldParkBuild } from './park-build-scheduler';

interface Station { x: number; z: number; px: number; pz: number; along: number }
interface Vertex { x: number; y: number; z: number; wet: number; along: number; edge: number }

/** Fine ribbons follow the rendered terrain. Clip at the actual path edge:
 * a steep bank or water beside a walk must not erase the entire walk. */
function* pathBuildSteps(lines: ParkWalk[], groundAt: (x: number, z: number) => number,
  waterAt: (x: number, z: number) => number,
  bounds?: { west: number; east: number; north: number; south: number; focus?: { x: number; z: number } }): Generator<void, THREE.Mesh | null> {
  const positions: number[] = [], colors: number[] = [], uvs: number[] = [], walkCoords: number[] = [];
  const batches = new Map<WalkSurface['texture'], number[]>();
  let activeTexture: WalkSurface['texture'] = 'aggregate';
  const stone = new THREE.Color(0xa09a8b), edge = new THREE.Color(0x99917d);
  const sharedVertices = new Map<string, number>();
  const insideOtherWalk = walkJunctions(lines);
  let clipWalkAt: ((x: number, z: number) => boolean) | undefined;
  const detailStep = (x: number, z: number) => {
    const d = bounds?.focus ? Math.hypot(x - bounds.focus.x, z - bounds.focus.z) : 0;
    return d > 500 ? 5 : d > 300 ? 3 : 1.5;
  };
  let stairTreads = 0;
  let halfWidth = 0;
  function vertex(x: number, z: number, lift: number, y?: number): Vertex {
    return { x, z, y: y ?? groundAt(x, z) + lift, wet: waterAt(x, z), along: 0, edge: 0 };
  }
  function between(p: Vertex, q: Vertex, t: number, lift?: number): Vertex {
    const v = vertex(p.x + (q.x - p.x) * t, p.z + (q.z - p.z) * t, lift ?? 0,
      lift == null ? p.y + (q.y - p.y) * t : undefined);
    v.along = p.along + (q.along - p.along) * t;
    v.edge = p.edge + (q.edge - p.edge) * t;
    return v;
  }
  function emit(a: Vertex, b: Vertex, c: Vertex, color: THREE.Color, lift?: number, depth = 0) {
    if (lift != null && depth < 4) {
      const mid = (p: Vertex, q: Vertex) => between(p, q, .5, lift);
      const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
      const centerY = groundAt((a.x + b.x + c.x) / 3, (a.z + b.z + c.z) / 3) + lift;
      // Subdivide only where interpolation would bury or visibly suspend the
      // surface. Flat distant paths keep few triangles; banks retain detail.
      if (Math.max(Math.abs(ab.y - (a.y + b.y) / 2), Math.abs(bc.y - (b.y + c.y) / 2),
          Math.abs(ca.y - (c.y + a.y) / 2), Math.abs(centerY - (a.y + b.y + c.y) / 3)) > .045) {
        emit(a, ab, ca, color, lift, depth + 1); emit(ab, b, bc, color, lift, depth + 1);
        emit(ca, bc, c, color, lift, depth + 1); emit(ab, bc, ca, color, lift, depth + 1); return;
      }
    }
    for (const p of [a, b, c]) {
      // Share smooth walk vertices. Stairs retain sharp tread/riser normals.
      const key = lift == null ? null : `${p.x.toFixed(4)},${p.y.toFixed(4)},${p.z.toFixed(4)},${color.r},${activeTexture},${p.along.toFixed(4)},${p.edge.toFixed(4)}`;
      let id = key == null ? undefined : sharedVertices.get(key);
      if (id == null) {
        id = positions.length / 3;
        positions.push(p.x, p.y, p.z);
        const tone = 1 + Math.sin(p.x * .17 + p.z * .29) * .025;
        colors.push(color.r * tone, color.g * tone, color.b * tone);
        uvs.push(p.x / 2, (p.z + p.y * .4) / 2);
        walkCoords.push(p.along, p.edge);
        if (key != null) sharedVertices.set(key, id);
      }
      let batch = batches.get(activeTexture);
      if (!batch) { batch = []; batches.set(activeTexture, batch); }
      batch.push(id);
    }
  }
  function triangle(a: Vertex, b: Vertex, c: Vertex, color: THREE.Color, lift?: number, depth = 0) {
    const source = [a, b, c], clipped: Vertex[] = [];
    const isDry = (p: Vertex) => p.wet < .5 && !clipWalkAt?.(p.x, p.z);
    if (clipWalkAt && depth < 4) {
      const midpoints = source.map((p, i) => {
        const q = source[(i + 1) % 3]!;
        return between(p, q, .5, lift);
      });
      const center = vertex((a.x + b.x + c.x) / 3, (a.z + b.z + c.z) / 3, lift ?? 0);
      const states = source.map(isDry);
      if (midpoints.some((p, i) => states[i] === states[(i + 1) % 3] && isDry(p) !== states[i]) ||
          (states.every(v => v === states[0]) && isDry(center) !== states[0])) {
        const [ab, bc, ca] = midpoints as [Vertex, Vertex, Vertex];
        triangle(a, ab, ca, color, lift, depth + 1); triangle(ab, b, bc, color, lift, depth + 1);
        triangle(ca, bc, c, color, lift, depth + 1); triangle(ab, bc, ca, color, lift, depth + 1); return;
      }
    }
    for (let i = 0; i < 3; i++) {
      const p = source[i]!, q = source[(i + 1) % 3]!, dry = isDry(p);
      if (dry) clipped.push(p);
      if (dry === isDry(q)) continue;
      // Sample the mask, not just a linear estimate. This also keeps hard
      // shore masks from leaving triangles across an unbridged channel.
      let lo = 0, hi = 1;
      for (let k = 0; k < 14; k++) {
        const t = (lo + hi) / 2;
        const x = p.x + (q.x - p.x) * t, z = p.z + (q.z - p.z) * t;
        if ((waterAt(x, z) < .5 && !clipWalkAt?.(x, z)) === dry) lo = t;
        else hi = t;
      }
      const t = dry ? lo : hi;
      const clippedVertex = between(p, q, t, lift); clippedVertex.wet = 0;
      clipped.push(clippedVertex);
    }
    if (clipped.length < 3) return;
    for (let k = 1; k + 1 < clipped.length; k++) emit(clipped[0]!, clipped[k]!, clipped[k + 1]!, color, lift);
  }
  function quad(a: Vertex, b: Vertex, c: Vertex, d: Vertex, color: THREE.Color, lift?: number) {
    triangle(a, b, c, color, lift); triangle(a, c, d, color, lift);
  }
  function side(s: Station, offset: number, lift: number, y?: number) {
    const v = vertex(s.x + s.px * offset, s.z + s.pz * offset, lift, y);
    v.along = s.along; v.edge = Math.max(0, halfWidth - Math.abs(offset)); return v;
  }
  for (const line of lines) {
    if (line.width <= 0 || line.pts.length < 4) continue;
    const isSteps = line.kind === 'steps';
    const surface = walkSurface(line), coreColor = new THREE.Color(surface.color);
    const points: { x: number; z: number }[] = [];
    for (let i = 2; i < line.pts.length; i += 2) {
      const x = line.pts[i - 2]!, z = line.pts[i - 1]!, dx = line.pts[i]! - x, dz = line.pts[i + 1]! - z;
      const length = Math.hypot(dx, dz);
      if (length < .0001) continue;
      const rise = isSteps ? Math.abs(groundAt(x + dx, z + dz) - groundAt(x, z)) : 0;
      const cuts = Math.max(1, Math.ceil(length / (isSteps ? 1 : detailStep(x + dx / 2, z + dz / 2))), Math.ceil(rise / .16));
      for (let k = 0; k < cuts; k++) points.push({ x: x + dx * k / cuts, z: z + dz * k / cuts });
    }
    if (!points.length) continue;
    points.push({ x: line.pts.at(-2)!, z: line.pts.at(-1)! });
    let along = 0;
    const stations: Station[] = points.map((p, i) => {
      const a = points[Math.max(0, i - 1)]!, b = points[Math.min(points.length - 1, i + 1)]!;
      const dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz) || 1;
      if (i > 0) along += Math.hypot(p.x - points[i - 1]!.x, p.z - points[i - 1]!.z);
      return { ...p, px: -dz / length, pz: dx / length, along };
    });
    const half = line.width / 2, margin = Math.min(.32, half * .4);
    halfWidth = half;
    // Narrow transverse cells conform to terrain triangles at banks and bends.
    const cross: number[] = [-half, -half + margin];
    const coreWidth = line.width - margin * 2, cuts = Math.max(1, Math.ceil(coreWidth / 2));
    for (let k = 1; k <= cuts; k++) cross.push(-half + margin + coreWidth * k / cuts);
    cross.push(half);
    let previousTop: number | null = null;
    for (let i = 1; i < stations.length; i++) {
      const a = stations[i - 1]!, b = stations[i]!;
      if (bounds && (Math.max(a.x, b.x) + half < bounds.west || Math.min(a.x, b.x) - half > bounds.east ||
          Math.max(a.z, b.z) + half < bounds.north || Math.min(a.z, b.z) - half > bounds.south)) {
        previousTop = null; continue;
      }
      // Treads sit above the graded earth ramp; the earth remains the solid
      // support. Heights/counts are DEM-derived, not surveyed stair dimensions.
      const top = isSteps ? Math.max(...[a, b].flatMap(s => cross.map(offset => side(s, offset, 0).y))) + .07 : undefined;
      for (let k = 1; k < cross.length; k++) {
        const left = cross[k]!, right = cross[k - 1]!, border = k === 1 || k === cross.length - 1;
        // Flush edging shares the walking surface height. The former 1.5 cm
        // offset left an open slit through which the lawn showed at eye level.
        const lift = .07;
        const color = border && !isSteps && surface.hardEdge ? edge : coreColor;
        activeTexture = border && !isSteps && surface.hardEdge ? 'edging' : surface.texture;
        clipWalkAt = isSteps ? undefined : (x, z) => insideOtherWalk(line, x, z, !(border && surface.hardEdge));
        quad(side(a, left, lift, top), side(b, left, lift, top), side(b, right, lift, top), side(a, right, lift, top), color, isSteps ? undefined : lift);
        clipWalkAt = undefined;
        activeTexture = 'aggregate';
        if (top != null && previousTop != null && Math.abs(top - previousTop) > .002) {
          const low = Math.min(top, previousTop), high = Math.max(top, previousTop);
          const face = [side(a, left, 0, high), side(a, right, 0, high), side(a, right, 0, low), side(a, left, 0, low)];
          if (top < previousTop) face.reverse();
          quad(face[0]!, face[1]!, face[2]!, face[3]!, stone);
        }
      }
      if (top != null) {
        // Close exposed sides, including the first and last landing.
        for (const offset of [-half, half]) {
          const face = [side(a, offset, 0, top), side(b, offset, 0, top), side(b, offset, .01), side(a, offset, .01)];
          if (offset > 0) face.reverse();
          quad(face[0]!, face[1]!, face[2]!, face[3]!, stone);
        }
        for (const [s, reverse] of [[a, false], [b, true]] as const) {
          if (s === a ? i !== 1 : i !== stations.length - 1) continue;
          const face = [side(s, half, 0, top), side(s, -half, 0, top), side(s, -half, .01), side(s, half, .01)];
          if (reverse) face.reverse();
          quad(face[0]!, face[1]!, face[2]!, face[3]!, stone);
        }
        stairTreads++; previousTop = top;
      }
      yield;
    }
    yield;
  }
  if (!batches.size) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('parkWalkCoord', new THREE.Float32BufferAttribute(walkCoords, 2));
  const index: number[] = [], materials: THREE.MeshStandardMaterial[] = [];
  for (const [texture, batch] of batches) {
    geometry.addGroup(index.length, batch.length, materials.length);
    for (const id of batch) index.push(id);
    materials.push(walkMaterial(texture));
    yield;
  }
  geometry.setIndex(index); geometry.computeVertexNormals(); geometry.computeBoundingSphere();
  const mesh = new THREE.Mesh(geometry, materials.length === 1 ? materials[0]! : materials);
  mesh.receiveShadow = true; mesh.name = 'park-paths'; mesh.userData.stairTreads = stairTreads;
  return mesh;
}

/** Synchronous construction for offline geometry checks. */
export function buildPaths(...args: Parameters<typeof pathBuildSteps>): THREE.Mesh | null {
  const steps = pathBuildSteps(...args);
  let result = steps.next();
  while (!result.done) result = steps.next();
  return result.value;
}

/** Identical geometry, with small work slices so a whole park's junctions
 * and bank-conforming ribbons do not monopolize the browser for a second. */
export async function buildPathsAsync(...args: Parameters<typeof pathBuildSteps>): Promise<THREE.Mesh | null> {
  const steps = pathBuildSteps(...args);
  let deadline = performance.now() + 8;
  let result = steps.next();
  while (!result.done) {
    if (performance.now() >= deadline) {
      await yieldParkBuild();
      deadline = performance.now() + 8;
    }
    result = steps.next();
  }
  return result.value;
}
