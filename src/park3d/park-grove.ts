import * as THREE from "three";
import { parkBarkMaterial } from './park-bark';
import { parkLeafMaterial } from "./park-materials";
import { buildGroveGeometry, GROVE_FORMS, GROVE_VARIANTS, groveAppearanceAt } from "./park-grove-geometry";
import { createParkWind } from './park-wind';
import { broadleafTexture } from './park-broadleaf-texture';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { fitTreeBase, splitTreeBase } from './park-tree-bases';
import { createGroveBaseRange, GROVE_DETAIL_LIMIT, selectGroveDetail } from './park-grove-lod';

export interface GroveTree { x: number; y: number; z: number; scale: number; rot: number; form?: number; height?: number }

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
  const entries = trees.map(tree => {
    const appearance = groveAppearanceAt(tree.x, tree.z);
    const form = (tree.form ?? appearance.fallbackForm) + appearance.variant * GROVE_FORMS.length;
    const coarse = getForm(form), fine = getForm(form + detailOffset);
    // One transform for both resolutions: the trunk and branching scaffold
    // must not stretch when detail changes, including trees with mapped height.
    const box = coarse.trunk.boundingBox!.clone().union(coarse.canopy.boundingBox!)
      .union(fine.trunk.boundingBox!).union(fine.canopy.boundingBox!);
    const dummy = new THREE.Object3D();
    dummy.position.set(tree.x, tree.y, tree.z); dummy.rotation.y = tree.rot;
    dummy.scale.set(tree.scale * appearance.width, tree.height === undefined ? tree.scale : tree.height / box.max.y, tree.scale * appearance.depth);
    dummy.updateMatrix();
    const bounds = box.getBoundingSphere(new THREE.Sphere()).applyMatrix4(dummy.matrix); bounds.radius += .5;
    return { tree, form, matrix: dummy.matrix.clone(), bounds,
      tint: new THREE.Color().setHSL(.20 + (form % 3) * .015 + appearance.hue, .08, appearance.tone),
      bodies: [] as { mesh: THREE.InstancedMesh; slot: number }[],
      baseRange: null as ReturnType<typeof createGroveBaseRange> | null };
  });
  type Entry = typeof entries[number];
  const batches = new Map<string, { form: number; entries: Entry[] }>();
  entries.forEach(entry => {
    const { tree, form } = entry;
    // More variants can otherwise turn sparse cells into single-tree draws.
    // These broader batches retain local eye/reflection culling while sharing
    // more instances in the wide Wollman/Arsenal views.
    const key = `${Math.floor(tree.x / 180)},${Math.floor(tree.z / 180)},${form}`;
    const batch = batches.get(key) ?? { form, entries: [] };
    batch.entries.push(entry); batches.set(key, batch);
  });
  const baseBatches = new Map<string, { geometry: THREE.BufferGeometry[]; entries: Entry[]; material: THREE.Material; shadow: boolean }>();
  for (const [cell, { form, entries: batch }] of batches) {
    const model = getForm(form);
    const bark = barkMaterials[form % GROVE_FORMS.length === 2 ? 1 : 0]!;
    const leaves = leafMaterials[form % GROVE_FORMS.length]!;
    const bases = batch.map(entry => fitTreeBase(model.base, entry.matrix, groundAt));
    // Bases sharing a spatial cell and bark can share a draw even when their
    // upper trunks use different forms/detail levels.
    const baseKey = `${cell.slice(0, cell.lastIndexOf(','))},${bark === barkMaterials[1] ? 1 : 0}`;
    const baseBatch = baseBatches.get(baseKey) ?? { geometry: [], entries: [], material: bark, shadow: false };
    baseBatch.geometry.push(...bases); baseBatch.entries.push(...batch);
    baseBatch.shadow ||= batch.some(({ tree }) => Math.hypot(tree.x, tree.z) < 260);
    baseBatches.set(baseKey, baseBatch);
    for (const [geometry, material] of [[model.trunk, bark], [model.canopy, leaves]] as const) {
      const mesh = new THREE.InstancedMesh(geometry, material, batch.length);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      batch.forEach((entry, i) => {
        mesh.setMatrixAt(i, entry.matrix); entry.bodies.push({ mesh, slot: i });
        if (material === leaves) mesh.setColorAt(i, entry.tint);
      });
      mesh.computeBoundingSphere();
      if (material === leaves) {
        mesh.customDepthMaterial = leafDepths[form % GROVE_FORMS.length]!;
        // Maximum local sway is under .18 m; retain room for scaled crowns.
        mesh.boundingSphere!.radius += .5;
      }
      mesh.receiveShadow = true;
      mesh.castShadow = batch.some(({ tree }) => Math.hypot(tree.x, tree.z) < 260);
      mesh.userData.parkReflect = true;
      group.add(mesh);
    }
  }
  for (const { geometry, entries: batch, material, shadow } of baseBatches.values()) {
    const baseGeometry = mergeGeometries(geometry)!;
    let offset = 0;
    geometry.forEach((base, i) => {
      batch[i]!.baseRange = createGroveBaseRange(baseGeometry.index!, offset, base.index!.count);
      offset += base.index!.count;
    });
    geometry.forEach(base => base.dispose()); fittedBases.push(baseGeometry);
    const roots = new THREE.Mesh(baseGeometry, material);
    roots.name = 'park-grounded-tree-bases'; roots.castShadow = shadow;
    roots.receiveShadow = true; roots.userData.parkReflect = true; group.add(roots);
  }
  // A bounded set of reusable fine instances follows the viewer, instead of
  // assigning permanent detail only to the sixteen trees nearest the lawn.
  const fineBatches = new Map<number, { trunk: THREE.InstancedMesh; canopy: THREE.InstancedMesh }>();
  for (const form of new Set(entries.map(entry => entry.form))) {
    const model = getForm(form + detailOffset), genus = form % GROVE_FORMS.length;
    const trunk = new THREE.InstancedMesh(model.trunk, barkMaterials[genus === 2 ? 1 : 0]!, GROVE_DETAIL_LIMIT);
    const canopy = new THREE.InstancedMesh(model.canopy, leafMaterials[genus]!, GROVE_DETAIL_LIMIT);
    canopy.customDepthMaterial = leafDepths[genus]!;
    // Establish the color attribute before shader warmup, even if this form
    // has no nearby instances in the initial view.
    for (let slot = 0; slot < GROVE_DETAIL_LIMIT; slot++) canopy.setColorAt(slot, new THREE.Color());
    canopy.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    for (const mesh of [trunk, canopy]) {
      mesh.name = 'park-near-tree-detail'; mesh.count = 0; mesh.visible = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = true; mesh.receiveShadow = true; mesh.userData.parkReflect = true; group.add(mesh);
    }
    fineBatches.set(form, { trunk, canopy });
  }
  const nearBases = new Map<number, THREE.Mesh>();
  const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  const frustum = new THREE.Frustum(), projection = new THREE.Matrix4();
  const bounds = entries.map(entry => entry.bounds);
  let selected = new Set<number>(), nextCheck = -Infinity;
  const setCoarse = (entry: Entry, visible: boolean) => {
    for (const { mesh, slot } of entry.bodies) {
      mesh.setMatrixAt(slot, visible ? entry.matrix : hidden);
      mesh.instanceMatrix.addUpdateRange(slot * 16, 16); mesh.instanceMatrix.needsUpdate = true;
    }
    entry.baseRange!.setVisible(visible);
  };
  const updateDetail = (camera: THREE.PerspectiveCamera, seconds: number) => {
    if (seconds < nextCheck) return false;
    nextCheck = seconds + .2;
    camera.updateMatrixWorld();
    frustum.setFromProjectionMatrix(projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const next = selectGroveDetail(bounds, camera.position, frustum, selected);
    if (next.size === selected.size && [...next].every(index => selected.has(index))) return false;
    for (const index of selected) if (!next.has(index)) {
      setCoarse(entries[index]!, true);
      const root = nearBases.get(index)!; root.removeFromParent(); root.geometry.dispose(); nearBases.delete(index);
    }
    for (const index of next) if (!selected.has(index)) {
      const entry = entries[index]!;
      const root = new THREE.Mesh(fitTreeBase(getForm(entry.form + detailOffset).base, entry.matrix, groundAt),
        barkMaterials[entry.form % GROVE_FORMS.length === 2 ? 1 : 0]);
      root.name = 'park-near-tree-base'; root.castShadow = true; root.receiveShadow = true; root.userData.parkReflect = true;
      group.add(root); nearBases.set(index, root); setCoarse(entry, false);
    }
    for (const batch of fineBatches.values()) { batch.trunk.count = 0; batch.canopy.count = 0; }
    for (const index of next) {
      const entry = entries[index]!, { trunk, canopy } = fineBatches.get(entry.form)!;
      const slot = trunk.count++;
      canopy.count++; trunk.setMatrixAt(slot, entry.matrix); canopy.setMatrixAt(slot, entry.matrix); canopy.setColorAt(slot, entry.tint);
    }
    for (const { trunk, canopy } of fineBatches.values()) for (const mesh of [trunk, canopy]) {
      mesh.visible = mesh.count > 0;
      if (mesh.visible) {
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.computeBoundingSphere(); mesh.boundingSphere!.radius += .5;
      }
    }
    selected = next;
    group.userData.detailTrees = [...next].map(index => ({ x: entries[index]!.tree.x, z: entries[index]!.tree.z }));
    return true;
  };
  return { group, update(seconds: number, motion: boolean, camera: THREE.PerspectiveCamera) {
    wind.update(seconds, motion); return updateDetail(camera, seconds);
  }, dispose() {
    group.removeFromParent();
    group.traverse(node => { if (node instanceof THREE.InstancedMesh) node.dispose(); });
    nearBases.forEach(root => root.geometry.dispose()); nearBases.clear();
    forms.forEach(({ trunk, canopy, base }) => { trunk.dispose(); canopy.dispose(); base.dispose(); });
    fittedBases.forEach(base => base.dispose());
    [...barkMaterials, ...leafMaterials, ...leafDepths].forEach(material => material.dispose());
  } };
}
