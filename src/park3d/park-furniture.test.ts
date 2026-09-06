import { expect, test } from 'bun:test';
import * as THREE from 'three';
import { createParkFurniture } from './park-furniture';

test('level benches and lamp bases meet flat ground without the old placement lift', () => {
  const placement = new THREE.Matrix4().makeTranslation(2, 10.12, -3);
  const original = placement.clone();
  const furniture = createParkFurniture([placement], [placement], () => 10);
  const matrix = new THREE.Matrix4();
  for (const child of furniture.group.children) {
    if (!(child instanceof THREE.InstancedMesh)) continue;
    child.getMatrixAt(0, matrix);
    expect(matrix.elements[13]).toBeCloseTo(9.985, 5);
  }
  expect(placement.equals(original)).toBe(true);
  const footings = furniture.group.getObjectByName('park-furniture-footings') as THREE.Mesh;
  const p = footings.geometry.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    expect([9.965, 10.01].some(y => Math.abs(y - p.getY(i)) < .00001)).toBe(true);
  }
  furniture.dispose();
});

test('rotated bench feet extend independently into sloping terrain while the seat stays level', () => {
  const groundAt = (x: number, z: number) => -3 + x * .18 + z * .08;
  const matrix = new THREE.Matrix4().makeRotationY(.63).setPosition(7, 0, -4);
  const furniture = createParkFurniture([], [matrix], groundAt);
  const fitted = new THREE.Matrix4();
  (furniture.group.children[0] as THREE.InstancedMesh).getMatrixAt(0, fitted);
  expect(fitted.elements[1]).toBe(0); expect(fitted.elements[9]).toBe(0);
  const p = (furniture.group.getObjectByName('park-furniture-footings') as THREE.Mesh).geometry.getAttribute('position');
  let buried = 0, minBottom = Infinity, maxBottom = -Infinity;
  for (let i = 0; i < p.count; i++) {
    const gap = p.getY(i) - groundAt(p.getX(i), p.getZ(i));
    if (Math.abs(gap + .035) < .00001) {
      buried++; minBottom = Math.min(minBottom, p.getY(i)); maxBottom = Math.max(maxBottom, p.getY(i));
    } else {
      expect(p.getY(i)).toBeCloseTo(fitted.elements[13]! + .025, 5);
      expect(gap).toBeGreaterThan(.009);
    }
  }
  expect(buried).toBe(48);
  expect(maxBottom - minBottom).toBeGreaterThan(.15);
  let geometryDisposals = 0, instanceDisposals = 0, materialDisposals = 0;
  const materials = new Set<THREE.Material>();
  for (const child of furniture.group.children) {
    if (!(child instanceof THREE.Mesh)) continue;
    child.geometry.addEventListener('dispose', () => geometryDisposals++);
    if (child instanceof THREE.InstancedMesh) child.addEventListener('dispose', () => instanceDisposals++);
    materials.add(child.material as THREE.Material);
  }
  materials.forEach(material => material.addEventListener('dispose', () => materialDisposals++));
  furniture.dispose();
  expect(geometryDisposals).toBe(3); expect(instanceDisposals).toBe(2); expect(materialDisposals).toBe(2);
});
