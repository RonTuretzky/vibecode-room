import * as THREE from "three";
import { parkBarkMaterial } from './park-bark';
import { parkLeafMaterial } from "./park-materials";
import { buildGroveGeometry, GROVE_FORMS, GROVE_VARIANTS, groveAppearanceAt } from "./park-grove-geometry";
import { createParkWind } from './park-wind';
import { broadleafTexture } from './park-broadleaf-texture';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { fitTreeBase, splitTreeBase } from './park-tree-bases';

export interface GroveTree { x: number; y: number; z: number; scale: number; rot: number; form?: number; detail?: boolean; height?: number }

/** Several broadleaf silhouettes, spatially batched for eye/water culling. */
export function createParkGrove(trees: GroveTree[], groundAt: (x: number, z: number) => number) {
  const group = new THREE.Group();
  group.name = "park-broadleaf-groves";
  const detailOffset = GROVE_FORMS.length * GROVE_VARIANTS;
  const forms = new Map<number, ReturnType<typeof splitTreeBase> & { canopy: THREE.BufferGeometry }>();
  const getForm = (index: number) => {
    const cached = forms.get(index); if (cached) return cached;
    const { trunk, canopy } = buildGroveGeometry(index % GROVE_FORMS.length, index >= detailOffset,
      Math.floor(index / GROVE_FORMS.length) % GROVE_VARIANTS);
    const geometry = { ...splitTreeBase(trunk), canopy };
    trunk.dispose(); forms.set(index, geometry); return geometry;
  };
  const fittedBases: THREE.BufferGeometry[] = [];
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
  trees.forEach(tree => {
    const appearance = groveAppearanceAt(tree.x, tree.z);
    const form = (tree.form ?? appearance.fallbackForm) + appearance.variant * GROVE_FORMS.length + (tree.detail ? detailOffset : 0);
    // More variants can otherwise turn sparse cells into single-tree draws.
    // These broader batches retain local eye/reflection culling while sharing
    // more instances in the wide Wollman/Arsenal views.
    const key = `${Math.floor(tree.x / 180)},${Math.floor(tree.z / 180)},${form}`;
    const batch = batches.get(key) ?? { form, trees: [] };
    batch.trees.push(tree); batches.set(key, batch);
  });
  const dummy = new THREE.Object3D(), tint = new THREE.Color();
  const baseBatches = new Map<string, { geometry: THREE.BufferGeometry[]; material: THREE.Material; shadow: boolean }>();
  for (const [cell, { form, trees: batch }] of batches) {
    const model = getForm(form);
    const bark = barkMaterials[form % GROVE_FORMS.length === 2 ? 1 : 0]!;
    const leaves = leafMaterials[form % GROVE_FORMS.length]!;
    const modelHeight = Math.max(model.trunk.boundingBox!.max.y, model.canopy.boundingBox!.max.y);
    const placements = batch.map(tree => {
      const appearance = groveAppearanceAt(tree.x, tree.z);
      dummy.position.set(tree.x, tree.y, tree.z); dummy.rotation.y = tree.rot;
      dummy.scale.set(tree.scale * appearance.width, tree.height === undefined ? tree.scale : tree.height / modelHeight, tree.scale * appearance.depth);
      dummy.updateMatrix(); return dummy.matrix.clone();
    });
    const bases = placements.map(matrix => fitTreeBase(model.base, matrix, groundAt));
    // Bases sharing a spatial cell and bark can share a draw even when their
    // upper trunks use different forms/detail levels.
    const baseKey = `${cell.slice(0, cell.lastIndexOf(','))},${bark === barkMaterials[1] ? 1 : 0}`;
    const baseBatch = baseBatches.get(baseKey) ?? { geometry: [], material: bark, shadow: false };
    baseBatch.geometry.push(...bases); baseBatch.shadow ||= batch.some(tree => Math.hypot(tree.x, tree.z) < 260);
    baseBatches.set(baseKey, baseBatch);
    for (const [geometry, material] of [[model.trunk, bark], [model.canopy, leaves]] as const) {
      const mesh = new THREE.InstancedMesh(geometry, material, batch.length);
      batch.forEach((tree, i) => {
        mesh.setMatrixAt(i, placements[i]!);
        if (material === leaves) {
          const appearance = groveAppearanceAt(tree.x, tree.z);
          mesh.setColorAt(i, tint.setHSL(.20 + (form % 3) * .015 + appearance.hue, .08, appearance.tone));
        }
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
  for (const { geometry, material, shadow } of baseBatches.values()) {
    const baseGeometry = mergeGeometries(geometry)!;
    geometry.forEach(base => base.dispose()); fittedBases.push(baseGeometry);
    const roots = new THREE.Mesh(baseGeometry, material);
    roots.name = 'park-grounded-tree-bases'; roots.castShadow = shadow;
    roots.receiveShadow = true; roots.userData.parkReflect = true; group.add(roots);
  }
  return { group, update: wind.update, dispose() {
    group.removeFromParent();
    group.traverse(node => { if (node instanceof THREE.InstancedMesh) node.dispose(); });
    forms.forEach(({ trunk, canopy, base }) => { trunk.dispose(); canopy.dispose(); base.dispose(); });
    fittedBases.forEach(base => base.dispose());
    [...barkMaterials, ...leafMaterials, ...leafDepths].forEach(material => material.dispose());
  } };
}
