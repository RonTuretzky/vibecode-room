import * as THREE from 'three';

type Point = { x: number; z: number };
export interface RoofPlan {
  outer: Point[]; inner: Point[]; deck: number; top: number;
  color: THREE.Color; glass: boolean; seed: number;
}

function inside(ring: Point[], p: Point) {
  let contained = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!;
    if ((a.z > p.z) !== (b.z > p.z) && p.x < (b.x - a.x) * (p.z - a.z) / (b.z - a.z) + a.x) contained = !contained;
  }
  return contained;
}

/** Inset the negative-shoelace footprint without replacing irregular lots by
 * rectangles. Reject collapsed or exterior corners on very narrow roofs. */
export function roofInset(ring: Point[], width: number): Point[] | null {
  for (const factor of [1, .5, .25]) {
    const inset = ring.map((p, i) => {
      const a = ring[(i + ring.length - 1) % ring.length]!, b = ring[(i + 1) % ring.length]!;
      const al = Math.hypot(p.x - a.x, p.z - a.z), bl = Math.hypot(b.x - p.x, b.z - p.z);
      const ax = -(p.z - a.z) / al, az = (p.x - a.x) / al, bx = -(b.z - p.z) / bl, bz = (b.x - p.x) / bl;
      const denom = 1 + ax * bx + az * bz;
      return { x: p.x - (ax + bx) * width * factor / denom, z: p.z - (az + bz) * width * factor / denom };
    });
    if (inset.every((p, i) => {
      const q = inset[(i + 1) % ring.length]!, a = ring[i]!, b = ring[(i + 1) % ring.length]!;
      return Number.isFinite(p.x) && Number.isFinite(p.z) && inside(ring, p) &&
        Math.hypot(p.x - a.x, p.z - a.z) < width * 5 && (q.x - p.x) * (b.x - a.x) + (q.z - p.z) * (b.z - a.z) > 0;
    })) return inset;
  }
  return null;
}

/** Illustrative parapets, coping, access hatches and low mechanical housings.
 * Everything stays inside the source footprint and below its roof-height cap.
 * The layouts are deliberately not presented as surveyed rooftop equipment. */
export function buildRoofDetails(plans: RoofPlan[]): THREE.Mesh | null {
  const positions: number[] = [], colors: number[] = [], normals: number[] = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), normal = new THREE.Vector3();
  const up = (p: Point, y: number) => new THREE.Vector3(p.x, y, p.z);
  function triangle(p: THREE.Vector3, q: THREE.Vector3, r: THREE.Vector3, color: THREE.Color) {
    a.subVectors(q, p); b.subVectors(r, p); normal.crossVectors(a, b).normalize();
    for (const v of [p, q, r]) {
      positions.push(v.x, v.y, v.z); normals.push(normal.x, normal.y, normal.z); colors.push(color.r, color.g, color.b);
    }
  }
  function quad(p: THREE.Vector3, q: THREE.Vector3, r: THREE.Vector3, s: THREE.Vector3, color: THREE.Color) {
    triangle(p, q, r, color); triangle(p, r, s, color);
  }
  function box(ring: Point[], low: number, high: number, color: THREE.Color) {
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i]!, q = ring[(i + 1) % ring.length]!;
      quad(up(p, low), up(q, low), up(q, high), up(p, high), color);
    }
    quad(up(ring[0]!, high), up(ring[1]!, high), up(ring[2]!, high), up(ring[3]!, high), color.clone().multiplyScalar(1.12));
  }
  for (const plan of plans) {
    const { outer, inner, deck, top } = plan;
    const band = plan.color.clone().lerp(new THREE.Color(0xb6b3a7), plan.glass ? .7 : .28);
    const coping = band.clone().multiplyScalar(1.15), innerShade = band.clone().multiplyScalar(.73);
    for (let i = 0; i < outer.length; i++) {
      const j = (i + 1) % outer.length, p = outer[i]!, q = outer[j]!, ip = inner[i]!, iq = inner[j]!;
      quad(up(p, deck), up(q, deck), up(q, top), up(p, top), band);
      quad(up(p, top), up(q, top), up(iq, top), up(ip, top), coping);
      quad(up(iq, deck), up(ip, deck), up(ip, top), up(iq, top), innerShade);
    }
    let longest = 0, ux = 1, uz = 0;
    for (let i = 0; i < outer.length; i++) {
      const p = outer[i]!, q = outer[(i + 1) % outer.length]!, length = Math.hypot(q.x - p.x, q.z - p.z);
      if (length > longest) { longest = length; ux = (q.x - p.x) / length; uz = (q.z - p.z) / length; }
    }
    const center = outer.reduce((p, q) => ({ x: p.x + q.x / outer.length, z: p.z + q.z / outer.length }), { x: 0, z: 0 });
    const local = outer.map(p => ({ u: (p.x - center.x) * ux + (p.z - center.z) * uz, v: -(p.x - center.x) * uz + (p.z - center.z) * ux }));
    const width = Math.max(...local.map(p => p.u)) - Math.min(...local.map(p => p.u));
    const depth = Math.max(...local.map(p => p.v)) - Math.min(...local.map(p => p.v));
    if (width < 9 || depth < 7) continue;
    const point = (u: number, v: number): Point => ({ x: center.x + ux * u - uz * v, z: center.z + uz * u + ux * v });
    // Five deterministic candidates, at most two accepted housings per roof.
    // Polygon containment prevents boxes bridging notches or hanging off lots.
    let placed = 0;
    for (const [fu, fv] of [[-.19, .16], [.18, -.13], [0, 0], [-.25, -.21], [.24, .21]]) {
      const u = fu! * width, v = fv! * depth;
      const hu = Math.min(2.7, width * .09), hv = Math.min(1.6, depth * .1);
      const corners = [point(u - hu, v - hv), point(u - hu, v + hv), point(u + hu, v + hv), point(u + hu, v - hv)];
      const checks = [...corners, point(u, v), ...corners.map((p, i) => {
        const q = corners[(i + 1) % 4]!; return { x: (p.x + q.x) / 2, z: (p.z + q.z) / 2 };
      })];
      if (!checks.every(p => inside(inner, p))) continue;
      const high = deck + (top - deck) * (placed ? .48 : .82);
      const housing = new THREE.Color(plan.seed % 3 ? 0x818b8b : 0x8d8275);
      box(corners, deck + .01, high, housing);
      // Raised ribs across the lid catch sunlight at overview distances.
      for (let rib = -1; rib <= 1; rib++) {
        const ru = u + rib * hu * .52, rw = .045;
        box([point(ru - rw, v - hv), point(ru - rw, v + hv), point(ru + rw, v + hv), point(ru + rw, v - hv)], high, high + .045, housing);
      }
      if (++placed === 2) break;
    }
  }
  if (!positions.length) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3)); geometry.computeBoundingSphere();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .85 }));
  mesh.name = 'park-roof-details'; mesh.castShadow = true; mesh.receiveShadow = true; return mesh;
}
