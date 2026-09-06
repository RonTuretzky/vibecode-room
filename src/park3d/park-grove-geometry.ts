import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { mulberry32 } from "../ui/tree/spec";

// Spreading, upright, and open/irregular broadleaf silhouettes. Each stays
// under 1,000 triangles including its branched trunk, independent of scale.
export const GROVE_FORMS = [
  { width: 4.0, height: 8.1, depth: 1.8, lobes: 10, cards: 32, lean: .7 },
  { width: 2.6, height: 9.3, depth: 2.7, lobes: 8, cards: 38, lean: -.4 },
  { width: 3.5, height: 7.4, depth: 2.1, lobes: 11, cards: 28, lean: 1.2 },
] as const;

export function buildGroveGeometry(formIndex: number) {
  const form = GROVE_FORMS[formIndex]!;
  const rng = mulberry32(0x47524f56 + formIndex * 1439);
  const leaves: THREE.BufferGeometry[] = [], wood: THREE.BufferGeometry[] = [];
  const up = new THREE.Vector3(0, 1, 0), unit = new THREE.Vector3(1, 1, 1);
  const matrix = new THREE.Matrix4(), quat = new THREE.Quaternion();
  const limb = (start: THREE.Vector3, end: THREE.Vector3, base: number, tip: number, sides: number) => {
    const direction = end.clone().sub(start);
    const geometry = new THREE.CylinderGeometry(tip, base, direction.length(), sides);
    quat.setFromUnitVectors(up, direction.normalize());
    matrix.compose(start.clone().lerp(end, .5), quat, unit);
    geometry.applyMatrix4(matrix); wood.push(geometry);
  };
  const fork = new THREE.Vector3(form.lean * .4, 3.4, .2);
  const crown = new THREE.Vector3(form.lean, form.height, -.2);
  limb(new THREE.Vector3(), fork, .5, .3, 7);
  limb(fork, crown, .3, .06, 6);
  const normal = new THREE.Vector3();
  for (let lobe = 0; lobe < form.lobes; lobe++) {
    const angle = lobe * 2.39996 + rng() * .45;
    const radius = lobe === form.lobes - 1 ? .3 : form.width * (.62 + rng() * .38);
    const center = new THREE.Vector3(form.lean + Math.cos(angle) * radius,
      form.height + (rng() - .35) * form.depth * 1.4, Math.sin(angle) * radius);
    limb(fork.clone().lerp(crown, rng() * .45), center, .15 + rng() * .04, .025, 5);
    for (let i = 0; i < form.cards; i++) {
      const azimuth = rng() * Math.PI * 2, vertical = rng() * 2 - 1;
      const r = Math.cbrt(rng()), horizontal = Math.sqrt(1 - vertical * vertical);
      const card = new THREE.PlaneGeometry(2.3 + rng() * .8, 2.1 + rng() * .7);
      card.rotateZ(rng() * Math.PI * 2); card.rotateY(rng() * Math.PI);
      card.rotateX((rng() - .5) * Math.PI);
      card.translate(center.x + Math.cos(azimuth) * horizontal * r * 2.1,
        center.y + vertical * r * form.depth, center.z + Math.sin(azimuth) * horizontal * r * 2.1);
      const points = card.getAttribute("position"), normals = card.getAttribute("normal");
      const colors = new Float32Array(points.count * 3);
      for (let v = 0; v < points.count; v++) {
        normal.set(points.getX(v) - center.x, (points.getY(v) - center.y) * .7 + .8, points.getZ(v) - center.z).normalize();
        normals.setXYZ(v, normal.x, normal.y, normal.z);
        const height = THREE.MathUtils.clamp((points.getY(v) - (form.height - form.depth * 1.5)) / (form.depth * 3), 0, 1);
        // Crown interiors stay coherent instead of hundreds of random flat planes.
        const shade = .72 + height * .28;
        colors.set([shade, shade, shade], v * 3);
      }
      card.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      leaves.push(card);
    }
  }
  const trunk = mergeGeometries(wood)!, canopy = mergeGeometries(leaves)!;
  [...wood, ...leaves].forEach(part => part.dispose());
  trunk.computeBoundingBox(); canopy.computeBoundingBox();
  return { trunk, canopy };
}
