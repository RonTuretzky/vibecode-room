import { expect, test } from 'bun:test';
import * as THREE from 'three';
import { projectFocusPose, updateTreeTipDetail } from './tree-tip-detail';

test('subpixel tip chrome disappears while the branch pick surface remains available', () => {
  const label = new THREE.Sprite(), glow = new THREE.Sprite(), bud = new THREE.Mesh();
  label.scale.y = 1;
  const group = new THREE.Group(), hit = new THREE.Mesh(new THREE.SphereGeometry(.8));
  group.add(label, glow, bud, hit);
  const detail = [{ label, glow, bud }];
  expect(updateTreeTipDetail(detail, 3, 1 / 60, true)).toBe(0);
  expect(label.visible || glow.visible || bud.visible).toBe(false);
  expect(group.visible && hit.visible).toBe(true);
  updateTreeTipDetail(detail, 36, 1 / 60, false);
  expect(label.material.opacity).toBeGreaterThan(0);
  expect(label.material.opacity).toBeLessThan(.5);
  for (let i = 0; i < 30; i++) updateTreeTipDetail(detail, 36, 1 / 60, false);
  expect(label.material.opacity).toBeGreaterThan(.99);
  expect(bud.visible).toBe(true);
  // Small camera movements through the readability threshold change opacity
  // continuously, and reduced motion applies the final value immediately.
  updateTreeTipDetail(detail, 24, 1 / 60, true);
  expect(label.material.opacity).toBeCloseTo(.5);
  updateTreeTipDetail(detail, 0, 1 / 60, true);
  expect(label.visible || glow.visible || bud.visible).toBe(false);
  label.material.dispose(); glow.material.dispose(); hit.geometry.dispose();
});

test('project focus fits the whole body at low and high terrain elevations in both screen orientations', () => {
  for (const aspect of [1280 / 900, 390 / 844]) for (const y of [-12, 24]) for (const yaw of [0, 1.2, 3.14]) {
    const bounds = new THREE.Box3(new THREE.Vector3(65, y, -105), new THREE.Vector3(81, y + 11, -92));
    const pose = projectFocusPose(bounds, 52, aspect), camera = new THREE.PerspectiveCamera(52, aspect, .1, 1500);
    camera.position.set(pose.targetX + Math.sin(yaw) * pose.radius, pose.height, pose.targetZ + Math.cos(yaw) * pose.radius);
    camera.lookAt(pose.targetX, pose.lookY, pose.targetZ); camera.updateMatrixWorld();
    expect(pose.lookY).toBe(y + 5.5);
    expect(pose.height - y).toBeLessThan(25);
    for (let i = 0; i < 8; i++) {
      const p = new THREE.Vector3(i & 1 ? bounds.max.x : bounds.min.x, i & 2 ? bounds.max.y : bounds.min.y,
        i & 4 ? bounds.max.z : bounds.min.z).project(camera);
      expect(Math.abs(p.x)).toBeLessThan(1); expect(Math.abs(p.y)).toBeLessThan(1);
      expect(p.z).toBeGreaterThan(-1); expect(p.z).toBeLessThan(1);
    }
  }
});
