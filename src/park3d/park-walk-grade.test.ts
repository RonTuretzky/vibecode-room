import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { createWalkGrade } from './park-walk-grade';
import { buildPaths } from './park-paths';
import { walkSurface } from './park-walk-materials';

describe('walk corridors', () => {
  test('a bank is flattened across the walk and feathers into the original terrain', () => {
    const groundAt = (x: number, z: number) => x * .1 + z * 1.2;
    const grade = createWalkGrade([{ width: 3, pts: [-20, 0, 20, 0] }], {
      groundAt, referenceAt: groundAt, waterAt: () => 0, waterLevelAt: () => null,
    });
    expect(grade.heightAt(0, -1.5)).toBeCloseTo(grade.heightAt(0, 1.5), 6);
    expect(grade.heightAt(0, 1.5)).toBeCloseTo(0, 6);
    expect(grade.heightAt(0, 6)).toBe(groundAt(0, 6));
    expect(grade.heightAt(0, 4)).toBeGreaterThan(0);
    expect(grade.heightAt(0, 4)).toBeLessThan(groundAt(0, 4));
    for (let x = -10; x < 10; x += .1) {
      expect(Math.abs(grade.heightAt(x + .01, 0) - grade.heightAt(x, 0))).toBeLessThan(.005);
    }
  });

  test('wet shore and clear bridge span retain their original bed', () => {
    const grade = createWalkGrade([{ width: 3, pts: [-20, 0, 20, 0] }], {
      groundAt: () => -2, referenceAt: () => -1, waterAt: (_, z) => z < -1 ? 1 : 0,
      waterLevelAt: () => 0, bridgeAt: x => Math.abs(x) < 3 ? 4 : null,
    });
    expect(grade.heightAt(8, 0)).toBeCloseTo(.18);
    expect(grade.heightAt(8, -1.5)).toBe(-2);
    expect(grade.heightAt(0, 0)).toBe(-2);
  });

  test('intersecting ways remain continuous through spatial bucket boundaries', () => {
    const groundAt = (x: number, z: number) => Math.sin(x / 7) + Math.cos(z / 6);
    const grade = createWalkGrade([
      { width: 3, pts: [0, 16, 32, 16] }, { width: 3, pts: [16, 0, 16, 32] },
    ], { groundAt, referenceAt: groundAt, waterAt: () => 0, waterLevelAt: () => null });
    expect(Math.abs(grade.heightAt(15.9999, 16) - grade.heightAt(16.0001, 16))).toBeLessThan(.001);
    expect(Math.abs(grade.heightAt(16, 15.9999) - grade.heightAt(16, 16.0001))).toBeLessThan(.001);
  });
});

function dispose(mesh: THREE.Mesh) {
  mesh.geometry.dispose();
  for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) material.dispose();
}

