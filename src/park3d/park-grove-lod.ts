import * as THREE from 'three';

export const GROVE_DETAIL_LIMIT = 16;
export const GROVE_DETAIL_ENTER = 75;
export const GROVE_DETAIL_EXIT = 90;

/** Prefer nearby visible crowns. Retaining an incumbent through a wider
 * distance band keeps a walk near the threshold from repeatedly swapping it. */
export function selectGroveDetail(bounds: readonly THREE.Sphere[], eye: THREE.Vector3,
  frustum: THREE.Frustum, previous: ReadonlySet<number>): Set<number> {
  const candidates: { index: number; score: number }[] = [];
  bounds.forEach((sphere, index) => {
    const retained = previous.has(index), distance = eye.distanceTo(sphere.center);
    if (distance > (retained ? GROVE_DETAIL_EXIT : GROVE_DETAIL_ENTER) || !frustum.intersectsSphere(sphere)) return;
    candidates.push({ index, score: distance * (retained ? .8 : 1) });
  });
  candidates.sort((a, b) => a.score - b.score || a.index - b.index);
  return new Set(candidates.slice(0, GROVE_DETAIL_LIMIT).map(candidate => candidate.index));
}

/** Hide a fitted base inside a merged batch without giving every distant
 * tree its own draw. Degenerate triangles have no area in any render pass. */
export function createGroveBaseRange(index: THREE.BufferAttribute, offset: number, count: number) {
  const original = index.array.slice(offset, offset + count);
  let visible = true;
  index.setUsage(THREE.DynamicDrawUsage);
  return { setVisible(next: boolean) {
    if (visible === next) return;
    visible = next;
    for (let i = 0; i < count; i++) index.setX(offset + i, next ? original[i]! : original[0]!);
    index.addUpdateRange(offset, count); index.needsUpdate = true;
  } };
}
