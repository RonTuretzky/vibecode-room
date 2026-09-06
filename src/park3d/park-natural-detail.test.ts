import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { buildGroveGeometry, GROVE_FORMS } from "./park-grove-geometry";
import { groundNoise, parkGroundColor } from "./park-ground";
import { parkTerrainAxis, terrainAxisCoordinate } from "./park-terrain-grid";
import { fitParkProjects } from "./park-cameras";
import { ParkReflectionSchedule } from "./park-reflection";
import { terrainSurfaceSampler } from "./park-world";

describe("natural park geometry", () => {
  test("three distinct finite crowns stay within the instancing budget", () => {
    const proportions: number[] = [];
    GROVE_FORMS.forEach((_, i) => {
      const { trunk, canopy } = buildGroveGeometry(i);
      const size = canopy.boundingBox!.getSize(new THREE.Vector3());
      proportions.push(size.x / size.y);
      expect(trunk.boundingBox!.min.y).toBeCloseTo(0, 0);
      expect(size.x).toBeGreaterThan(6);
      expect(size.y).toBeGreaterThan(3);
      let triangles = 0;
      for (const geometry of [trunk, canopy]) {
        triangles += geometry.index!.count / 3;
        for (const value of geometry.attributes.position!.array) expect(Number.isFinite(value)).toBe(true);
        const normals = geometry.attributes.normal!;
        for (let v = 0; v < normals.count; v++) {
          expect(Math.hypot(normals.getX(v), normals.getY(v), normals.getZ(v))).toBeCloseTo(1, 4);
        }
        geometry.dispose();
      }
      expect(triangles).toBeLessThan(1000);
    });
    expect(Math.max(...proportions) - Math.min(...proportions)).toBeGreaterThan(.4);
  });

  test("terrain detail is preserved around the Pond with substantially fewer vertices", () => {
    const axis = parkTerrainAxis(-1250, 1250, 0, 3);
    expect(axis[0]).toBe(-1250);
    expect(axis.at(-1)).toBe(1250);
    expect((axis.length - 1) ** 2).toBeLessThan((Math.ceil(2500 / 3) ** 2) * .3);
    for (let i = 0; i < axis.length - 1; i++) {
      const step = axis[i + 1]! - axis[i]!;
      expect(step).toBeGreaterThan(0);
      expect(step).toBeLessThanOrEqual(18);
      if (Math.abs(axis[i]!) < 180) expect(step).toBeCloseTo(3);
      expect(terrainAxisCoordinate(axis, axis[i]!)).toBeCloseTo(i);
    }
  });

  test("nonuniform terrain placement agrees with actual triangle ray intersections", () => {
    const axes = { x: [-12, -3, 0, 3, 17], z: [-11, -2, 1, 4, 19] };
    const cols = axes.x.length - 1, rows = axes.z.length - 1;
    const geometry = new THREE.PlaneGeometry(29, 30, cols, rows);
    const pos = geometry.attributes.position as THREE.BufferAttribute;
    for (let j = 0; j <= rows; j++) for (let i = 0; i <= cols; i++) {
      const x = axes.x[i]!, z = axes.z[j]!;
      pos.setXYZ(j * (cols + 1) + i, x, Math.sin(x * .6) + Math.cos(z * .7), z);
    }
    const sample = terrainSurfaceSampler(pos, cols, rows, -12, -11, 29, 30, () => -99, axes);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    const ray = new THREE.Raycaster();
    for (let x = -11.8; x < 17; x += 1.9) for (let z = -10.8; z < 19; z += 2.3) {
      ray.set(new THREE.Vector3(x, 100, z), new THREE.Vector3(0, -1, 0));
      expect(sample(x, z)).toBeCloseTo(ray.intersectObject(mesh)[0]!.point.y, 5);
    }
    expect(sample(-13, 0)).toBe(-99);
    expect(sample(0, 20)).toBe(-99);
    geometry.dispose(); mesh.material.dispose();
  });

  test("ground albedo is deterministic, continuous, and darker at the wet shore", () => {
    const dry = parkGroundColor(12, 17, 1, 0, 0, true, new THREE.Color());
    const wet = parkGroundColor(12, 17, 1, 0, 1, true, new THREE.Color());
    expect(dry.g).toBeGreaterThan(wet.g);
    for (const x of [-43.0001, -9.0001, -.0001, 8.9999, 42.9999]) {
      expect(Math.abs(groundNoise(x, 19, 9) - groundNoise(x + .0002, 19, 9))).toBeLessThan(.0001);
      const color = parkGroundColor(x, 19, .3, 8, .2, true, new THREE.Color());
      expect(color.toArray()).toEqual(parkGroundColor(x, 19, .3, 8, .2, true, new THREE.Color()).toArray());
      color.toArray().forEach(channel => { expect(channel).toBeGreaterThan(0); expect(channel).toBeLessThan(1); });
    }
  });
});


test("reflection reuse yields to camera movement, resizing, and periodic scene updates", () => {
  const schedule = new ParkReflectionSchedule(), camera = new THREE.PerspectiveCamera();
  camera.updateMatrixWorld();
  expect(schedule.shouldRender(0, camera)).toBe(true);
  expect(schedule.shouldRender(8, camera)).toBe(false);
  expect(schedule.shouldRender(32, camera)).toBe(false);
  expect(schedule.shouldRender(34, camera)).toBe(true);
  camera.position.x = .1; camera.updateMatrixWorld();
  expect(schedule.shouldRender(35, camera)).toBe(true);
  camera.fov = 60; camera.updateProjectionMatrix();
  expect(schedule.shouldRender(36, camera)).toBe(true);
  // Damping noise must not defeat the stationary budget.
  camera.position.x += .000001; camera.updateMatrixWorld();
  expect(schedule.shouldRender(37, camera)).toBe(false);
  expect(schedule.shouldRender(70, camera)).toBe(true);
});


test("Fit includes a large forest and its crowns in portrait and landscape", () => {
  for (const aspect of [.46, .95, 1.78]) for (const count of [2, 32, 64]) for (const yaw of [0, .8, 2]) {
    const halfWidth = (count - 1) * 13 / 2;
    const bounds = new THREE.Box3(new THREE.Vector3(-halfWidth, -2, -7), new THREE.Vector3(halfWidth, 3, 0));
    const fit = fitParkProjects(bounds, 54, aspect);
    const camera = new THREE.PerspectiveCamera(54, aspect, .1, 10000);
    camera.position.set(fit.targetX + Math.sin(yaw) * fit.radius, fit.height, fit.targetZ + Math.cos(yaw) * fit.radius);
    camera.lookAt(fit.targetX, fit.lookY, fit.targetZ); camera.updateMatrixWorld();
    for (const x of [-halfWidth - 5, halfWidth + 5]) for (const y of [-2, 13]) for (const z of [-12, 5]) {
      const projected = new THREE.Vector3(x, y, z).project(camera);
      expect(Math.abs(projected.x)).toBeLessThan(1);
      expect(Math.abs(projected.y)).toBeLessThan(1);
      expect(projected.z).toBeGreaterThan(0);
      expect(projected.z).toBeLessThan(1);
    }
    if (count >= 32) expect(fit.radius).toBeGreaterThan(40);
  }
});
