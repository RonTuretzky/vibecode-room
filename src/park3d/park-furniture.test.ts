import { expect, test } from 'bun:test';
import * as THREE from 'three';
import { createParkFurniture } from './park-furniture';
import { BENCH_FOOTPRINT, parkFurnitureGeometry } from './park-furniture-geometry';

test('detailed furniture retains human scale, clear normals and bounded shared geometry', () => {
  const models = parkFurnitureGeometry();
  for (const [name, geometry] of Object.entries(models)) {
    geometry.computeBoundingBox();
    const bounds = geometry.boundingBox!;
    expect(Array.from(geometry.getAttribute('normal').array).every(Number.isFinite)).toBe(true);
    const triangles = (geometry.index?.count ?? geometry.getAttribute('position').count) / 3;
    expect(triangles).toBeLessThan(name === 'lampMetal' ? 3000 : 4000);
    if (name.startsWith('bench')) {
      expect(bounds.min.x).toBeGreaterThan(-BENCH_FOOTPRINT.halfWidth);
      expect(bounds.max.x).toBeLessThan(BENCH_FOOTPRINT.halfWidth);
      expect(bounds.min.z).toBeGreaterThan(BENCH_FOOTPRINT.back);
      expect(bounds.max.z).toBeLessThan(BENCH_FOOTPRINT.front);
      expect(bounds.min.y).toBeGreaterThan(-.012);
      expect(bounds.max.y).toBeLessThan(.88);
    }
  }
  const width = models.benchWood.boundingBox!.max.x - models.benchWood.boundingBox!.min.x;
  expect(width).toBeCloseTo(1.8288, 4);
  expect(models.lampMetal.boundingBox!.max.y).toBeCloseTo(4.558, 3);
  Object.values(models).forEach(g => g.dispose());
});

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
    expect(p.getY(i)).toBeGreaterThanOrEqual(9.96499);
    expect(p.getY(i)).toBeLessThanOrEqual(10.01001);
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
    if (Math.abs(gap + .025) < .00001) {
      buried++; minBottom = Math.min(minBottom, p.getY(i)); maxBottom = Math.max(maxBottom, p.getY(i));
    } else {
      expect(p.getY(i)).toBeLessThanOrEqual(fitted.elements[13]! + .02501);
      expect(gap).toBeGreaterThan(-.02501);
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
  expect(geometryDisposals).toBe(4); expect(instanceDisposals).toBe(3); expect(materialDisposals).toBe(3);
});
