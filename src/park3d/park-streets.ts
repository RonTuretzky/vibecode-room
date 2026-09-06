import * as THREE from "three";
import { localFromLatLon } from "./park-frame";
import { insideParkOutline as insidePark, distanceToParkBoundary } from "./park-outline";
import { parkPathTexture, parkStoneTexture } from "./park-materials";

export interface StreetWay {
  id: number;
  tags: { highway?: string; barrier?: string; name?: string; width?: string; lanes?: string; oneway?: string; height?: string; bridge?: string; layer?: string; surface?: string };
  coordinates: number[][];
}
export interface StreetSegment { id: number; ax: number; az: number; bx: number; bz: number; width: number; name: string; oneway: boolean; lanes: number; start: number }
export interface StreetBounds { west: number; east: number; north: number; south: number }

/** Use tagged carriageway widths where available. Other widths are modeled
 * from lane counts, not a claim about surveyed curb positions. */
export function streetWidth(tags: StreetWay['tags']): number {
  const explicit = Number(tags.width);
  if (explicit >= 3 && explicit <= 40) return explicit;
  const lanes = Number(tags.lanes);
  if (lanes >= 1 && lanes <= 8) return lanes * 3.1 + (tags.highway === 'service' ? 0 : 3);
  return tags.highway === 'primary' ? 18 : tags.highway === 'secondary' ? 14 : tags.highway === 'tertiary' ? 11 : tags.highway === 'service' ? 5 : 9;
}

export function streetSegments(ways: StreetWay[], bounds: StreetBounds): StreetSegment[] {
  const result: StreetSegment[] = [];
  for (const way of ways) {
    if (!way.tags.highway || way.tags.bridge === 'yes' || Number(way.tags.layer ?? 0) < 0) continue;
    const width = streetWidth(way.tags), points = way.coordinates.map(([lon, lat]) => localFromLatLon(lat!, lon!));
    let start = 0;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!, b = points[i]!, length = Math.hypot(b.x - a.x, b.z - a.z);
      if (length < .01) continue;
      if (Math.max(a.x, b.x) >= bounds.west && Math.min(a.x, b.x) <= bounds.east &&
          Math.max(a.z, b.z) >= bounds.north && Math.min(a.z, b.z) <= bounds.south &&
          !insidePark((a.x + b.x) / 2, (a.z + b.z) / 2, -4)) {
        result.push({ id: way.id, ax: a.x, az: a.z, bx: b.x, bz: b.z, width,
          name: way.tags.name ?? '', oneway: way.tags.oneway === 'yes',
          lanes: Math.max(1, Math.min(8, Number(way.tags.lanes) || Math.round(width / 3.5))), start });
      }
      start += length;
    }
  }
  return result;
}

export function distanceToStreet(x: number, z: number, segment: Pick<StreetSegment, 'ax' | 'az' | 'bx' | 'bz'>): number {
  const dx = segment.bx - segment.ax, dz = segment.bz - segment.az;
  const t = THREE.MathUtils.clamp(((x - segment.ax) * dx + (z - segment.az) * dz) / (dx * dx + dz * dz || 1), 0, 1);
  return Math.hypot(x - segment.ax - dx * t, z - segment.az - dz * t);
}

/** Spatial lookup prevents curbs and sidewalks crossing another street at
 * junctions. Keeping it separate also makes gate/plant placement testable. */
export function streetLookup(segments: StreetSegment[]) {
  const buckets = new Map<string, StreetSegment[]>(), cell = 48;
  for (const s of segments) {
    const pad = s.width / 2 + 4;
    for (let x = Math.floor((Math.min(s.ax, s.bx) - pad) / cell); x <= Math.floor((Math.max(s.ax, s.bx) + pad) / cell); x++) {
      for (let z = Math.floor((Math.min(s.az, s.bz) - pad) / cell); z <= Math.floor((Math.max(s.az, s.bz) + pad) / cell); z++) {
        const key = `${x},${z}`, bucket = buckets.get(key) ?? []; bucket.push(s); buckets.set(key, bucket);
      }
    }
  }
  return {
    at(x: number, z: number) { return buckets.get(`${Math.floor(x / cell)},${Math.floor(z / cell)}`) ?? []; },
    occupied(x: number, z: number, ignoreId = -1, margin = 0) {
      return this.at(x, z).some(s => s.id !== ignoreId && distanceToStreet(x, z, s) < s.width / 2 + margin);
    },
  };
}

/** Bake the street network onto the existing terrain, so broad asphalt
 * cannot intersect a differently triangulated road mesh. One local atlas
 * replaces more than a million draped road/sidewalk triangles. */
