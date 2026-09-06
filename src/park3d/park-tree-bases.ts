import * as THREE from 'three';

// Above this local height, every vertex keeps its original position/normal.
// Splitting along existing triangle edges avoids a cut seam through the trunk.
export const TREE_BASE_BLEND_HEIGHT = 1.3;

/** Compact, disjoint triangle sets: an instanced upper trunk and a small base
 * that can follow each tree's actual terrain. The input remains untouched. */
export function splitTreeBase(source: THREE.BufferGeometry) {
  const position = source.getAttribute('position'), indices = source.index!;
  const base: number[] = [], trunk: number[] = [];
  for (let i = 0; i < indices.count; i += 3) {
    const a = indices.getX(i), b = indices.getX(i + 1), c = indices.getX(i + 2);
    const destination = Math.min(position.getY(a), position.getY(b), position.getY(c)) < TREE_BASE_BLEND_HEIGHT ? base : trunk;
    destination.push(a, b, c);
  }
  const compact = (selected: number[]) => {
    const geometry = new THREE.BufferGeometry(), remap = new Map<number, number>();
    const originals: number[] = [];
    const index = selected.map(original => {
      if (!remap.has(original)) { remap.set(original, remap.size); originals.push(original); }
      return remap.get(original)!;
    });
    for (const name of Object.keys(source.attributes)) {
      const attribute = source.getAttribute(name), size = attribute.itemSize;
      const values = new Float32Array(originals.length * size);
      originals.forEach((original, i) => {
        for (let c = 0; c < size; c++) values[i * size + c] = attribute.getComponent(original, c);
      });
      geometry.setAttribute(name, new THREE.BufferAttribute(values, size));
    }
    geometry.setIndex(index); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
    return geometry;
  };
  return { base: compact(base), trunk: compact(trunk) };
}

/** Ground the roots without leaning the whole tree or changing its canopy.
 * Work happens once at construction. The fitted mesh supplies normal shadows
 * and reflections with no shader-side height queries or extra depth material. */
export function fitTreeBase(source: THREE.BufferGeometry, placement: THREE.Matrix4,
  groundAt: (x: number, z: number) => number) {
  const fitted = source.clone(); fitted.applyMatrix4(placement);
  const local = source.getAttribute('position'), position = fitted.getAttribute('position');
  const weights = new Float32Array(position.count), point = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    const weight = 1 - THREE.MathUtils.smoothstep(local.getY(i), .25, TREE_BASE_BLEND_HEIGHT);
    weights[i] = weight;
    if (!weight) continue;
    point.fromBufferAttribute(position, i);
    const ground = groundAt(point.x, point.z);
    if (Number.isFinite(ground)) position.setY(i, point.y + (ground - placement.elements[13]!) * weight);
  }
  // The original transformed normals remain authoritative at the unchanged
  // upper boundary. Blend them into freshly computed root normals below it.
  const originalNormal = fitted.getAttribute('normal').clone();
  fitted.computeVertexNormals();
  const normal = fitted.getAttribute('normal'), original = new THREE.Vector3();
  for (let i = 0; i < normal.count; i++) {
    point.fromBufferAttribute(normal, i); original.fromBufferAttribute(originalNormal, i);
    point.lerp(original, 1 - weights[i]!).normalize(); normal.setXYZ(i, point.x, point.y, point.z);
  }
  fitted.computeBoundingBox(); fitted.computeBoundingSphere();
  return fitted;
}
