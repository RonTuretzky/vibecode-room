import * as THREE from "three";
import { parkBarkMaterial } from './park-bark';
import { parkLeafMaterial } from "./park-materials";
import { buildGroveGeometry, GROVE_FORMS } from "./park-grove-geometry";
import { createParkWind } from './park-wind';
import { broadleafTexture } from './park-broadleaf-texture';

export interface GroveTree { x: number; y: number; z: number; scale: number; rot: number; form?: number; detail?: boolean; height?: number }

/** Several broadleaf silhouettes, spatially batched for eye/water culling. */
export function createParkGrove(trees: GroveTree[]) {
  const group = new THREE.Group();
  group.name = "park-broadleaf-groves";
  const forms = [false, true].flatMap(detail => GROVE_FORMS.map((_, i) => buildGroveGeometry(i, detail)));
  const barkMaterials = [parkBarkMaterial(), parkBarkMaterial(true)];
  const wind = createParkWind();
  const leafMaterials = GROVE_FORMS.map((_, i) => {
    const material = parkLeafMaterial(0x829957, broadleafTexture(i));
    material.vertexColors = true; wind.attach(material); return material;
  });
  const leafDepths = leafMaterials.map(material => {
    const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking,
      map: material.map, alphaTest: material.alphaTest, side: THREE.DoubleSide });
    wind.attach(depth); return depth;
  });
  const batches = new Map<string, { form: number; trees: GroveTree[] }>();
  trees.forEach((tree, i) => {
    const form = (tree.form ?? i % GROVE_FORMS.length) + (tree.detail ? GROVE_FORMS.length : 0);
    // Slightly larger cells offset the additional batches for crown variants.
    const key = `${Math.floor(tree.x / 130)},${Math.floor(tree.z / 130)},${form}`;
    const batch = batches.get(key) ?? { form, trees: [] };
    batch.trees.push(tree); batches.set(key, batch);
  });
  const dummy = new THREE.Object3D(), tint = new THREE.Color();
  for (const { form, trees: batch } of batches.values()) {
    const bark = barkMaterials[form % GROVE_FORMS.length === 2 ? 1 : 0]!;
    const leaves = leafMaterials[form % GROVE_FORMS.length]!;
    const modelHeight = Math.max(forms[form]!.trunk.boundingBox!.max.y, forms[form]!.canopy.boundingBox!.max.y);
    for (const [geometry, material] of [[forms[form]!.trunk, bark], [forms[form]!.canopy, leaves]] as const) {
      const mesh = new THREE.InstancedMesh(geometry, material, batch.length);
      batch.forEach((tree, i) => {
        dummy.position.set(tree.x, tree.y, tree.z);
        dummy.rotation.y = tree.rot;
        dummy.scale.set(tree.scale * (.93 + (i % 3) * .07), tree.height === undefined ? tree.scale * (.92 + (i % 4) * .06) : tree.height / modelHeight, tree.scale);
        dummy.updateMatrix(); mesh.setMatrixAt(i, dummy.matrix);
        if (material === leaves) mesh.setColorAt(i, tint.setHSL(.20 + (form % 3) * .015, .08, .83 + (i % 3) * .045));
      });
      mesh.computeBoundingSphere();
      if (material === leaves) {
        mesh.customDepthMaterial = leafDepths[form % GROVE_FORMS.length]!;
        // Maximum local sway is under .18 m; retain room for scaled crowns.
        mesh.boundingSphere!.radius += .5;
      }
      mesh.receiveShadow = true;
      mesh.castShadow = batch.some(tree => Math.hypot(tree.x, tree.z) < 260);
      mesh.userData.parkReflect = true;
      group.add(mesh);
    }
  }
  return { group, update: wind.update, dispose() {
    group.removeFromParent();
    group.traverse(node => { if (node instanceof THREE.InstancedMesh) node.dispose(); });
    forms.forEach(({ trunk, canopy }) => { trunk.dispose(); canopy.dispose(); });
    [...barkMaterials, ...leafMaterials, ...leafDepths].forEach(material => material.dispose());
  } };
}
