import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../ui/tree/spec';
import { groundNoise } from './park-ground';
import { parkLeafMaterial } from './park-materials';

export interface UnderstoreySource {
  groundAt: (x: number, z: number) => number;
  canopyAt: (x: number, z: number) => number;
  lawnAt: (x: number, z: number) => number;
  waterAt: (x: number, z: number) => number;
  canPlant: (x: number, z: number, clearance: number) => boolean;
}
export interface UnderstoreyPlant { x: number; y: number; z: number; scale: number; angle: number; form: number }

/** A patchy shrub layer below wooded canopy. Its own seed keeps the existing
 * trees/furniture stable. Bounded sampling and spatial batches cap the cost. */
export function understoreyPlacements(source: UnderstoreySource, center: { x: number; z: number }, reach = 440): UnderstoreyPlant[] {
  const rng = mulberry32(0x554e4445), plants: UnderstoreyPlant[] = [];
  const stride = 3.8;
  for (let z = center.z - reach; z <= center.z + reach; z += stride) {
    for (let x = center.x - reach; x <= center.x + reach; x += stride) {
      const px = x + (rng() - .5) * stride * .7, pz = z + (rng() - .5) * stride * .7;
      const distance = Math.hypot(px - center.x, pz - center.z);
      if (distance < 48 || distance > reach || source.canopyAt(px, pz) < 6 || source.lawnAt(px, pz) > .35) continue;
      const patch = groundNoise(px + 158, pz - 631, 18);
      if (patch < .5 || rng() > .83) continue;
      const scale = .7 + rng() * .7;
      if (!source.canPlant(px, pz, 1.5 * scale)) continue;
      if (Math.max(source.waterAt(px, pz), source.waterAt(px + 1.5, pz), source.waterAt(px - 1.5, pz), source.waterAt(px, pz + 1.5), source.waterAt(px, pz - 1.5)) > .3) continue;
      const y = source.groundAt(px, pz);
      const slope = Math.max(...[[1.5, 0], [-1.5, 0], [0, 1.5], [0, -1.5]].map(([dx, dz]) => Math.abs(source.groundAt(px + dx!, pz + dz!) - y)));
      if (!Number.isFinite(y) || slope > .75) continue;
      plants.push({ x: px, y, z: pz, scale, angle: rng() * Math.PI * 2, form: patch > .64 ? 1 : 0 });
    }
  }
  // Retain the most visible neighbourhood first when a dense source mask
  // supplies more candidates than the budget; don't truncate by map row.
  plants.sort((a, b) => Math.hypot(a.x - center.x, a.z - center.z) - Math.hypot(b.x - center.x, b.z - center.z));
  return plants.slice(0, 900);
}

