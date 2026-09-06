import { expect, test } from 'bun:test';
import * as THREE from 'three';
import { arsenalApproach, buildArsenal, createArsenalGrade, ARSENAL_HEIGHT } from './park-arsenal';
import { PARK_SITES, createParkPlantingMask, inSite } from './park-sites';
import { AXIS, PERP } from './park-frame';

const site = PARK_SITES.arsenal;
const dispose = (root: THREE.Object3D) => root.traverse(node => {
  if (node instanceof THREE.Mesh) { node.geometry.dispose(); (node.material as THREE.Material).dispose(); }
});

test('the Arsenal has mapped height, roof coverage, outward facades and a bounded render cost', () => {
  const group = buildArsenal(12); group.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(group);
  expect(bounds.max.y).toBeCloseTo(12 + ARSENAL_HEIGHT, 4);
  const roof = group.getObjectByName('arsenal-roofs')!;
  const ray = new THREE.Raycaster(); let covered = 0;
  for (let x = site.x - 30; x <= site.x + 30; x += 3) for (let z = site.z - 35; z <= site.z + 35; z += 3) {
    if (!inSite(x, z, site.ring)) continue;
    ray.set(new THREE.Vector3(x, 100, z), new THREE.Vector3(0, -1, 0));
    expect(ray.intersectObject(roof).length).toBeGreaterThan(0); covered++;
  }
  expect(covered).toBeGreaterThan(70);
  const brick = group.getObjectByName('arsenal-brick')!;
  for (const sign of [-1, 1]) {
    ray.set(new THREE.Vector3(site.x + PERP.x * 30 * sign, 16, site.z + PERP.z * 30 * sign), PERP.clone().multiplyScalar(-sign));
    expect(ray.intersectObject(brick).length).toBeGreaterThan(0);
  }
  let triangles = 0;
  expect(group.children.length).toBeLessThanOrEqual(5);
  group.traverse(node => {
    if (!(node instanceof THREE.Mesh)) return;
    expect(node.castShadow && node.receiveShadow).toBe(true);
    const pos = node.geometry.getAttribute('position'); triangles += pos.count / 3;
    expect(Array.from(pos.array).every(Number.isFinite)).toBe(true);
  });
  expect(triangles).toBeLessThan(18000);
  dispose(group);
});

test('the foundation levels its footprint and releases the surrounding slope; plants stay outside', () => {
  const ground = (x: number, z: number) => 10 + (x - site.x) * .07 + (z - site.z) * .04;
  const grade = createArsenalGrade(ground), plants = createParkPlantingMask([]);
  for (const p of site.ring) {
    expect(grade.heightAt(p.x, p.z, ground(p.x, p.z))).toBeCloseTo(grade.level);
    expect(plants(p.x, p.z)).toBe(false);
  }
  expect(plants(site.x, site.z)).toBe(false);
  expect(grade.heightAt(site.x + 100, site.z, 99)).toBe(99);
  expect(grade.heightAt(site.x + PERP.x * 13.2, site.z + PERP.z * 13.2, 99)).toBe(grade.level);
});

test('the entrance apron connects only to a nearby walk in front of the steps', () => {
  const pathAt = (across: number) => ({ width: 3, pts: [-8, 8].flatMap(along => [site.x + PERP.x * across + AXIS.x * along, site.z + PERP.z * across + AXIS.z * along]) });
  const walk = arsenalApproach([pathAt(10), pathAt(17), pathAt(40)])!;
  expect(walk).not.toBeNull();
  expect(walk.pts[2]).toBeCloseTo(site.x + PERP.x * 17);
  expect(walk.pts[3]).toBeCloseTo(site.z + PERP.z * 17);
  expect(arsenalApproach([pathAt(10), pathAt(40)])).toBeNull();
});