describe('walk surfaces', () => {
  test('crossings have one paving surface without cutting holes beyond flat route ends', () => {
    const mesh = buildPaths([
      { width: 3, pts: [-8, 0, 8, 0], surface: 'asphalt' },
      { width: 2, pts: [0, -8, 0, 8], surface: 'concrete' },
      { width: 4, pts: [4, 3, 4, 6], surface: 'concrete' },
    ], () => 0, () => 0)!;
    const ray = new THREE.Raycaster(new THREE.Vector3(.13, 10, .07), new THREE.Vector3(0, -1, 0));
    expect(ray.intersectObject(mesh)).toHaveLength(1);
    for (let x = -1.4; x < 1.5; x += .2) for (let z = -1.4; z < 1.5; z += .2) {
      ray.set(new THREE.Vector3(x, 10, z), new THREE.Vector3(0, -1, 0));
      expect(ray.intersectObject(mesh).length).toBeGreaterThan(0);
    }
    ray.set(new THREE.Vector3(4.13, 10, 1.4), new THREE.Vector3(0, -1, 0));
    expect(ray.intersectObject(mesh).length).toBeGreaterThan(0);
    dispose(mesh);
  });

  test('crossing walks remove edging through the junction without opening corner holes', () => {
    const mesh = buildPaths([{ width: 2, pts: [-8, 16, 8, 16] }, { width: 2, pts: [0, 8, 0, 24] }], () => 0, () => 0)!;
    const ray = new THREE.Raycaster(new THREE.Vector3(0, 10, 16.85), new THREE.Vector3(0, -1, 0));
    const crossing = ray.intersectObject(mesh)[0]!;
    expect(crossing.point.y).toBeCloseTo(.07);
    for (const dx of [-.9, 0, .9]) for (const dz of [-.9, 0, .9]) {
      ray.set(new THREE.Vector3(dx, 10, 16 + dz), new THREE.Vector3(0, -1, 0));
      expect(ray.intersectObject(mesh).length).toBeGreaterThan(0);
    }
    ray.set(new THREE.Vector3(5, 10, 16.85), new THREE.Vector3(0, -1, 0));
    const border = ray.intersectObject(mesh)[0]!;
    expect(border.point.y).toBeCloseTo(.07);
    expect(border.face!.materialIndex).not.toBe(crossing.face!.materialIndex);
    dispose(mesh);
  });

  test('the stone border meets asphalt without a vertical slit on a slope', () => {
    const ground = (x: number, z: number) => x * .2 + z * .1;
    const mesh = buildPaths([{ width: 2, pts: [-5, 0, 5, 0], surface: 'asphalt' }], ground, () => 0)!;
    const ray = new THREE.Raycaster();
    for (const side of [-1, 1]) for (const distance of [.679, .681]) {
      const z = side * distance;
      ray.set(new THREE.Vector3(.13, 10, z), new THREE.Vector3(0, -1, 0));
      expect(ray.intersectObject(mesh)[0]!.point.y - ground(.13, z)).toBeCloseTo(.07, 5);
    }
    dispose(mesh);
  });

  test('mapped woodland surfaces have natural margins and share material batches', () => {
    const lines = ['woodchips', 'fine_gravel', 'paving_stones', 'asphalt', 'wood'].map((surface, i) => ({
      width: 2, pts: [0, i * 5, 8, i * 5], surface,
    }));
    expect(lines.map(line => walkSurface(line).texture)).toEqual(['mulch', 'earth', 'pavers', 'aggregate', 'boards']);
    expect(walkSurface(lines[0]!).hardEdge).toBe(false);
    const mesh = buildPaths([...lines, ...lines], () => 0, () => 0)!;
    expect(mesh.geometry.groups).toHaveLength(6); // Five surfaces plus their shared stone edging.
    const p = mesh.geometry.getAttribute('position');
    for (let i = 0; i < p.count; i++) if (p.getZ(i) < 2) expect(p.getY(i)).toBeCloseTo(.07);
    dispose(mesh);
  });

  test('stone courses keep continuous metre coordinates through terrain refinement and shore clipping', () => {
    const mesh = buildPaths([{ width: 2, pts: [-10, 0, 10, 0], surface: 'asphalt' }],
      (x, z) => Math.sin(x * .7) + z * .2, x => Math.abs(x) < 2 ? 1 : 0)!;
    const p = mesh.geometry.getAttribute('position'), coord = mesh.geometry.getAttribute('parkWalkCoord');
    expect(coord.count).toBe(p.count);
    for (let i = 0; i < p.count; i++) {
      expect(coord.getX(i)).toBeCloseTo(p.getX(i) + 10, 4);
      expect(coord.getY(i)).toBeGreaterThanOrEqual(0);
      expect(coord.getY(i)).toBeLessThanOrEqual(1);
    }
    dispose(mesh);
  });

  test('adaptive triangles follow a terrain ridge between their original corners', () => {
    const ground = (x: number, z: number) => 2 - Math.abs(x * .6 + z * .8);
    const mesh = buildPaths([{ width: 4, pts: [-10, 0, 10, 0] }], ground, () => 0)!;
    const p = mesh.geometry.getAttribute('position'), ix = mesh.geometry.getIndex()!;
    for (let i = 0; i < ix.count; i += 3) {
      const ids = [ix.getX(i), ix.getX(i + 1), ix.getX(i + 2)];
      const mean = (axis: number) => ids.reduce((sum, k) => sum + p.getComponent(k, axis), 0) / 3;
      expect(mean(1) - ground(mean(0), mean(2))).toBeGreaterThan(.015);
    }
    expect(p.count).toBeLessThan(ix.count / 2);
    dispose(mesh);
  });

  test('steep banks and nearby water no longer erase a valid narrow shore walk', () => {
    const mesh = buildPaths([{ width: 2, pts: [-10, 0, 10, 0] }], (x, z) => x * .6 + z,
      (_, z) => z > 1.1 ? 1 : 0)!;
    expect(mesh).not.toBeNull();
    const ray = new THREE.Raycaster();
    for (let x = -9.5; x < 10; x++) {
      ray.set(new THREE.Vector3(x, 30, 0), new THREE.Vector3(0, -1, 0));
      expect(ray.intersectObject(mesh).length).toBeGreaterThan(0);
    }
    const n = mesh.geometry.getAttribute('normal');
    expect(n.getY(0)).toBeGreaterThan(.5);
    expect(n.getY(0)).toBeLessThan(.9);
    dispose(mesh);
  });

  test('a diagonal shoreline clips only the wet part of the actual path', () => {
    const mesh = buildPaths([{ width: 4, pts: [-8, 0, 8, 0] }], () => 0, (x, z) => Math.max(0, Math.min(1, (z - x) / 2 + .5)))!;
    const p = mesh.geometry.getAttribute('position');
    for (let i = 0; i < p.count; i++) expect(p.getZ(i) - p.getX(i)).toBeLessThan(.0002);
    const ray = new THREE.Raycaster(new THREE.Vector3(1, 10, 0), new THREE.Vector3(0, -1, 0));
    expect(ray.intersectObject(mesh).length).toBeGreaterThan(0);
    ray.set(new THREE.Vector3(-1, 10, 0), new THREE.Vector3(0, -1, 0));
    expect(ray.intersectObject(mesh)).toHaveLength(0);
    dispose(mesh);
  });

  for (const direction of [1, -1]) test(`mapped stairs have horizontal treads and outward risers (${direction})`, () => {
    const mesh = buildPaths([{ width: 2, pts: [0, 0, 6, 0], kind: 'steps' }], x => x * .5 * direction, () => 0)!;
    const p = mesh.geometry.getAttribute('position'), n = mesh.geometry.getAttribute('normal'), ix = mesh.geometry.getIndex()!;
    let treads = 0, risers = 0;
    for (let i = 0; i < ix.count; i += 3) {
      const ids = [ix.getX(i), ix.getX(i + 1), ix.getX(i + 2)];
      expect(ids.every(k => Number.isFinite(p.getY(k)))).toBe(true);
      if (n.getY(ids[0]!) > .99) {
        const heights = ids.map(k => p.getY(k));
        expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(.00001); treads++;
      } else if (Math.abs(n.getX(ids[0]!)) > .99) {
        const x = p.getX(ids[0]!);
        if (x > .01 && x < 5.99) {
          expect(n.getX(ids[0]!)).toBeCloseTo(-direction);
          const heights = ids.map(k => p.getY(k));
          expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(.161); risers++;
        }
      }
    }
    expect(treads).toBeGreaterThan(20); expect(risers).toBeGreaterThan(20);
    dispose(mesh);
  });
});
