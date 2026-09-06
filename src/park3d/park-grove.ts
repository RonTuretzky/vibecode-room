import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { barkTexture } from "../ui/tree/build";
import { mulberry32 } from "../ui/tree/spec";
import { parkFoliageTexture } from "./park-materials";

export interface GroveTree { x: number; y: number; z: number; scale: number; rot: number }

/** Mid-distance broadleaf trees: hundreds of leaf-bearing twigs, not 85k-triangle scans.
 * Spatial batches can be culled independently in both the eye and water cameras. */
export function createParkGrove(trees: GroveTree[]) {
  const group = new THREE.Group();
  group.name = "park-broadleaf-groves";
  const rng = mulberry32(0x47524f56);
  const leafParts: THREE.BufferGeometry[] = [], woodParts: THREE.BufferGeometry[] = [];
  const trunk = new THREE.CylinderGeometry(.23, .55, 6.8, 7);
  trunk.translate(0, 3.4, 0); woodParts.push(trunk);
  const direction = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const matrix = new THREE.Matrix4(), quat = new THREE.Quaternion();
  for (let lobe = 0; lobe < 9; lobe++) {
    const angle = lobe * 2.39996;
    const r = lobe === 8 ? 0 : 2.4 + rng() * 1.2;
    const center = new THREE.Vector3(Math.cos(angle) * r, 6.7 + rng() * 2.7, Math.sin(angle) * r);
    const start = new THREE.Vector3(0, 3.9 + rng() * 1.5, 0);
    direction.copy(center).sub(start);
    const branch = new THREE.CylinderGeometry(.045, .18, direction.length(), 5);
    quat.setFromUnitVectors(up, direction.clone().normalize());
    matrix.compose(start.clone().lerp(center, .5), quat, new THREE.Vector3(1, 1, 1));
    branch.applyMatrix4(matrix); woodParts.push(branch);
    for (let i = 0; i < 34; i++) {
      const a = rng() * Math.PI * 2, radius = Math.sqrt(rng()) * 2;
      const card = new THREE.PlaneGeometry(2.1 + rng() * .8, 2.3 + rng());
      card.rotateZ(rng() * Math.PI * 2); card.rotateY(rng() * Math.PI); card.rotateX((rng() - .5) * Math.PI);
      card.translate(center.x + Math.cos(a) * radius, center.y + (rng() - .5) * 2.6, center.z + Math.sin(a) * radius);
      // Smooth the lighting across each crown lobe, while retaining some
      // leaf-plane variation. Random flat normals make canopies look wiry.
      const points = card.getAttribute("position"), normals = card.getAttribute("normal");
      for (let v = 0; v < points.count; v++) {
        const outward = new THREE.Vector3(points.getX(v) - center.x, (points.getY(v) - center.y) * .65 + .6, points.getZ(v) - center.z).normalize();
        normals.setXYZ(v, outward.x, outward.y, outward.z);
      }
      leafParts.push(card);
    }
  }
  const wood = mergeGeometries(woodParts)!;
  const canopy = mergeGeometries(leafParts)!;
  [...woodParts, ...leafParts].forEach(g => g.dispose());
  const bark = new THREE.MeshStandardMaterial({ map: barkTexture(), roughness: .96 });
  const leaves = new THREE.MeshStandardMaterial({ map: parkFoliageTexture(), alphaTest: .38, alphaToCoverage: true, side: THREE.DoubleSide, roughness: .85, color: 0x759445 });
  const batches = new Map<string, GroveTree[]>();
  for (const tree of trees) {
    const key = `${Math.floor(tree.x / 90)},${Math.floor(tree.z / 90)}`;
    const batch = batches.get(key) ?? []; batch.push(tree); batches.set(key, batch);
  }
  const dummy = new THREE.Object3D();
  for (const batch of batches.values()) {
    for (const [geometry, material] of [[wood, bark], [canopy, leaves]] as const) {
      const mesh = new THREE.InstancedMesh(geometry, material, batch.length);
      batch.forEach((tree, i) => {
        dummy.position.set(tree.x, tree.y, tree.z);
        dummy.rotation.y = tree.rot;
        dummy.scale.set(tree.scale, tree.scale * (.92 + (i % 4) * .06), tree.scale);
        dummy.updateMatrix(); mesh.setMatrixAt(i, dummy.matrix);
        mesh.setColorAt(i, new THREE.Color().setHSL(.22 + (i % 5) * .009, .12, .78 + (i % 3) * .05));
      });
      mesh.computeBoundingSphere();
      mesh.receiveShadow = true;
      mesh.castShadow = batch.some(tree => Math.hypot(tree.x, tree.z) < 260);
      mesh.userData.parkReflect = true;
      group.add(mesh);
    }
  }
  return { group, dispose() {
    group.removeFromParent();
    group.traverse(node => { if (node instanceof THREE.InstancedMesh) node.dispose(); });
    wood.dispose(); canopy.dispose(); bark.dispose(); leaves.dispose();
  } };
}
