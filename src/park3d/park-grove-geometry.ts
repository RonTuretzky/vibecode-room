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

export const GROVE_VARIANTS = 3;

/** Position seeds survive batching/rebuilds and do not change neighbouring
 * trees when the source order changes. A mapped genus overrides the fallback. */
export function groveAppearanceAt(x: number, z: number) {
  const rng = mulberry32((Math.imul(Math.round(x * 100), 73856093) ^ Math.imul(Math.round(z * 100), 19349663)) >>> 0);
  return { variant: Math.floor(rng() * GROVE_VARIANTS), width: .87 + rng() * .26,
    depth: .91 + rng() * .18, tone: .81 + rng() * .14, hue: (rng() - .5) * .018,
    fallbackForm: Math.floor(rng() * GROVE_FORMS.length) };
}

export function groveFormForGenus(genus?: string | null): number | undefined {
  const value = genus?.trim().toLowerCase();
  if (value?.startsWith('ulmus')) return 0;
  if (value?.startsWith('quercus')) return 1;
  if (value?.startsWith('platanus')) return 2;
  return undefined;
}

export function buildGroveGeometry(formIndex: number, detail = false, variant = 0) {
  const form = GROVE_FORMS[formIndex]!;
  const seed = (0x47524f56 + formIndex * 1439 + Math.imul(variant, 2654435761)) >>> 0;
  const rng = mulberry32(seed);
  const height = form.height * (.97 + rng() * .08), width = form.width * (.9 + rng() * .18);
  const lean = new THREE.Vector3(form.lean + (rng() - .5) * 1.25, 0, (rng() - .5) * 1.1);
  const stretchZ = .85 + rng() * .3, shoulder = rng() * Math.PI * 2;
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
  const fork = new THREE.Vector3(lean.x * .32, (formIndex === 1 ? 2.8 : 3.7) + (rng() - .5) * .8, lean.z * .32);
  const crown = new THREE.Vector3(lean.x, height, lean.z);
  limb(new THREE.Vector3(0, -.12, 0), new THREE.Vector3(-lean.x * .15, 1.8, -lean.z * .15), fork, .51, .29, 8, 4);
  const leader = limb(fork, crown.clone().lerp(fork, .5).add(new THREE.Vector3(.15, 0, .2)), crown, .29, .05, 6, 3);
  const scaffolds = Array.from({ length: 5 }, (_, i) => {
    const angle = i * Math.PI * 2 / 5 + shoulder + (rng() - .5) * .45;
    const reach = width * (.37 + rng() * .18);
    const end = new THREE.Vector3(lean.x + Math.cos(angle) * reach,
      height * (.68 + rng() * .16), lean.z + Math.sin(angle) * reach * stretchZ);
    // Stagger attachment heights: a ring of identical forks reads as a
    // manufactured hub, especially from beneath a near crown.
    const start = leader.getPoint(.02 + i * .045 + rng() * .055);
    const control = start.clone().lerp(end, .55); control.y += formIndex === 0 ? .9 : .2;
    return { angle, curve: limb(start, control, end, .16 + rng() * .035, .045 + rng() * .025, 5, 3) };
  });
  // Flared roots taper into the ground, anchoring the tree without separate
  // contact-shadow decals or additional transparent overdraw.
  const roots = variant === 1 ? 4 : 5;
  for (let i = 0; i < roots; i++) {
    const angle = i * Math.PI * 2 / roots + shoulder + (rng() - .5) * .7, r = .7 + rng() * .7;
    const bend = angle + (rng() - .5) * .3;
    limb(new THREE.Vector3(Math.cos(angle) * .26, .65 + rng() * .25, Math.sin(angle) * .26),
      new THREE.Vector3(Math.cos(bend) * r * .55, .12 + rng() * .12, Math.sin(bend) * r * .55),
      new THREE.Vector3(Math.cos(angle) * r, -.08, Math.sin(angle) * r), .14 + rng() * .055, .015, 4, 2);
  }
  const normal = new THREE.Vector3();
  for (let lobe = 0; lobe < form.lobes; lobe++) {
    const angle = lobe * 2.39996 + shoulder + rng() * .55;
    // The inner lobes fill the top; outer lobes fall around a broad shoulder.
    // A linear bottom-wide taper made the old oak read like a conifer.
    const ring = lobe % 4;
    const radius = width * (ring === 0 ? .22 + rng() * .23 : .65 + rng() * .35) * (1 + Math.cos(angle - shoulder) * .09);
    const y = height + (rng() - .5) * form.depth * .9 -
      (radius / width) * (formIndex === 0 ? .75 : formIndex === 1 ? 2.1 : 1.5);
    const center = new THREE.Vector3(lean.x + Math.cos(angle) * radius, y, lean.z + Math.sin(angle) * radius * stretchZ);
    const branch = scaffolds.reduce((nearest, candidate) =>
      Math.cos(angle - candidate.angle) > Math.cos(angle - nearest.angle) ? candidate : nearest).curve;
    const start = ring === 0 ? leader.getPoint(.65 + rng() * .2) :
      branch.getPoint(.68 + rng() * .3);
    const control = start.clone().lerp(center, .53);
    control.y += formIndex === 0 ? .7 : .2;
    limb(start, control, center, .06 + rng() * .015, detail ? .035 : .012);
    const spread = formIndex === 1 ? 2.1 : 2.0;
    const twigs: THREE.QuadraticBezierCurve3[] = [];
    if (detail) {
      const twigRng = mulberry32(seed ^ Math.imul(lobe + 1, 1664525));
      for (let twig = 0; twig < 5; twig++) {
        const a = angle + twig * 2.39996 + twigRng() * .3;
        const reach = spread * (.65 + twigRng() * .35);
        const end = center.clone().add(new THREE.Vector3(Math.cos(a) * reach,
          (twigRng() * 2 - 1) * form.depth * .82 + .2, Math.sin(a) * reach));
        const bend = center.clone().lerp(end, .5); bend.y += .35;
        twigs.push(limb(center, bend, end, .025, .006, 4, 3));
      }
    }
    const cards = detail ? form.cards * 7 : form.cards;
    // Detail may change leaf count, never the next lobe's branching layout.
    // This keeps coarse/fine trees recognizably the same individual.
    const leafRng = mulberry32(seed ^ Math.imul(lobe + 1, 1013904223));
    for (let i = 0; i < cards; i++) {
      const azimuth = leafRng() * Math.PI * 2, vertical = leafRng() * 2 - 1;
      const r = Math.cbrt(leafRng()), horizontal = Math.sqrt(1 - vertical * vertical);
      const card = new THREE.PlaneGeometry((detail ? .70 : 1.8) + leafRng() * (detail ? .30 : .55),
        (detail ? .65 : 1.65) + leafRng() * (detail ? .25 : .5));
      card.rotateZ(leafRng() * Math.PI * 2); card.rotateY(leafRng() * Math.PI);
      card.rotateX((leafRng() - .5) * Math.PI);
      // Near leaf sprays grow along connected terminal twigs. Filling an
      // ellipsoid independently of the branches left many floating sprays.
      const anchor = detail ? twigs[i % twigs.length]!.getPoint(.25 + leafRng() * .75) : center;
      const leafReach = detail ? .58 : spread, leafDepth = detail ? .48 : form.depth;
      card.translate(anchor.x + Math.cos(azimuth) * horizontal * r * leafReach,
        anchor.y + vertical * r * leafDepth, anchor.z + Math.sin(azimuth) * horizontal * r * leafReach);
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
