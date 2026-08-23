// Central Park's landmarks as small hand-built models, stood exactly where
// OpenStreetMap places them, at true 1:1 metres in the park frame (the room
// scales the whole world down). These are deliberately SHAPED rather than
// boxed — a tapered needle, an iron arch, tiered basins, a stone arch, a
// crenellated keep — because at diorama scale what reads is silhouette:
//
//   Cleopatra's Needle   21 m granite obelisk on a stepped pedestal (east
//                        of the Great Lawn, behind the Met)
//   Bow Bridge           26 m cast-iron arch over the Lake, cream-white
//   Bethesda Fountain    the Angel of the Waters over two tiers of basin in
//                        a 29 m pool at the foot of the terrace
//   Gapstow Bridge       the little stone arch over the Pond's neck
//   Belvedere Castle     the Vista Rock lookout: keep, tower and turret
//
// Plus two line features the models alone can't carry: the Mall's four elm
// rows (tree positions for the caller's real tree scans) and the schist
// outcrops (positions for the caller's rock scans).

import * as THREE from "three";
import { DEG, localFromLatLon } from "./park-frame";

export interface LandmarkSpec {
  name: string;
  lat: number;
  lon: number;
  // Heading of the model's +Z axis, degrees clockwise from north.
  bearing: number;
  build: () => THREE.Object3D;
}

const GRANITE = 0x8a7270;
const IRON_CREAM = 0xe7e0cd;
const BRONZE = 0x5e7263;
const STONE = 0x8c847a;
const DARK_STONE = 0x6f6962;
const BASIN = 0xb9b3a6;

const mat = (color: number, roughness = 0.85): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness: 0 });

// ── Cleopatra's Needle ──────────────────────────────────────────────────────
function buildObelisk(): THREE.Object3D {
  const g = new THREE.Group();
  const granite = mat(GRANITE, 0.7);
  // Three stepped pedestal courses.
  let base = 0;
  for (const [size, h] of [
    [7.5, 1.0],
    [5.5, 1.6],
    [3.6, 2.2],
  ]) {
    const step = new THREE.Mesh(new THREE.BoxGeometry(size, h, size), granite);
    step.position.y = base + h / 2;
    base += h;
    g.add(step);
  }
  // The shaft tapers from 2.4 m to 1.6 m over 19 m, then the pyramidion.
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 1.2, 19, 4, 1), granite);
  shaft.rotation.y = Math.PI / 4;
  shaft.position.y = base + 9.5;
  g.add(shaft);
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.8, 1.4, 4), granite);
  tip.rotation.y = Math.PI / 4;
  tip.position.y = base + 19 + 0.7;
  g.add(tip);
  return g;
}

// ── Bow Bridge ──────────────────────────────────────────────────────────────
// Side profile extruded across the deck width: a shallow arch beam between
// two abutments, railing posts and a top rail along both edges.
function buildBowBridge(): THREE.Object3D {
  const g = new THREE.Group();
  const span = 26;
  const width = 4.2;
  const rise = 1.6;
  const deckBase = 2.4; // deck height over the water at the abutments
  const cream = mat(IRON_CREAM, 0.6);
  const top = (t: number) => deckBase + rise * (1 - t * t); // t ∈ [-1, 1]
  const profile = new THREE.Shape();
  const n = 24;
  profile.moveTo(-span / 2, top(-1));
  for (let i = 1; i <= n; i++) {
    const t = -1 + (2 * i) / n;
    profile.lineTo((t * span) / 2, top(t));
  }
  // Underside: a deeper arch so the beam reads as a bow, not a slab.
  for (let i = n; i >= 0; i--) {
    const t = -1 + (2 * i) / n;
    profile.lineTo((t * span) / 2, top(t) - 0.35 - 1.1 * (1 - t * t));
  }
  profile.closePath();
  const beam = new THREE.Mesh(new THREE.ExtrudeGeometry(profile, { depth: width, bevelEnabled: false }), cream);
  beam.position.z = -width / 2;
  g.add(beam);
  // Abutments in stone.
  for (const side of [-1, 1]) {
    const ab = new THREE.Mesh(new THREE.BoxGeometry(4, deckBase, width + 0.6), mat(STONE));
    ab.position.set(side * (span / 2 + 2), deckBase / 2, 0);
    g.add(ab);
  }
  // Railings: posts every 1.3 m and a rail, both edges.
  const postGeo = new THREE.CylinderGeometry(0.05, 0.05, 1.0, 6);
  const railPts: THREE.Vector3[][] = [[], []];
  for (let i = 0; i <= 20; i++) {
    const t = -1 + (2 * i) / 20;
    const x = (t * span) / 2;
    const y = top(t);
    [-1, 1].forEach((side, k) => {
      const post = new THREE.Mesh(postGeo, cream);
      post.position.set(x, y + 0.5, (side * width) / 2);
      g.add(post);
      railPts[k].push(new THREE.Vector3(x, y + 1.0, (side * width) / 2));
    });
  }
  for (const pts of railPts) {
    const rail = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 32, 0.07, 6, false), cream);
    g.add(rail);
  }
  return g;
}

