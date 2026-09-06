import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { mulberry32 } from "../ui/tree/spec";
import { groundNoise } from "./park-ground";

export interface ShoreSource {
  waterAt: (x: number, z: number) => number;
  groundAt: (x: number, z: number) => number;
  canPlant: (x: number, z: number, clearance?: number) => boolean;
  waterLevel: number;
}
export interface ShorePlant { x: number; y: number; z: number; scale: number; rotation: number; kind: 0 | 1 }

/** Patchy emergent vegetation on dry/shallow edges, not a uniform decorative
 * ring. Roots follow the rendered ground and avoid paths/bridge approaches. */
export function shorePlantPlacements(source: ShoreSource, center: { x: number; z: number }, reach: number): ShorePlant[] {
  const rng = mulberry32(0x53484f52), plants: ShorePlant[] = [];
  const stride = 1.1;
  for (let z = center.z - reach; z <= center.z + reach; z += stride) {
    for (let x = center.x - reach; x <= center.x + reach; x += stride) {
      const px = x + (rng() - .5) * stride, pz = z + (rng() - .5) * stride;
      if (Math.hypot(px - center.x, pz - center.z) > reach) continue;
      if (source.waterAt(px, pz) > .45) continue;
      const wet = Math.max(source.waterAt(px + 2.5, pz), source.waterAt(px - 2.5, pz), source.waterAt(px, pz + 2.5), source.waterAt(px, pz - 2.5));
      if (wet < .65) continue;
      const y = source.groundAt(px, pz);
      if (y < source.waterLevel - .15 || y > source.waterLevel + 1.7) continue;
      // Broad drifts contain finer openings and feather out into bare ground.
      // Check the expensive path/structure mask only at viable wet edges.
      const patch = groundNoise(px + 291, pz - 137, 15) * .72 + groundNoise(px - 87, pz + 43, 4.5) * .28;
      if (rng() > THREE.MathUtils.smoothstep(patch, .3, .65) * .92 || !source.canPlant(px, pz, 1)) continue;
      // Avoid planting a flat multi-stem base across an abrupt carved bank.
      if ([[.35, 0], [-.35, 0], [0, .35], [0, -.35]].some(([dx, dz]) => Math.abs(source.groundAt(px + dx!, pz + dz!) - y) > .3)) continue;
      const kind = patch > .61 && y < source.waterLevel + .8 ? 1 : 0;
      plants.push({ x: px, y: Math.max(y, source.waterLevel - .08), z: pz,
        scale: .75 + rng() * .6, rotation: rng() * Math.PI * 2, kind });
    }
  }
  return plants;
}

/** Blades have a bend and a taper, with solid silhouette geometry instead
 * of a large transparent grass billboard. Heights here are actual metres. */
export function shorePlantGeometry(kind: 0 | 1): THREE.BufferGeometry {
  const rng = mulberry32(6412 + kind), parts: THREE.BufferGeometry[] = [];
  const green = new THREE.Color(0x72884b), base = new THREE.Color(0x424d2a), straw = new THREE.Color(0x8e8d58);
  const blade = (angle: number, height: number, width: number, lean: number, ox: number, oz: number) => {
    const positions: number[] = [], colors: number[] = [], indices: number[] = [];
    const color = new THREE.Color();
    for (let j = 0; j <= 3; j++) {
      const t = j / 3, r = lean * t * t, w = width * (1 - t) + .0005;
      for (const side of [-1, 1]) positions.push(ox + Math.cos(angle) * r - Math.sin(angle) * w * side,
        height * (t - .13 * t * t), oz + Math.sin(angle) * r + Math.cos(angle) * w * side);
      color.copy(base).lerp(green, Math.min(1, t * 1.8)).lerp(straw, Math.max(0, t - .7) * .6);
      colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
      if (j) { const a = (j - 1) * 2; indices.push(a, a + 2, a + 3, a, a + 3, a + 1); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    g.setIndex(indices); g.computeVertexNormals(); parts.push(g);
  };
  const solid = (geometry: THREE.BufferGeometry, color: THREE.Color) => {
    geometry.deleteAttribute('uv');
    const colors = new Float32Array(geometry.attributes.position!.count * 3);
    for (let i = 0; i < colors.length; i += 3) colors.set(color.toArray(), i);
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3)); parts.push(geometry);
  };
  for (let i = 0; i < (kind ? 18 : 22); i++) {
    const angle = i * 2.39996, height = kind ? .85 + rng() * .8 : .3 + rng() * .55;
    const radius = rng() * (kind ? .4 : .25);
    blade(angle, height, kind ? .035 : .022, .3 + rng() * .5, Math.cos(angle) * radius, Math.sin(angle) * radius);
  }
  if (kind) for (let i = 0; i < 5; i++) {
    const angle = rng() * Math.PI * 2, x = Math.cos(angle) * .3, z = Math.sin(angle) * .3, h = 1.2 + rng() * .6;
    const stem = new THREE.CylinderGeometry(.012, .02, h, 5, 1, true);
    stem.translate(x, h / 2, z); solid(stem, green);
    const head = new THREE.CylinderGeometry(.035, .04, .21, 6);
    head.translate(x, h - .10, z); solid(head, new THREE.Color(0x59422c));
  }
  const geometry = mergeGeometries(parts)!; parts.forEach(g => g.dispose());
  geometry.computeBoundingBox(); geometry.computeBoundingSphere(); return geometry;
}

export function createParkShoreline(plants: ShorePlant[], toRoom: (x: number, y: number, z: number) => THREE.Vector3) {
  const group = new THREE.Group(); group.name = 'pond-sedges-and-cattails';
  const geometries = [shorePlantGeometry(0), shorePlantGeometry(1)];
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: .97 });
  const batches = new Map<string, { kind: 0 | 1; plants: ShorePlant[] }>();
  for (const p of plants) {
    const key = `${Math.floor(p.x / 65)},${Math.floor(p.z / 65)},${p.kind}`;
    const batch = batches.get(key) ?? { kind: p.kind, plants: [] }; batch.plants.push(p); batches.set(key, batch);
  }
  const dummy = new THREE.Object3D(), tint = new THREE.Color(), meshes: THREE.InstancedMesh[] = [];
  for (const batch of batches.values()) {
    const mesh = new THREE.InstancedMesh(geometries[batch.kind]!, material, batch.plants.length);
    batch.plants.forEach((p, i) => {
      dummy.position.copy(toRoom(p.x, p.y, p.z)); dummy.rotation.y = p.rotation; dummy.scale.setScalar(p.scale);
      dummy.updateMatrix(); mesh.setMatrixAt(i, dummy.matrix);
      const tone = .88 + groundNoise(p.x + 19, p.z - 31, 3) * .2;
      mesh.setColorAt(i, tint.setRGB(tone, tone, tone * .97));
    });
    mesh.computeBoundingSphere(); mesh.receiveShadow = true;
    mesh.castShadow = batch.kind === 1 && mesh.boundingSphere!.center.length() < 180;
    mesh.userData.parkReflect = batch.kind === 1;
    group.add(mesh); meshes.push(mesh);
  }
  return { group, count: plants.length,
    update(camera: THREE.Camera) {
      for (const mesh of meshes) {
        const reach = 230 + mesh.boundingSphere!.radius + (mesh.visible ? 12 : -12);
        mesh.visible = camera.position.distanceToSquared(mesh.boundingSphere!.center) < reach * reach;
      }
    },
    dispose() {
      group.removeFromParent(); meshes.forEach(m => m.dispose()); geometries.forEach(g => g.dispose()); material.dispose();
    },
  };
}
