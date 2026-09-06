import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { AXIS, alongAcross, localFromAlongAcross } from './park-frame';
import { PARK_SITES, ZOO_COURT, inSite, type SitePoint } from './park-sites';
import { ZOO_PAVILIONS, zooAxisRing, clipZooRing } from './park-zoo-layout';
import { parkBrickTexture, parkStoneTexture, parkRoofTexture, parkTurfTexture } from './park-materials';

/** WCS map-informed architecture on retained OSM outlines. Gallery heights,
 * facade bays, roofs and formal planting are interpretive, not a survey. */
export function buildZoo(groundAt: (x: number, z: number) => number, courtLevel: number, pavilionLevels: readonly number[]): THREE.Group {
  const group = new THREE.Group(); group.name = 'Central Park Zoo';
  const origin = alongAcross(PARK_SITES.zooPool.x, PARK_SITES.zooPool.z);
  group.position.set(PARK_SITES.zooPool.x, courtLevel, PARK_SITES.zooPool.z);
  group.rotation.y = Math.atan2(-AXIS.z, AXIS.x);
  const map = (make: () => THREE.Texture) => typeof document === 'undefined' ? null : make();
  const brick = map(parkBrickTexture), slate = map(parkRoofTexture), turf = map(parkTurfTexture);
  const stone = map(parkStoneTexture);
  const materials = [
    new THREE.MeshStandardMaterial({ color: 0xa97b59, map: brick, bumpMap: brick, bumpScale: .027, roughness: .94 }),
    new THREE.MeshStandardMaterial({ color: 0xd1c7af, map: stone, bumpMap: stone, bumpScale: .025, roughness: .94 }),
    new THREE.MeshStandardMaterial({ color: 0x596260, map: slate, bumpMap: slate, bumpScale: .018, roughness: .9 }),
    new THREE.MeshStandardMaterial({ color: 0x3c5147, roughness: .75, metalness: .1 }),
    new THREE.MeshStandardMaterial({ color: 0x78958f, roughness: .32, metalness: .08 }),
    new THREE.MeshStandardMaterial({ color: 0x638e8b, roughness: .14, metalness: .3 }),
    new THREE.MeshStandardMaterial({ color: 0x829551, map: turf, bumpMap: turf, bumpScale: .025, roughness: 1 }),
    new THREE.MeshStandardMaterial({ color: 0x556738, roughness: .96 }),
  ];
  const batches = materials.map(() => [] as THREE.BufferGeometry[]);
  const ground = (x: number, z: number) => { const p = localFromAlongAcross(x, z); return groundAt(p.x, p.z); };
  function add(index: number, geo: THREE.BufferGeometry) {
    geo.translate(-origin.along, -courtLevel, -origin.across); batches[index]!.push(geo);
  }
  function box(index: number, w: number, h: number, d: number, x: number, y: number, z: number, yaw = 0) {
    const geo = new THREE.BoxGeometry(w, h, d), p = geo.getAttribute('position'), n = geo.getAttribute('normal'), uv = geo.getAttribute('uv');
    for (let i = 0; i < p.count; i++) {
      uv.setXY(i, (Math.abs(n.getX(i)) > .5 ? p.getZ(i) : p.getX(i)) / 2.4, (Math.abs(n.getY(i)) > .5 ? p.getZ(i) : p.getY(i) + y) / (index === 0 ? .8 : 2.4));
    }
    geo.rotateY(yaw); geo.translate(x, y, z); add(index, geo);
  }
  function plate(index: number, ring: readonly SitePoint[], height: number | ((x: number, z: number) => number)) {
    if (ring.length < 3) return;
    const geo = new THREE.ShapeGeometry(new THREE.Shape(ring.map(p => new THREE.Vector2(p.x, -p.z))));
    geo.rotateX(-Math.PI / 2);
    const pos = geo.getAttribute('position'), uv = geo.getAttribute('uv');
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      pos.setY(i, typeof height === 'number' ? height : height(x, z)); uv.setXY(i, x / 3, z / 3);
    }
    geo.computeVertexNormals(); add(index, geo);
  }
  function edgeBox(index: number, a: SitePoint, b: SitePoint, y: number, h: number, d: number) {
    box(index, Math.hypot(b.x - a.x, b.z - a.z), h, d, (a.x + b.x) / 2, y, (a.z + b.z) / 2, -Math.atan2(b.z - a.z, b.x - a.x));
  }
  function edges(ring: readonly SitePoint[], fn: (a: SitePoint, b: SitePoint, length: number, nx: number, nz: number) => void) {
    const clockwise = THREE.ShapeUtils.isClockWise(ring.map(p => new THREE.Vector2(p.x, p.z)));
    ring.forEach((a, i) => {
      const b = ring[(i + 1) % ring.length]!, dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz);
      if (length < .01) return;
      fn(a, b, length, (clockwise ? -dz : dz) / length, (clockwise ? dx : -dx) / length);
    });
  }
  function archWindow(x: number, z: number, nx: number, nz: number, width: number, floor: number) {
    const r = width / 2, spring = 2.5, bottom = .8;
    const shape = new THREE.Shape(); shape.moveTo(-r, bottom); shape.lineTo(r, bottom);
    shape.lineTo(r, spring); shape.absellipse(0, spring, r, r, 0, Math.PI, false); shape.lineTo(-r, bottom);
    const yaw = Math.atan2(nx, nz), geo = new THREE.ShapeGeometry(shape, 8);
    geo.rotateY(yaw); geo.translate(x + nx * .025, floor, z + nz * .025); add(4, geo);
    const tangent = { x: Math.cos(yaw), z: -Math.sin(yaw) };
    for (const side of [-1, 1]) {
      box(1, .13, spring - bottom, .16, x + tangent.x * side * (r + .05) + nx * .06, floor + (spring + bottom) / 2, z + tangent.z * side * (r + .05) + nz * .06, yaw);
    }
    for (let i = 0; i < 8; i++) {
      const angle = Math.PI * (i + .5) / 8, a = angle - Math.PI / 16 + .006, b = angle + Math.PI / 16 - .006;
      const segment = new THREE.Shape();
      segment.moveTo(Math.cos(a) * r, Math.sin(a) * r); segment.lineTo(Math.cos(b) * r, Math.sin(b) * r);
      segment.lineTo(Math.cos(b) * (r + .16), Math.sin(b) * (r + .16)); segment.lineTo(Math.cos(a) * (r + .16), Math.sin(a) * (r + .16));
      const g = new THREE.ShapeGeometry(segment);
      g.rotateY(yaw); g.translate(x + nx * .12, floor + spring, z + nz * .12); add(1, g);
    }
    box(3, .07, spring - bottom + r, .12, x + nx * .15, floor + (spring + bottom + r) / 2, z + nz * .15, yaw);
    box(3, width, .07, .12, x + nx * .15, floor + spring, z + nz * .15, yaw);
    box(1, width + .4, .16, .3, x + nx * .09, floor + bottom - .1, z + nz * .09, yaw);
  }

  // The mapped roof complex includes narrow open-air colonnades. Keep
  // their walking space open, with posts rooted in the rendered ground.
  const complex = zooAxisRing(PARK_SITES.zooComplex.ring);
  const enclosed = (x: number, z: number) => ZOO_PAVILIONS.some(p => inSite(x, z, p.ring));
  plate(2, complex, (x, z) => ground(x, z) + 4.5);
  edges(complex, (a, b, length) => {
    const n = Math.max(1, Math.ceil(length / 3.2));
    for (let i = 0; i < n; i++) {
      const t = (i + .5) / n, x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
      if (enclosed(x, z) || Math.abs(x + 1667.2) < 3.5 && Math.abs(z - 390) < 7.5) continue;
      const floor = ground(x, z), roof = THREE.MathUtils.lerp(ground(a.x, a.z), ground(b.x, b.z), t) + 4.5;
      box(0, .38, roof - floor + .4, .38, x, (roof + floor - .4) / 2, z);
      box(1, .57, .2, .57, x, roof - .3, z); box(1, .58, .3, .58, x, floor + .12, z);
      const aa = { x: a.x + (b.x - a.x) * i / n, z: a.z + (b.z - a.z) * i / n };
      const bb = { x: a.x + (b.x - a.x) * (i + 1) / n, z: a.z + (b.z - a.z) * (i + 1) / n };
      edgeBox(3, aa, bb, roof - .1, .25, .3);
    }
  });

  for (let k = 0; k < ZOO_PAVILIONS.length; k++) {
    const pavilion = ZOO_PAVILIONS[k]!, floor = pavilionLevels[k]!, eave = floor + pavilion.height - 2;
    const xs = pavilion.ring.map(p => p.x), zs = pavilion.ring.map(p => p.z);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
    // A ridge is explicitly split into the polygon triangulation so the
    // slope is visible; the source outline is kept at the eaves.
    const short = maxX - minX < maxZ - minZ ? 'x' : 'z', low = short === 'x' ? minX : minZ, high = short === 'x' ? maxX : maxZ, mid = (low + high) / 2;
    const roofHeight = (x: number, z: number) => eave + 2 * (1 - Math.abs((short === 'x' ? x : z) - mid) / ((high - low) / 2));
    for (const side of [false, true]) plate(pavilion.glassRoof ? 4 : 2, clipZooRing(pavilion.ring, short, mid, side), roofHeight);
    edges(pavilion.ring, (a, b, length, nx, nz) => {
      // Narrow, stepped source edges retain masonry; long facades have
      // arched glazing and projecting sills based on the WCS photographs.
      edgeBox(0, { x: a.x - nx * .16, z: a.z - nz * .16 }, { x: b.x - nx * .16, z: b.z - nz * .16 }, (floor + eave - .8) / 2, eave - floor + .8, .28);
      // Close the gable above the eaves. A ridge crossing adds a vertex;
      // otherwise a triangulated roof would leave an open, hollow end wall.
      const cuts = [0, 1], cross = (mid - a[short]) / (b[short] - a[short]);
      if (cross > 0 && cross < 1) cuts.splice(1, 0, cross);
      for (let j = 1; j < cuts.length; j++) {
        const point = (t: number) => ({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
        const aa = point(cuts[j - 1]!), bb = point(cuts[j]!);
        const topA = roofHeight(aa.x, aa.z), topB = roofHeight(bb.x, bb.z);
        if (Math.max(topA, topB) - eave < .001) continue;
        const vertices = [[aa.x, eave, aa.z], [bb.x, eave, bb.z], [bb.x, topB, bb.z], [aa.x, topA, aa.z]];
        const order = (bb.x - aa.x) * nz - (bb.z - aa.z) * nx > 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(order.flatMap(i => vertices[i]!), 3));
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(order.flatMap(i => [i === 1 || i === 2 ? length / 2.4 : 0, vertices[i]![1]! / .8]), 2));
        geo.computeVertexNormals(); add(0, geo);
      }
      edgeBox(1, a, b, floor + .35, .65, .34); edgeBox(1, a, b, eave - .14, .28, .55);
      if (length < 2.7) return;
      const bays = Math.max(1, Math.floor(length / 4));
      for (let n = 0; n < bays; n++) {
        const t = (n + .5) / bays, x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
        archWindow(x, z, nx, nz, Math.min(2.5, length / bays - .8), floor);
      }
    });
    if (pavilion.glassRoof) {
      // Greenhouse glazing bars follow the two roof planes, supplying real
      // shadow detail and readable pane scale from the Zoo camera.
      for (let x = minX + .5; x < maxX; x += 2.1) for (let z = minZ + .5; z < maxZ; z += 2.1) {
        if (!inSite(x, z, pavilion.ring)) continue;
        for (const axis of ['x', 'z'] as const) {
          const point = (off: number) => ({ x: x + (axis === 'x' ? off : 0), z: z + (axis === 'z' ? off : 0) });
          const end = (side: number) => {
            let low = 0, high = 1.06;
            for (let n = 0; n < 12; n++) {
              const t = (low + high) / 2, p = point(t * side);
              if (inSite(p.x, p.z, pavilion.ring)) low = t; else high = t;
            }
            return low * side;
          };
          const offsets = [end(-1), end(1)], ridge = mid - (axis === 'x' ? x : z);
          if (axis === short && ridge > offsets[0]! && ridge < offsets[1]!) offsets.splice(1, 0, ridge);
          for (let i = 1; i < offsets.length; i++) {
            const a = point(offsets[i - 1]!), b = point(offsets[i]!);
            const aa = new THREE.Vector3(a.x, roofHeight(a.x, a.z) + .04, a.z), bb = new THREE.Vector3(b.x, roofHeight(b.x, b.z) + .04, b.z);
            const direction = bb.clone().sub(aa), length = direction.length(); if (length < .01) continue;
            const geo = new THREE.BoxGeometry(.07, .08, length);
            geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction.normalize()));
            const center = aa.add(bb).multiplyScalar(.5); geo.translate(center.x, center.y, center.z); add(3, geo);
          }
        }
      }
    }
  }

  // Court paving, clipped turf beds and the actual octagonal pool outline.
  plate(1, zooAxisRing(ZOO_COURT), courtLevel + .045);
  for (const x of [-1739, -1698]) for (const z of [343, 374]) {
    box(6, 13, .12, 10, x, courtLevel + .105, z);
    for (const side of [-1, 1]) {
      box(7, 13, .48, .65, x, courtLevel + .32, z + side * 4.7);
      box(7, .65, .48, 9.4, x + side * 6.2, courtLevel + .32, z);
    }
    // Small ornamental crowns have varied individual lobes, without adding
    // full-size random forest trees inside the formal court.
    for (const dx of [-3.5, 3.5]) {
      box(3, .16, 2, .16, x + dx, courtLevel + 1, z);
      for (let i = 0; i < 5; i++) {
        const a = i * Math.PI * 2 / 5, geo = new THREE.IcosahedronGeometry(.95, 1);
        geo.scale(1, 1.25, 1); geo.translate(x + dx + Math.cos(a) * .55, courtLevel + 2.3 + (i % 2) * .2, z + Math.sin(a) * .55); add(7, geo);
      }
    }
  }
  const pool = zooAxisRing(PARK_SITES.zooPool.ring);
  plate(5, pool, courtLevel + .11);
  edges(pool, (a, b) => {
    edgeBox(1, a, b, courtLevel + .24, .48, .65);
    edgeBox(3, a, b, courtLevel + .68, .045, .06);
    const length = Math.hypot(b.x - a.x, b.z - a.z), n = Math.ceil(length / 1.2);
    for (let i = 0; i < n; i++) {
      const t = (i + .5) / n; box(3, .035, .45, .035, a.x + (b.x - a.x) * t, courtLevel + .45, a.z + (b.z - a.z) * t);
    }
  });
  // A low basking rock, with a deliberately irregular silhouette.
  for (let i = 0; i < 4; i++) {
    const geo = new THREE.IcosahedronGeometry(1, 1); geo.scale(2.2 - i * .2, .65 + i * .1, 1.65);
    geo.rotateY(i * .9); geo.translate(origin.along - 1 + i * 1.1, courtLevel + .4, origin.across + Math.sin(i) * .8); add(1, geo);
  }

  // Three actual open passages beneath an illustrative Delacorte clock
  // facade. The animal sculptures and moving musical mechanism are omitted.
  const clockX = -1667.2, clockZ = 390, clockFloor = ground(clockX, clockZ);
  const clockShape = new THREE.Shape(); clockShape.moveTo(-7, 0);
  for (const center of [-4.6, 0, 4.6]) {
    // An open-bottom arch is part of the outer contour, not a hole touching
    // its boundary (which ear clipping can incorrectly fill).
    clockShape.lineTo(center - 1.55, 0); clockShape.lineTo(center - 1.55, 2.3);
    clockShape.absellipse(center, 2.3, 1.55, 1.65, Math.PI, 0, true);
    clockShape.lineTo(center + 1.55, 0);
  }
  clockShape.lineTo(7, 0); clockShape.lineTo(7, 5.6); clockShape.lineTo(-7, 5.6); clockShape.closePath();
  const clockGeo = new THREE.ExtrudeGeometry(clockShape, { depth: 1.9, bevelEnabled: false, curveSegments: 12 });
  clockGeo.rotateY(Math.PI / 2); clockGeo.translate(clockX - .95, clockFloor, clockZ); add(0, clockGeo);
  box(1, 2.3, .28, 14.4, clockX, clockFloor + 5.62, clockZ);
  for (const z of [-5.8, -3, 3, 5.8]) box(3, .18, 2, .18, clockX, clockFloor + 6.75, clockZ + z);
  box(2, 3.4, .24, 14.7, clockX, clockFloor + 7.85, clockZ);
  box(0, 2.6, 3.1, 2.8, clockX, clockFloor + 9.25, clockZ);
  for (const side of [-1, 1]) {
    const face = new THREE.CircleGeometry(.98, 32); face.rotateY(side * Math.PI / 2); face.translate(clockX + side * 1.32, clockFloor + 9.55, clockZ); add(1, face);
    for (let i = 0; i < 12; i++) {
      const a = i * Math.PI / 6; box(3, .025, .12, .08, clockX + side * 1.34, clockFloor + 9.55 + Math.cos(a) * .8, clockZ + Math.sin(a) * .8);
    }
    box(3, .045, .6, .06, clockX + side * 1.35, clockFloor + 9.81, clockZ);
    box(3, .045, .07, .48, clockX + side * 1.35, clockFloor + 9.55, clockZ + .21);
  }
  const cap = new THREE.ConeGeometry(2.1, 1.3, 4); cap.rotateY(Math.PI / 4); cap.translate(clockX, clockFloor + 11.45, clockZ); add(2, cap);
  for (let i = 0; i < batches.length; i++) {
    const parts = batches[i]!; if (!parts.length) { materials[i]!.dispose(); continue; }
    const expanded = parts.map(p => p.index ? p.toNonIndexed() : p);
    const mesh = new THREE.Mesh(mergeGeometries(expanded)!, materials[i]);
    for (const p of new Set([...parts, ...expanded])) p.dispose();
    mesh.name = ['zoo-brick', 'zoo-stone', 'zoo-slate', 'zoo-frames', 'zoo-glazing', 'zoo-pool', 'zoo-turf', 'zoo-planting'][i]!;
    mesh.castShadow = i !== 5 && i !== 6; mesh.receiveShadow = true; group.add(mesh);
  }
  return group;
}