// ── Bethesda Fountain ───────────────────────────────────────────────────────
function buildBethesda(): THREE.Object3D {
  const g = new THREE.Group();
  const stone = mat(BASIN, 0.8);
  // Pool rim.
  const rim = new THREE.Mesh(new THREE.CylinderGeometry(14.5, 14.5, 0.7, 48, 1, true), stone);
  rim.material.side = THREE.DoubleSide;
  rim.position.y = 0.35;
  g.add(rim);
  const rimTop = new THREE.Mesh(new THREE.RingGeometry(13.9, 14.5, 48), stone);
  rimTop.rotation.x = -Math.PI / 2;
  rimTop.position.y = 0.7;
  g.add(rimTop);
  // Pool water.
  const pool = new THREE.Mesh(
    new THREE.CircleGeometry(13.9, 48),
    new THREE.MeshStandardMaterial({ color: 0x5f8790, roughness: 0.1, metalness: 0.4 }),
  );
  pool.rotation.x = -Math.PI / 2;
  pool.position.y = 0.5;
  g.add(pool);
  // Centre: lathe profile — plinth, stem, the wide lower basin, a second
  // stem, the small upper basin, the angel's pedestal.
  const profile: THREE.Vector2[] = [
    new THREE.Vector2(0, 0),
    new THREE.Vector2(3.2, 0),
    new THREE.Vector2(3.0, 1.2),
    new THREE.Vector2(1.0, 1.4),
    new THREE.Vector2(0.9, 2.6),
    new THREE.Vector2(4.6, 3.0), // lower basin lip
    new THREE.Vector2(4.4, 3.5),
    new THREE.Vector2(1.2, 3.4),
    new THREE.Vector2(0.7, 4.2),
    new THREE.Vector2(0.7, 5.6),
    new THREE.Vector2(2.2, 5.9), // upper basin lip
    new THREE.Vector2(2.0, 6.3),
    new THREE.Vector2(0.8, 6.2),
    new THREE.Vector2(0.6, 7.6),
    new THREE.Vector2(0, 7.6),
  ];
  const centre = new THREE.Mesh(new THREE.LatheGeometry(profile, 40), stone);
  g.add(centre);
  // Angel of the Waters: a standing figure with outspread wings — kept as
  // a silhouette (body, head, two wing shapes), bronze-green.
  const bronze = mat(BRONZE, 0.5);
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.45, 2.0, 4, 10), bronze);
  body.position.y = 7.6 + 1.45;
  g.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 10), bronze);
  head.position.y = 7.6 + 2.9;
  g.add(head);
  const wing = new THREE.Shape();
  wing.moveTo(0, 0);
  wing.quadraticCurveTo(1.6, 1.6, 2.6, 0.9);
  wing.quadraticCurveTo(2.0, 0.2, 1.4, -0.8);
  wing.quadraticCurveTo(0.6, -0.9, 0, -0.6);
  wing.closePath();
  const wingGeo = new THREE.ExtrudeGeometry(wing, { depth: 0.12, bevelEnabled: false });
  for (const side of [-1, 1]) {
    const w = new THREE.Mesh(wingGeo, bronze);
    w.scale.x = side;
    w.position.set(side * 0.3, 7.6 + 2.0, 0.25);
    w.rotation.y = side * 0.35;
    g.add(w);
  }
  return g;
}

// ── Gapstow Bridge ──────────────────────────────────────────────────────────
function buildGapstow(): THREE.Object3D {
  const g = new THREE.Group();
  const length = 13.5;
  const height = 3.4;
  const width = 3.6;
  const shape = new THREE.Shape();
  shape.moveTo(-length / 2, 0);
  shape.lineTo(length / 2, 0);
  shape.lineTo(length / 2, height - 0.6);
  // Gentle hump of the parapet.
  shape.quadraticCurveTo(0, height + 0.9, -length / 2, height - 0.6);
  shape.closePath();
  const arch = new THREE.Path();
  arch.absarc(0, 0.2, 3.4, Math.PI, 0, true);
  arch.lineTo(-3.4, 0.2);
  shape.holes.push(arch);
  const body = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: false }), mat(DARK_STONE, 0.9));
  body.position.z = -width / 2;
  g.add(body);
  return g;
}

