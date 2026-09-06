import { expect, test } from 'bun:test';
import * as THREE from 'three';
import { CAMERA_PITCH_LIMIT, clampCameraPitch, clampOrbitTilt, orbitCameraPitch } from './camera-pitch';

test('zero tilt preserves the original look-at direction across orbit poses', () => {
  for (const [height, lookY, radius] of [[5.2, 3.3, 20], [90, 8, 160], [1.4, 8, 12], [-3, 2, 30]]) {
    for (const yaw of [0, .8, -2.1]) {
      const camera = new THREE.PerspectiveCamera();
      camera.position.set(Math.sin(yaw!) * radius!, height!, Math.cos(yaw!) * radius!);
      camera.lookAt(0, lookY!, 0);
      const expected = camera.getWorldDirection(new THREE.Vector3());
      camera.rotation.set(orbitCameraPitch(height!, lookY!, radius!), yaw!, 0, 'YXZ');
      expect(camera.getWorldDirection(new THREE.Vector3()).distanceTo(expected)).toBeLessThan(1e-10);
    }
  }
});

test('tilt reaches either limit and reverses immediately without accumulating hidden overshoot', () => {
  let offset = clampOrbitTilt(3, 8, 12, 100);
  expect(orbitCameraPitch(3, 8, 12, offset)).toBeCloseTo(CAMERA_PITCH_LIMIT);
  offset = clampOrbitTilt(3, 8, 12, offset - .1);
  expect(orbitCameraPitch(3, 8, 12, offset)).toBeCloseTo(CAMERA_PITCH_LIMIT - .1);
  offset = clampOrbitTilt(3, 8, 12, -100);
  expect(orbitCameraPitch(3, 8, 12, offset)).toBeCloseTo(-CAMERA_PITCH_LIMIT);
  expect(clampCameraPitch(NaN)).toBe(0);
  expect(clampCameraPitch(Infinity)).toBe(0);
});