export function streetSurfaceMap(segments: StreetSegment[], bounds: StreetBounds): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 3072;
  const ctx = canvas.getContext('2d')!, sx = canvas.width / (bounds.east - bounds.west), sz = canvas.height / (bounds.south - bounds.north);
  ctx.fillStyle = '#a6a59e'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(sx, 0, 0, sz, -bounds.west * sx, -bounds.north * sz);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const draw = (s: StreetSegment, width: number, color: string, offset = 0) => {
    const length = Math.hypot(s.bx - s.ax, s.bz - s.az), nx = -(s.bz - s.az) / length, nz = (s.bx - s.ax) / length;
    ctx.strokeStyle = color; ctx.lineWidth = width;
    ctx.beginPath(); ctx.moveTo(s.ax + nx * offset, s.az + nz * offset); ctx.lineTo(s.bx + nx * offset, s.bz + nz * offset); ctx.stroke();
  };
  // All paving first, then the union of carriageways. Intersections remain
  // open instead of retaining the crossing street's sidewalk.
  for (const s of segments) draw(s, s.width + 7, '#b4b1a8');
  for (const s of segments) draw(s, s.width, '#4e5455');
  const lookup = streetLookup(segments);
  ctx.lineCap = 'butt';
  for (const s of segments) {
    const dx = s.bx - s.ax, dz = s.bz - s.az, length = Math.hypot(dx, dz);
    for (let d = (12 - s.start % 12) % 12; d + 3 < length; d += 12) {
      const x = s.ax + dx * d / length, z = s.az + dz * d / length;
      if (lookup.occupied(x, z, s.id, 4)) continue;
      for (let lane = 1; lane < s.lanes; lane++) draw({ ...s, ax: x, az: z, bx: x + dx * 3 / length, bz: z + dz * 3 / length }, .16, '#b8b7a5', -s.width / 2 + s.width * lane / s.lanes);
    }
  }
  const map = new THREE.CanvasTexture(canvas); map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8; map.channel = 1; return map;
}

/** Road, paving and curb faces share three spatially merged meshes. They
 * follow the rendered terrain, including slopes between DEM samples. */
