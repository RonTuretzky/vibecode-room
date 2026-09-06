import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { mulberry32 } from "../ui/tree/spec";

// Elm vase, rounded oak and an irregular spreading plane-like crown. These
// describe genus-level silhouettes; each individual remains an interpretation.
export const GROVE_FORMS = [
  { width: 4.8, height: 9.4, depth: 2.0, lobes: 14, cards: 24, lean: .55 },
  { width: 4.9, height: 8.5, depth: 2.7, lobes: 16, cards: 20, lean: -.3 },
  { width: 4.2, height: 9.0, depth: 2.8, lobes: 14, cards: 22, lean: 1.1 },
] as const;

export function groveFormForGenus(genus?: string | null): number | undefined {
  const value = genus?.trim().toLowerCase();
  if (value?.startsWith('ulmus')) return 0;
  if (value?.startsWith('quercus')) return 1;
  if (value?.startsWith('platanus')) return 2;
  return undefined;
}

export function buildGroveGeometry(formIndex: number, detail = false) {
  const form = GROVE_FORMS[formIndex]!;
  const rng = mulberry32(0x47524f56 + formIndex * 1439);
  const leaves: THREE.BufferGeometry[] = [], wood: THREE.BufferGeometry[] = [];
  const limb = (start: THREE.Vector3, control: THREE.Vector3, end: THREE.Vector3, base: number, tip: number, sides = 5, segments = 3) => {
    if (detail) { sides = base > .25 ? 16 : 8; segments = Math.max(segments, 7); }
    const curve = new THREE.QuadraticBezierCurve3(start, control, end);
    const geometry = new THREE.TubeGeometry(curve, segments, 1, sides, false);
    const position = geometry.attributes.position!, uv = geometry.attributes.uv!;
    const point = new THREE.Vector3(), center = new THREE.Vector3();
    const length = curve.getLength();
    for (let j = 0; j <= segments; j++) {
      const t = j / segments, radius = THREE.MathUtils.lerp(base, tip, t);
      curve.getPointAt(t, center);
      for (let k = 0; k <= sides; k++) {
        const i = j * (sides + 1) + k;
        point.fromBufferAttribute(position, i).sub(center).multiplyScalar(radius).add(center);
        position.setXYZ(i, point.x, point.y, point.z);
        // Tube U runs along the limb by default; bark grain must run along V.
        // Keep the grain at local metre scale instead of stretching one tile over
        // the complete trunk or squeezing it into a short twig.
        uv.setXY(i, k / sides * Math.PI * 2 * Math.max(.035, (base + tip) * .5), t * length);
      }
    }
    geometry.computeVertexNormals(); wood.push(geometry); return curve;
  };
  const fork = new THREE.Vector3(form.lean * .3, formIndex === 1 ? 2.8 : 3.7, .2);
  const crown = new THREE.Vector3(form.lean, form.height, -.2);
  limb(new THREE.Vector3(0, -.12, 0), new THREE.Vector3(-form.lean * .15, 1.8, 0), fork, .51, .29, 8, 4);
  const leader = limb(fork, crown.clone().lerp(fork, .5).add(new THREE.Vector3(.15, 0, .2)), crown, .29, .05, 6, 3);
  const scaffolds = Array.from({ length: 5 }, (_, i) => {
    const angle = i * Math.PI * 2 / 5 + .17;
    const end = new THREE.Vector3(form.lean + Math.cos(angle) * form.width * .44,
      form.height * (.72 + (i % 3) * .035), Math.sin(angle) * form.width * .44);
    const start = leader.getPoint((i % 3) * .035);
    const control = start.clone().lerp(end, .55); control.y += formIndex === 0 ? .9 : .2;
    return limb(start, control, end, .18, .06, 5, 3);
  });
  // Flared roots taper into the ground, anchoring the tree without separate
  // contact-shadow decals or additional transparent overdraw.
  for (let i = 0; i < 5; i++) {
    const angle = i * Math.PI * 2 / 5 + rng() * .3, r = .85 + rng() * .45;
    limb(new THREE.Vector3(Math.cos(angle) * .26, .8, Math.sin(angle) * .26),
      new THREE.Vector3(Math.cos(angle) * .65, .18, Math.sin(angle) * .65),
      new THREE.Vector3(Math.cos(angle) * r, -.08, Math.sin(angle) * r), .19, .015, 4, 2);
  }
  const normal = new THREE.Vector3();
  for (let lobe = 0; lobe < form.lobes; lobe++) {
    const angle = lobe * 2.39996 + rng() * .35;
    // The inner lobes fill the top; outer lobes fall around a broad shoulder.
    // A linear bottom-wide taper made the old oak read like a conifer.
    const ring = lobe % 4;
    const radius = form.width * (ring === 0 ? .22 + rng() * .23 : .65 + rng() * .35);
    const y = form.height + (rng() - .5) * form.depth * .7 -
      (radius / form.width) * (formIndex === 0 ? .75 : formIndex === 1 ? 2.1 : 1.5);
    const center = new THREE.Vector3(form.lean + Math.cos(angle) * radius, y, Math.sin(angle) * radius);
    const branch = scaffolds[Math.round(((angle - .17) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) / (Math.PI * 2 / 5)) % 5]!;
    const start = ring === 0 ? leader.getPoint(.65 + rng() * .2) :
      branch.getPoint(.68 + rng() * .3);
    const control = start.clone().lerp(center, .53);
    control.y += formIndex === 0 ? .7 : .2;
    limb(start, control, center, .06 + rng() * .015, detail ? .035 : .012);
    const spread = formIndex === 1 ? 2.1 : 2.0;
    if (detail) {
      for (let twig = 0; twig < 5; twig++) {
        const a = angle + twig * 2.39996;
        const end = center.clone().add(new THREE.Vector3(Math.cos(a) * spread, (twig % 3 - .5) * .65, Math.sin(a) * spread));
        const bend = center.clone().lerp(end, .5); bend.y += .35;
        limb(center, bend, end, .025, .006, 4, 3);
      }
    }
    const cards = detail ? form.cards * 7 : form.cards;
    for (let i = 0; i < cards; i++) {
      const azimuth = rng() * Math.PI * 2, vertical = rng() * 2 - 1;
      const r = Math.cbrt(rng()), horizontal = Math.sqrt(1 - vertical * vertical);
      const card = new THREE.PlaneGeometry((detail ? .70 : 1.8) + rng() * (detail ? .30 : .55),
        (detail ? .65 : 1.65) + rng() * (detail ? .25 : .5));
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
