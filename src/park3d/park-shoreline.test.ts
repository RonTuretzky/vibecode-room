import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { Water } from "three/addons/objects/Water.js";
import { buildWater } from "./park-world";
import { refinePondMaterial, waterInteriorAt } from "./park-pond-material";
import { createParkShoreline, shorePlantGeometry, shorePlantPlacements, type ShoreSource } from "./park-shoreline";

// A smooth, translated circular shoreline with a one-metre transition.
const waterAt = (x: number, z: number) => THREE.MathUtils.clamp(18.5 - Math.hypot(x - 13, z + 7), 0, 1);

describe("pond edge shading and terrain", () => {
  test("optical coverage fades at the actual contour and stays independent of crop coordinates", () => {
    expect(waterInteriorAt(waterAt, 13, -7)).toBe(1);
    expect(waterInteriorAt(waterAt, 31, -7)).toBe(0);
    expect(waterInteriorAt(waterAt, 34, -7)).toBe(0);
    const originWater = (x: number, z: number) => waterAt(x + 13, z - 7);
    let previous = 1;
    for (let radius = 0; radius <= 20; radius += .1) {
      const value = waterInteriorAt(waterAt, 13 + radius, -7);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(previous + 1e-9);
      expect(value).toBeCloseTo(waterInteriorAt(originWater, radius, 0), 8);
      previous = value;
    }
    expect(waterInteriorAt(waterAt, 30.999, -7)).toBeLessThan(.002);
  });

  test("hero water carries coverage at every clipped vertex; dry banks meet its surface", () => {
    const water = buildWater(waterAt, () => 12, 40, 40, 2, { x: 13, z: -7 });
    const { geometry, level } = water.hero!;
    const positions = geometry.getAttribute("position"), coverage = geometry.getAttribute("waterInterior");
    expect(coverage.count).toBe(positions.count);
    for (let i = 0; i < positions.count; i++) {
      expect(coverage.getX(i)).toBeCloseTo(waterInteriorAt(waterAt, positions.getX(i), -positions.getY(i)), 4);
    }
    expect(water.bankHeightAt(13, -7)).toBeLessThan(level - 1);
    for (let angle = 0; angle < Math.PI * 2; angle += .17) {
      const atRadius = (r: number) => water.bankHeightAt(13 + Math.cos(angle) * r, -7 + Math.sin(angle) * r)!;
      // The previous bank profile sat ~1 m below water even on dry land.
      expect(atRadius(18.01)).toBeGreaterThanOrEqual(level - .011);
      expect(atRadius(23)).toBeGreaterThan(atRadius(18.01));
      expect(Math.abs(atRadius(17.999) - atRadius(18.001))).toBeLessThan(.02);
    }
    geometry.dispose();
  });

  test("pond tuning works with the installed Three Water shader and is idempotent", () => {
    const geometry = new THREE.PlaneGeometry(2, 2), texture = new THREE.Texture();
    const water = new Water(geometry, { waterNormals: texture, textureWidth: 8, textureHeight: 8 });
    const material = water.material as THREE.ShaderMaterial;
    expect(() => refinePondMaterial(material)).not.toThrow();
    expect(material.uniforms.mirrorSampler).toBeDefined();
    expect(material.uniforms.shoreColor!.value).toBeInstanceOf(THREE.Color);
    expect(material.lights).toBe(true);
    const vertex = material.vertexShader, fragment = material.fragmentShader;
    refinePondMaterial(material);
    expect(material.vertexShader).toBe(vertex);
    expect(material.fragmentShader).toBe(fragment);
    geometry.dispose(); texture.dispose(); material.dispose();
  });
});

describe("shoreline vegetation", () => {
  const source: ShoreSource = { waterAt, waterLevel: 12,
    groundAt: (x, z) => 12 + Math.max(0, Math.hypot(x - 13, z + 7) - 18) * .2,
    // A three-metre path splits both shores.
    canPlant: (x, _z, clearance = 0) => Math.abs(x - 13) > 1.5 + clearance,
  };

  test("patches stay rooted near water, respect path clearances, and reproduce deterministically", () => {
    const center = { x: 13, z: -7 }, plants = shorePlantPlacements(source, center, 27);
    expect(plants.length).toBeGreaterThan(5);
    expect(plants).toEqual(shorePlantPlacements(source, center, 27));
    for (const p of plants) {
      expect(source.canPlant(p.x, p.z, 1)).toBe(true);
      expect(source.waterAt(p.x, p.z)).toBeLessThanOrEqual(.45);
      expect(Math.hypot(p.x - 13, p.z + 7)).toBeLessThan(21);
      expect(p.y).toBeCloseTo(source.groundAt(p.x, p.z), 8);
      expect(p.y).toBeGreaterThanOrEqual(11.92);
      expect(p.y).toBeLessThanOrEqual(13.7);
      for (const [dx, dz] of [[.35, 0], [-.35, 0], [0, .35], [0, -.35]]) {
        expect(Math.abs(source.groundAt(p.x + dx!, p.z + dz!) - source.groundAt(p.x, p.z))).toBeLessThanOrEqual(.3);
      }
    }
    expect(shorePlantPlacements({ ...source, canPlant: () => false }, center, 27)).toEqual([]);
    expect(shorePlantPlacements({ ...source, groundAt: () => 20 }, center, 27)).toEqual([]);
    expect(shorePlantPlacements({ ...source, groundAt: () => 10 }, center, 27)).toEqual([]);
  });

  test("solid plant silhouettes are finite, correctly rooted and cheap enough for repeated clumps", () => {
    for (const kind of [0, 1] as const) {
      const geometry = shorePlantGeometry(kind);
      expect(geometry.index!.count / 3).toBeLessThan(300);
      expect(geometry.boundingBox!.min.y).toBeCloseTo(0, 5);
      expect(geometry.boundingBox!.max.y).toBeGreaterThan(kind ? 1.2 : .5);
      expect(geometry.boundingBox!.max.y).toBeLessThan(kind ? 1.9 : .9);
      for (const name of ["position", "normal", "color"]) {
        const attribute = geometry.getAttribute(name);
        expect(attribute.count).toBe(geometry.getAttribute("position").count);
        expect(Array.from(attribute.array).every(Number.isFinite)).toBe(true);
      }
      geometry.dispose();
    }
  });

  test("camera culling uses room coordinates and resources release on environment changes", () => {
    const plants = shorePlantPlacements(source, { x: 13, z: -7 }, 27);
    const shore = createParkShoreline(plants, (x, y, z) => new THREE.Vector3(1000 - x, y - 12, -1000 - z));
    const scene = new THREE.Scene(); scene.add(shore.group);
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(1000, 0, -1000); shore.update(camera);
    expect(shore.group.children.every(mesh => mesh.visible)).toBe(true);
    camera.position.set(0, 0, 0); shore.update(camera);
    expect(shore.group.children.every(mesh => !mesh.visible)).toBe(true);
    camera.position.set(1000, 0, -1000); shore.update(camera);
    expect(shore.group.children.every(mesh => mesh.visible)).toBe(true);
    const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>();
    let disposed = 0;
    for (const child of shore.group.children) {
      const mesh = child as THREE.InstancedMesh;
      geometries.add(mesh.geometry); materials.add(mesh.material as THREE.Material);
      mesh.addEventListener("dispose", () => disposed++);
    }
    for (const resource of [...geometries, ...materials]) resource.addEventListener("dispose", () => disposed++);
    shore.dispose();
    expect(shore.group.parent).toBeNull();
    expect(disposed).toBe(shore.group.children.length + geometries.size + materials.size);
  });
});