export function buildParkStreets(ways: StreetWay[], groundAt: (x: number, z: number) => number,
  bounds: StreetBounds, paths: { width: number; pts: number[] }[]) {
  const group = new THREE.Group(); group.name = 'park-city-streets';
  const segments = streetSegments(ways, bounds), lookup = streetLookup(segments);
  const chunks = new Map<string, { positions: number[]; colors: number[]; uvs: number[]; index: number[]; kind: number }>();
  const granite = new THREE.Color(0x9b9991);
  const chunkAt = (x: number, z: number, kind: number) => {
    const key = `${Math.floor(x / 240)},${Math.floor(z / 240)},${kind}`;
    let chunk = chunks.get(key);
    if (!chunk) { chunk = { positions: [], colors: [], uvs: [], index: [], kind }; chunks.set(key, chunk); }
    return chunk;
  };
  const face = (points: number[][], color: THREE.Color, kind: number, uvScale = 2) => {
    const c = chunkAt(points[0]![0]!, points[0]![2]!, kind), base = c.positions.length / 3;
    for (const [x, y, z] of points) {
      c.positions.push(x!, y!, z!); c.colors.push(color.r, color.g, color.b); c.uvs.push(x! / uvScale, z! / uvScale);
    }
    c.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  const ground = (x: number, z: number, lift: number) => [x, groundAt(x, z) + lift, z];
  for (const s of segments) {
    const midX = (s.ax + s.bx) / 2, midZ = (s.az + s.bz) / 2;
    const edge = distanceToParkBoundary(midX, midZ);
    if (edge > 45 || !insidePark(midX, midZ, 60)) continue;
    const dx = s.bx - s.ax, dz = s.bz - s.az, length = Math.hypot(dx, dz), nx = -dz / length, nz = dx / length;
    const count = Math.ceil(length / 2), half = s.width / 2;
    for (let i = 0; i < count; i++) {
      const x0 = s.ax + dx * i / count, z0 = s.az + dz * i / count, x1 = s.ax + dx * (i + 1) / count, z1 = s.az + dz * (i + 1) / count;
      if (x0 < bounds.west || x0 > bounds.east || z0 < bounds.north || z0 > bounds.south) continue;
      const strip = (low: number, high: number, color: THREE.Color, lift: number, kind = 0) => {
        // Subdivide across the carriageway too: a single wide quad bridges
        // the crown of the terrain and exposes pale ground through asphalt.
        const subdivisions = Math.max(1, Math.ceil((high - low) / 2));
        for (let k = 0; k < subdivisions; k++) {
          const a = low + (high - low) * k / subdivisions, b = low + (high - low) * (k + 1) / subdivisions;
          face([ground(x0 + nx * b, z0 + nz * b, lift), ground(x1 + nx * b, z1 + nz * b, lift),
            ground(x1 + nx * a, z1 + nz * a, lift), ground(x0 + nx * a, z0 + nz * a, lift)], color, kind);
        }
      };
      for (const side of [-1, 1]) {
        const lo = side * (half + .05), hi = side * (half + 3.5);
        // All corners must clear crossing roads; curbs end at junctions.
        const corners = [[x0, z0], [x1, z1]].flatMap(([x, z]) => [lo, hi].map(offset => [x! + nx * offset, z! + nz * offset]));
        if (corners.some(([x, z]) => lookup.occupied(x!, z!, s.id, .1))) continue;
        strip(side * half - .12, side * half + .12, granite, .235, 1);
        const ax = x0 + nx * half * side, az = z0 + nz * half * side, bx = x1 + nx * half * side, bz = z1 + nz * half * side;
        const curb = [ground(ax, az, .09), ground(bx, bz, .09), ground(bx, bz, .235), ground(ax, az, .235)];
        face(side < 0 ? curb.reverse() : curb, granite, 1);
      }
    }
  }
  // The mapped low wall gives the park a physical edge. Preserve path
  // entrances instead of joining the geometry through them.
  const pathSegments = paths.flatMap((p, i) => p.pts.slice(2).filter((_, j) => j % 2 === 0).map((_, j) => ({
    id: -i - 2, ax: p.pts[j * 2]!, az: p.pts[j * 2 + 1]!, bx: p.pts[j * 2 + 2]!, bz: p.pts[j * 2 + 3]!, width: p.width + 1.5,
    name: '', oneway: false, lanes: 1, start: 0,
  })));
  const walks = streetLookup(pathSegments), wallTone = new THREE.Color(0x8a897a), coping = new THREE.Color(0xaaa797);
  let wallLength = 0;
  for (const way of ways) {
    if (way.tags.barrier !== 'wall' && way.tags.barrier !== 'retaining_wall') continue;
    const points = way.coordinates.map(([lon, lat]) => localFromLatLon(lat!, lon!));
    for (let j = 1; j < points.length; j++) {
      const a = points[j - 1]!, b = points[j]!, dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz);
      if (length < .1) continue;
      const nx = -dz / length, nz = dx / length, count = Math.ceil(length / 2);
      for (let i = 0; i < count; i++) {
        const x = a.x + dx * (i + .5) / count, z = a.z + dz * (i + .5) / count;
        const edge = distanceToParkBoundary(x, z);
        if (edge > 18 || x < bounds.west || x > bounds.east || z < bounds.north || z > bounds.south ||
            walks.occupied(x, z) || lookup.occupied(x, z)) continue;
        const x0 = a.x + dx * i / count, z0 = a.z + dz * i / count, x1 = a.x + dx * (i + 1) / count, z1 = a.z + dz * (i + 1) / count;
        const h = THREE.MathUtils.clamp(Number(way.tags.height) || 1.05, .12, 4);
        for (const side of [-1, 1]) {
          const ax = x0 + nx * .32 * side, az = z0 + nz * .32 * side, bx = x1 + nx * .32 * side, bz = z1 + nz * .32 * side;
          const wall = [ground(ax, az, -.05), ground(bx, bz, -.05), ground(bx, bz, h), ground(ax, az, h)];
          face(side < 0 ? wall.reverse() : wall, wallTone, 2);
          // Sidewall UVs follow metres along the segment and elevation.
          const c = chunkAt(wall[0]![0]!, wall[0]![2]!, 2);
          c.uvs.splice(c.uvs.length - 8, 8, i * length / count / 4, 0, (i + 1) * length / count / 4, 0,
            (i + 1) * length / count / 4, h / 4, i * length / count / 4, h / 4);
        }
        face([ground(x0 + nx * .36, z0 + nz * .36, h), ground(x1 + nx * .36, z1 + nz * .36, h),
          ground(x1 - nx * .36, z1 - nz * .36, h), ground(x0 - nx * .36, z0 - nz * .36, h)], coping, 2);
        wallLength += length / count;
      }
    }
  }
  const map = typeof document === 'undefined' ? null : parkPathTexture();
  const stone = typeof document === 'undefined' ? null : parkStoneTexture();
  const materials = [new THREE.MeshStandardMaterial({ vertexColors: true, map, roughness: .96 }),
    new THREE.MeshStandardMaterial({ vertexColors: true, map, bumpMap: map, bumpScale: .02, roughness: .94 }),
    new THREE.MeshStandardMaterial({ vertexColors: true, map: stone, bumpMap: stone, bumpScale: .055, roughness: .95 })];
  for (const c of chunks.values()) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(c.positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(c.colors, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(c.uvs, 2));
    geometry.setIndex(c.index); geometry.computeVertexNormals(); geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, materials[c.kind]); mesh.receiveShadow = true;
    mesh.name = ['city-asphalt', 'city-sidewalks', 'park-perimeter-wall'][c.kind]!;
    group.add(mesh);
  }
  group.userData.streetSegments = segments.length; group.userData.wallMetres = Math.round(wallLength);
  return { group, segments, map: streetSurfaceMap(segments, bounds), dispose() {
    group.removeFromParent(); group.traverse(node => { if (node instanceof THREE.Mesh) node.geometry.dispose(); });
    materials.forEach(m => m.dispose());
  } };
}
