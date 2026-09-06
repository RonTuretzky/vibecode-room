import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { mulberry32 } from "../ui/tree/spec";

// Elm-like vase, tiered oak-like crown, and an irregular broadleaf. These
// are visual forms, not a surveyed species assignment. Curved forks and root
// flares replace the old straight spoke trunks; each stays below 1,500 tris.
export const GROVE_FORMS = [
  { width: 4.7, height: 8.8, depth: 2.0, lobes: 12, cards: 32, lean: .55 },
  { width: 3.9, height: 10.8, depth: 1.7, lobes: 12, cards: 30, lean: -.3 },
  { width: 4.2, height: 8.3, depth: 2.3, lobes: 12, cards: 29, lean: 1.1 },
] as const;

export function buildGroveGeometry(formIndex: number) {
  const form = GROVE_FORMS[formIndex]!;
  const rng = mulberry32(0x47524f56 + formIndex * 1439);
  const leaves: THREE.BufferGeometry[] = [], wood: THREE.BufferGeometry[] = [];
  const limb = (start: THREE.Vector3, control: THREE.Vector3, end: THREE.Vector3, base: number, tip: number, sides = 5, segments = 3) => {
    const curve = new THREE.QuadraticBezierCurve3(start, control, end);
    const geometry = new THREE.TubeGeometry(curve, segments, 1, sides, false);
    const position = geometry.attributes.position!, point = new THREE.Vector3(), center = new THREE.Vector3();
    for (let j = 0; j <= segments; j++) {
      const t = j / segments, radius = THREE.MathUtils.lerp(base, tip, t);
      curve.getPointAt(t, center);
      for (let k = 0; k <= sides; k++) {
        const i = j * (sides + 1) + k;
        point.fromBufferAttribute(position, i).sub(center).multiplyScalar(radius).add(center);
        position.setXYZ(i, point.x, point.y, point.z);
      }
    }
    geometry.computeVertexNormals(); wood.push(geometry);
  };
  const fork = new THREE.Vector3(form.lean * .3, 3.7, .2);
  const crown = new THREE.Vector3(form.lean, form.height, -.2);
  limb(new THREE.Vector3(0, .12, 0), new THREE.Vector3(-form.lean * .15, 1.8, 0), fork, .51, .29, 8, 4);
  limb(fork, crown.clone().lerp(fork, .5).add(new THREE.Vector3(.15, 0, .2)), crown, .29, .05, 6, 3);
  // Flared roots taper into the ground, anchoring the tree without separate
  // contact-shadow decals or additional transparent overdraw.
  for (let i = 0; i < 5; i++) {
    const angle = i * Math.PI * 2 / 5 + rng() * .3, r = .85 + rng() * .45;
    limb(new THREE.Vector3(Math.cos(angle) * .26, .8, Math.sin(angle) * .26),
      new THREE.Vector3(Math.cos(angle) * .65, .18, Math.sin(angle) * .65),
      new THREE.Vector3(Math.cos(angle) * r, .04, Math.sin(angle) * r), .19, .015, 4, 2);
  }
  const normal = new THREE.Vector3();
  for (let lobe = 0; lobe < form.lobes; lobe++) {
    const angle = lobe * 2.39996 + rng() * .35;
    const tier = lobe / (form.lobes - 1);
    const radius = formIndex === 1 ? form.width * (1 - tier * .85) :
      form.width * (lobe > 8 ? .25 + rng() * .3 : .68 + rng() * .3);
    const y = formIndex === 1 ? 4.7 + tier * (form.height - 4.7) :
      form.height + (rng() - .4) * form.depth - (radius / form.width) * .8;
    const center = new THREE.Vector3(form.lean + Math.cos(angle) * radius, y, Math.sin(angle) * radius);
    const start = formIndex === 1 ? new THREE.Vector3(form.lean * tier, 3.5 + tier * 5.5, .1) : fork.clone().lerp(crown, rng() * .22);
    const control = start.clone().lerp(center, .53);
    control.y += formIndex === 0 ? 1.7 : .6;
    limb(start, control, center, .15 + rng() * .035, .02);
    const spread = formIndex === 1 ? 1.3 + (1 - tier) * .8 : 2.3;
    for (let i = 0; i < form.cards; i++) {
      const azimuth = rng() * Math.PI * 2, vertical = rng() * 2 - 1;
      const r = Math.cbrt(rng()), horizontal = Math.sqrt(1 - vertical * vertical);
      const card = new THREE.PlaneGeometry(2.05 + rng() * .7, 1.95 + rng() * .6);
      card.rotateZ(rng() * Math.PI * 2); card.rotateY(rng() * Math.PI);
      card.rotateX((rng() - .5) * Math.PI);
      card.translate(center.x + Math.cos(azimuth) * horizontal * r * spread,
        center.y + vertical * r * form.depth, center.z + Math.sin(azimuth) * horizontal * r * spread);
      const points = card.getAttribute("position"), normals = card.getAttribute("normal");
      const colors = new Float32Array(points.count * 3);
      for (let v = 0; v < points.count; v++) {
        normal.set(points.getX(v) - center.x, (points.getY(v) - center.y) * .65 + .9, points.getZ(v) - center.z).normalize();
        normals.setXYZ(v, normal.x, normal.y, normal.z);
        const height = THREE.MathUtils.clamp((points.getY(v) - (center.y - form.depth)) / (form.depth * 2), 0, 1);
        const shade = .63 + height * .37;
        colors.set([shade, shade, shade], v * 3);
      }
      card.setAttribute("color", new THREE.BufferAttribute(colors, 3)); leaves.push(card);
    }
  }
  const trunk = mergeGeometries(wood)!, canopy = mergeGeometries(leaves)!;
  [...wood, ...leaves].forEach(part => part.dispose());
  trunk.computeBoundingBox(); canopy.computeBoundingBox(); return { trunk, canopy };
}