export function understoreyGeometry(form: number) {
  const rng = mulberry32(1934 + form), leaves: THREE.BufferGeometry[] = [], stems: THREE.BufferGeometry[] = [];
  const height = form ? 1.65 : .85, spread = form ? .95 : 1.15;
  for (let branch = 0; branch < 7; branch++) {
    const angle = branch * 2.39996, reach = spread * (.5 + rng() * .4), top = height * (.65 + rng() * .35);
    const end = new THREE.Vector3(Math.cos(angle) * reach, top, Math.sin(angle) * reach);
    const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(0, -.035, 0), new THREE.Vector3(end.x * .15, top * .65, end.z * .15), end);
    const stem = new THREE.TubeGeometry(curve, 3, 1, 4, false);
    const stemPositions = stem.getAttribute('position'), centerline = new THREE.Vector3(), radial = new THREE.Vector3();
    for (let row = 0; row <= 3; row++) {
      const t = row / 3, radius = THREE.MathUtils.lerp(.025, .002, t);
      curve.getPointAt(t, centerline);
      for (let side = 0; side <= 4; side++) {
        const i = row * 5 + side;
        radial.fromBufferAttribute(stemPositions, i).sub(centerline).multiplyScalar(radius).add(centerline);
        stemPositions.setXYZ(i, radial.x, radial.y, radial.z);
      }
    }
    stem.computeVertexNormals(); stems.push(stem);
    for (let leaf = 0; leaf < 8; leaf++) {
      const t = .4 + leaf / 8 * .6, center = curve.getPoint(t);
      const geo = new THREE.PlaneGeometry(.68 + rng() * .23, .57 + rng() * .22);
      geo.rotateZ(rng() * Math.PI * 2); geo.rotateY(angle + (rng() - .5) * Math.PI); geo.rotateX((rng() - .5) * 1.8);
      geo.translate(center.x + (rng() - .5) * .65, center.y + (rng() - .5) * .22, center.z + (rng() - .5) * .65);
      const p = geo.getAttribute('position'), n = geo.getAttribute('normal'), colors = new Float32Array(p.count * 3);
      const normal = new THREE.Vector3();
      for (let i = 0; i < p.count; i++) {
        normal.set(p.getX(i), .4 + p.getY(i), p.getZ(i)).normalize(); n.setXYZ(i, normal.x, normal.y, normal.z);
        const shade = THREE.MathUtils.clamp(.58 + p.getY(i) / height * .4, .58, 1);
        colors.set([shade, shade, shade], i * 3);
      }
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3)); leaves.push(geo);
    }
  }
  const canopy = mergeGeometries(leaves)!, wood = mergeGeometries(stems)!;
  [...leaves, ...stems].forEach(g => g.dispose());
  canopy.computeBoundingSphere(); wood.computeBoundingSphere(); return { canopy, wood };
}

export function createParkUnderstorey(plants: UnderstoreyPlant[], toRoom: (x: number, y: number, z: number) => THREE.Vector3) {
  const group = new THREE.Group(); group.name = 'park-understorey';
  const forms = [understoreyGeometry(0), understoreyGeometry(1)];
  const foliage = parkLeafMaterial(0x7b8d58); foliage.vertexColors = true;
  const bark = new THREE.MeshStandardMaterial({ color: 0x685a3b, roughness: .98 });
  const buckets = new Map<string, UnderstoreyPlant[]>(), meshes: THREE.InstancedMesh[] = [];
  for (const p of plants) {
    const key = `${Math.floor(p.x / 70)},${Math.floor(p.z / 70)},${p.form}`;
    const bucket = buckets.get(key) ?? []; bucket.push(p); buckets.set(key, bucket);
  }
  const dummy = new THREE.Object3D(), tint = new THREE.Color();
  for (const batch of buckets.values()) {
    for (const [geometry, material] of [[forms[batch[0]!.form]!.canopy, foliage], [forms[batch[0]!.form]!.wood, bark]] as const) {
      const mesh = new THREE.InstancedMesh(geometry, material, batch.length);
      batch.forEach((p, i) => {
        dummy.position.copy(toRoom(p.x, p.y, p.z)); dummy.rotation.y = p.angle; dummy.scale.setScalar(p.scale); dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        if (material === foliage) mesh.setColorAt(i, tint.setHSL(.19 + i % 4 * .007, .08, .82 + i % 3 * .05));
      });
      mesh.computeBoundingSphere(); mesh.receiveShadow = true;
      // Nearby shrubs cast their cutout silhouettes. Distant low growth is
      // omitted from reflection/shadow passes to keep the added detail cheap.
      mesh.castShadow = mesh.boundingSphere!.center.length() < 210;
      group.add(mesh); meshes.push(mesh);
    }
  }
  return { group, count: plants.length, update(camera: THREE.Camera) {
    for (const mesh of meshes) {
      const reach = 245 + mesh.boundingSphere!.radius + (mesh.visible ? 14 : -14);
      mesh.visible = camera.position.distanceToSquared(mesh.boundingSphere!.center) < reach * reach;
    }
  }, dispose() {
    group.removeFromParent(); meshes.forEach(m => m.dispose());
    forms.forEach(g => { g.canopy.dispose(); g.wood.dispose(); }); foliage.dispose(); bark.dispose();
  } };
}
