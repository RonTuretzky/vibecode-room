import { expect, test } from 'bun:test';
import * as THREE from 'three';
import { buildGroveGeometry, GROVE_FORMS } from './park-grove-geometry';
import { fitTreeBase, splitTreeBase, TREE_BASE_BLEND_HEIGHT } from './park-tree-bases';

test('splitting root bases preserves all triangles in compact bounded geometry', () => {
  for (const detail of [false, true]) GROVE_FORMS.forEach((_, form) => {
    const { trunk, canopy } = buildGroveGeometry(form, detail);
    const original = trunk.getAttribute('position').array.slice();
    const split = splitTreeBase(trunk);
    expect(split.base.index!.count + split.trunk.index!.count).toBe(trunk.index!.count);
    expect(split.base.index!.count / 3).toBeLessThan(detail ? 750 : 130);
    expect(split.trunk.boundingBox!.min.y).toBeGreaterThanOrEqual(TREE_BASE_BLEND_HEIGHT);
    for (const geometry of [split.base, split.trunk]) {
      const count = geometry.getAttribute('position').count;
      expect(count).toBe(new Set(geometry.index!.array).size);
      for (const index of geometry.index!.array) expect(index).toBeLessThan(count);
    }
    expect(trunk.getAttribute('position').array).toEqual(original);
    [trunk, canopy, split.base, split.trunk].forEach(geometry => geometry.dispose());
  });
});

test('rotated and scaled roots follow slopes and curved terrain while upper joins stay fixed', () => {
  const wood = buildGroveGeometry(0, true), split = splitTreeBase(wood.trunk);
  const original = split.base.getAttribute('position').array.slice();
  for (const direction of [-1, 1]) for (const rotation of [-.8, .5]) {
    const ground = (x: number, z: number) => 7 + direction * (.45 * (x - 3) + .3 * (z + 8)) + .2 * Math.sin((x - 3) * 1.4) * Math.cos((z + 8) * .7);
    const placement = new THREE.Matrix4().compose(new THREE.Vector3(3, 7, -8),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotation), new THREE.Vector3(1.8, 1.3, 1.6));
    const fitted = fitTreeBase(split.base, placement, ground);
    const local = split.base.getAttribute('position'), position = fitted.getAttribute('position'), normal = fitted.getAttribute('normal');
    const unmodified = split.base.clone().applyMatrix4(placement), point = new THREE.Vector3();
    let contact = 0, unchanged = 0;
    for (let i = 0; i < position.count; i++) {
      expect(Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i))).toBeCloseTo(1, 4);
      point.fromBufferAttribute(position, i);
      if (local.getY(i) <= .25) {
        expect(point.y - ground(point.x, point.z)).toBeCloseTo(local.getY(i) * 1.3, 4);
        if (local.getY(i) < 0) expect(point.y).toBeLessThan(ground(point.x, point.z));
        contact++;
      }
      if (local.getY(i) >= TREE_BASE_BLEND_HEIGHT) {
        expect(point.distanceTo(new THREE.Vector3().fromBufferAttribute(unmodified.getAttribute('position'), i))).toBeLessThan(.00001);
        for (let c = 0; c < 3; c++) expect(normal.getComponent(i, c)).toBeCloseTo(unmodified.getAttribute('normal').getComponent(i, c), 5);
        unchanged++;
      }
    }
    expect(contact).toBeGreaterThan(50); expect(unchanged).toBeGreaterThan(5);
    expect(split.base.getAttribute('position').array).toEqual(original);
    fitted.dispose(); unmodified.dispose();
  }
  [wood.trunk, wood.canopy, split.base, split.trunk].forEach(geometry => geometry.dispose());
});