// ── Belvedere Castle ────────────────────────────────────────────────────────
function buildBelvedere(): THREE.Object3D {
  const g = new THREE.Group();
  const stone = mat(STONE, 0.9);
  const crenellate = (w: number, d: number, y: number) => {
    const merlon = new THREE.BoxGeometry(0.7, 0.9, 0.5);
    const along = (len: number, fixed: number, axis: "x" | "z") => {
      for (let s = -len / 2 + 0.6; s <= len / 2 - 0.6; s += 1.4) {
        const m = new THREE.Mesh(merlon, stone);
        if (axis === "x") {
          m.position.set(s, y + 0.45, fixed);
        } else {
          m.rotation.y = Math.PI / 2;
          m.position.set(fixed, y + 0.45, s);
        }
        g.add(m);
      }
    };
    along(w, d / 2 - 0.25, "x");
    along(w, -d / 2 + 0.25, "x");
    along(d, w / 2 - 0.25, "z");
    along(d, -w / 2 + 0.25, "z");
  };
  // The keep on the rock.
  const keep = new THREE.Mesh(new THREE.BoxGeometry(12, 7, 8), stone);
  keep.position.y = 3.5;
  g.add(keep);
  crenellate(12, 8, 7);
  // The square tower at the west end.
  const tower = new THREE.Mesh(new THREE.BoxGeometry(5.5, 15, 5.5), stone);
  tower.position.set(-3.5, 7.5, 0);
  g.add(tower);
  const towerTop = new THREE.Group();
  towerTop.position.set(-3.5, 0, 0);
  g.add(towerTop);
  for (let s = -2.2; s <= 2.2; s += 1.4) {
    for (const [x, z] of [
      [s, 2.5],
      [s, -2.5],
      [2.5, s],
      [-2.5, s],
    ]) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.9, 0.5), stone);
      m.position.set(x, 15.45, z);
      if (Math.abs(x) === 2.5) {
        m.rotation.y = Math.PI / 2;
      }
      towerTop.add(m);
    }
  }
  // The round turret with its conical cap.
  const turret = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.3, 18, 16), stone);
  turret.position.set(-6.3, 9, 2.8);
  g.add(turret);
  const cap = new THREE.Mesh(new THREE.ConeGeometry(1.6, 2.6, 16), mat(DARK_STONE));
  cap.position.set(-6.3, 18 + 1.3, 2.8);
  g.add(cap);
  return g;
}

// Gapstow's site, exported for the room's tree-clearing pass.
export const GAPSTOW = localFromLatLon(40.76693, -73.97381);

export const LANDMARKS: LandmarkSpec[] = [
  { name: "Cleopatra's Needle", lat: 40.77965, lon: -73.9654, bearing: 29, build: buildObelisk },
  // Bow Bridge's footway runs 148° (SSE) per OSM; the model's span is its X
  // axis, so +Z faces 148 − 90.
  { name: "Bow Bridge", lat: 40.77576, lon: -73.97177, bearing: 58, build: buildBowBridge },
  { name: "Bethesda Fountain", lat: 40.77432, lon: -73.97083, bearing: 29, build: buildBethesda },
  { name: "Gapstow Bridge", lat: 40.76693, lon: -73.97381, bearing: 160, build: buildGapstow },
  { name: "Belvedere Castle", lat: 40.7793, lon: -73.96887, bearing: 29, build: buildBelvedere },
];

// Build every landmark into one group in the park frame, each standing on
// the caller's ground (water sits at ground level, so bridges land on it).
export function buildLandmarks(groundAt: (x: number, z: number) => number): THREE.Group {
  const group = new THREE.Group();
  group.name = "park-landmarks";
  for (const spec of LANDMARKS) {
    const p = localFromLatLon(spec.lat, spec.lon);
    const model = spec.build();
    model.name = spec.name;
    model.position.set(p.x, groundAt(p.x, p.z), p.z);
    // Bearing clockwise from north (−Z) → rotation about +Y.
    model.rotation.y = Math.PI - spec.bearing * DEG;
    group.add(model);
  }
  return group;
}

// The Mall: four rows of American elms along the 400 m promenade from the
// Olmsted bed to Bethesda Terrace, spaced ~15 m. Returns park-frame points.
export function mallElmPositions(): { x: number; z: number }[] {
  const south = localFromLatLon(40.77115, -73.97285);
  const north = localFromLatLon(40.77385, -73.9712);
  const dx = north.x - south.x;
  const dz = north.z - south.z;
  const len = Math.hypot(dx, dz);
  const ux = dx / len;
  const uz = dz / len;
  const px = -uz; // across the promenade
  const pz = ux;
  const points: { x: number; z: number }[] = [];
  for (let d = 8; d < len - 8; d += 15) {
    for (const off of [-13, -6, 6, 13]) {
      points.push({ x: south.x + ux * d + px * off, z: south.z + uz * d + pz * off });
    }
  }
  return points;
}

// Schist outcrops worth a few real rock scans: centre + spread radius (m).
export const OUTCROPS: { name: string; lat: number; lon: number; radius: number }[] = [
  { name: "Pond west shore", lat: 40.7664, lon: -73.97493, radius: 12 },
  { name: "Umpire Rock", lat: 40.76917, lon: -73.97775, radius: 28 },
  { name: "Vista Rock", lat: 40.77941, lon: -73.96907, radius: 22 },
  { name: "Rat Rock", lat: 40.7695, lon: -73.97585, radius: 14 },
  { name: "Ramble outcrop", lat: 40.77705, lon: -73.97095, radius: 16 },
];
