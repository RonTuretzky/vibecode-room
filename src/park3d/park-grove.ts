import * as THREE from "three";
import { barkTexture } from "../ui/tree/build";
import { parkLeafMaterial } from "./park-materials";
import { buildGroveGeometry, GROVE_FORMS } from "./park-grove-geometry";

export interface GroveTree { x: number; y: number; z: number; scale: number; rot: number; form?: number }

/** Several broadleaf silhouettes, spatially batched for eye/water culling. */
export function createParkGrove(trees: GroveTree[]) {
  const group = new THREE.Group();
  group.name = "park-broadleaf-groves";
  const forms = GROVE_FORMS.map((_, i) => buildGroveGeometry(i));
  const bark = new THREE.MeshStandardMaterial({ map: barkTexture(), roughness: .96 });
  const leaves = parkLeafMaterial(0x829957);
  leaves.vertexColors = true;
  const batches = new Map<string, { form: number; trees: GroveTree[] }>();
  trees.forEach((tree, i) => {
    const form = tree.form ?? i % forms.length;
    // Slightly larger cells offset the additional batches for crown variants.
    const key = `${Math.floor(tree.x / 130)},${Math.floor(tree.z / 130)},${form}`;
    const batch = batches.get(key) ?? { form, trees: [] };
    batch.trees.push(tree); batches.set(key, batch);
  });
  const dummy = new THREE.Object3D(), tint = new THREE.Color();
  for (const { form, trees: batch } of batches.values()) {
    for (const [geometry, material] of [[forms[form]!.trunk, bark], [forms[form]!.canopy, leaves]] as const) {
      const mesh = new THREE.InstancedMesh(geometry, material, batch.length);
      batch.forEach((tree, i) => {
        dummy.position.set(tree.x, tree.y, tree.z);
        dummy.rotation.y = tree.rot;
        dummy.scale.set(tree.scale * (.93 + (i % 3) * .07), tree.scale * (.92 + (i % 4) * .06), tree.scale);
        dummy.updateMatrix(); mesh.setMatrixAt(i, dummy.matrix);
        if (material === leaves) mesh.setColorAt(i, tint.setHSL(.20 + form * .015, .08, .83 + (i % 3) * .045));
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
    forms.forEach(({ trunk, canopy }) => { trunk.dispose(); canopy.dispose(); });
    bark.dispose(); leaves.dispose();
  } };
}
