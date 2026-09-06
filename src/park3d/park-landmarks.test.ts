import { expect, test } from "bun:test";
import * as THREE from "three";
import { buildGapstow } from "./park-landmarks";

test("Gapstow has a genuinely open arch, solid abutments and a walkable deck", () => {
  const bridge = buildGapstow();
  bridge.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(new THREE.Vector3(0, 1, -10), new THREE.Vector3(0, 0, 1));
  expect(ray.intersectObject(bridge, true)).toHaveLength(0);
  ray.ray.origin.x = 9.5;
  expect(ray.intersectObject(bridge, true).length).toBeGreaterThan(0);
  ray.set(new THREE.Vector3(0, 10, 0), new THREE.Vector3(0, -1, 0));
  const deck = ray.intersectObject(bridge, true)[0]!;
  expect(deck.point.y).toBeGreaterThan(3.9);
  expect(deck.point.y).toBeLessThan(4.2);
  bridge.traverse(node => {
    if (node instanceof THREE.Mesh) {
      const positions = node.geometry.getAttribute("position");
      for (const value of positions.array) expect(Number.isFinite(value)).toBe(true);
      node.geometry.dispose(); (node.material as THREE.Material).dispose();
    }
  });
});
