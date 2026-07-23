import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

// Real CC0 Poly Haven photoscans for the pastoral garden (fetched into
// public/assets/garden by scripts/fetch-garden-assets.py). Many of the scans
// are SETS: several separate clumps (grass tufts, rocks, dandelions) laid
// out in a row for the artist to pick from. Each top-level node therefore
// becomes a scatter VARIANT — recentered to its own origin — and a variant's
// glTF primitives become instanceable (geometry, material) pieces with the
// node transform baked in. RoomScene renders hundreds of copies as a few
// InstancedMesh draw calls per (variant, piece).
//
// The cache is module-level and lives for the page: RoomScene disposes its
// InstancedMeshes on mode switches but NEVER the shared geometries/materials
// here (it skips nodes flagged userData.sharedAsset) — a garden↔orbit toggle
// must not refetch or re-decode megabytes of meshes.

export interface FloraPiece {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
}

export interface FloraVariant {
  pieces: FloraPiece[];
}

export type FloraLibrary = Map<string, FloraVariant[]>;

export const FLORA_MODELS = [
  "grass_medium_01",
  "flower_gazania",
  "flower_ursinia",
  "dandelion_01",
  "periwinkle_plant",
  "shrub_02",
  "shrub_03",
  "rock_moss_set_01",
  "tree_stump_01",
  "jacaranda_tree",
] as const;

let libraryPromise: Promise<FloraLibrary> | null = null;

function tuneMaterial(material: THREE.MeshStandardMaterial): void {
  // Foliage ships as alpha-BLEND; hundreds of instanced blended surfaces
  // sort badly and cost overdraw. Alpha-tested cutout foliage renders in
  // the opaque pass, self-sorts via depth, and reads crisper.
  if (material.transparent) {
    material.transparent = false;
    material.alphaTest = 0.45;
    material.depthWrite = true;
    material.side = THREE.DoubleSide;
  }
  // The scans' baked AO reads as heavy shadow under the garden's bright
  // daylight rig — soften it so canopies don't go silhouette-black.
  if (material.aoMap !== null) {
    material.aoMapIntensity = 0.35;
  }
}

async function loadModel(loader: GLTFLoader, name: string): Promise<FloraVariant[]> {
  const gltf = await loader.loadAsync(`/assets/garden/models/${name}.glb`);
  gltf.scene.updateMatrixWorld(true);
  // Each top-level glTF node is one clump: the sets export one named node
  // per tuft/rock, and a multi-primitive model (the jacaranda's trunk/
  // branches/leaves) loads as ONE child Group — so scene.children is the
  // exact variant list.
  const variants: FloraVariant[] = [];
  for (const root of gltf.scene.children) {
    const pieces: FloraPiece[] = [];
    root.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) {
        return;
      }
      const geometry = (node.geometry as THREE.BufferGeometry).clone();
      // The packed GLBs store positions as quantized (normalized int16,
      // often interleaved) with the dequant transform in the node scale.
      // applyMatrix4/translate would write meter-scale floats back into that
      // int16 storage, where they clamp to ±1 and collapse the mesh — so
      // ALWAYS rebuild position/normal as plain float32 first (getComponent
      // denormalizes for both BufferAttribute and InterleavedBufferAttribute).
      for (const key of ["position", "normal"]) {
        const attr = geometry.getAttribute(key);
        if (attr === undefined) {
          continue;
        }
        const floats = new Float32Array(attr.count * attr.itemSize);
        for (let i = 0; i < attr.count; i++) {
          for (let c = 0; c < attr.itemSize; c++) {
            floats[i * attr.itemSize + c] = attr.getComponent(i, c);
          }
        }
        geometry.setAttribute(key, new THREE.BufferAttribute(floats, attr.itemSize));
      }
      geometry.applyMatrix4(node.matrixWorld);
      tuneMaterial(node.material as THREE.MeshStandardMaterial);
      pieces.push({ geometry, material: node.material as THREE.Material });
    });
    if (pieces.length === 0) {
      continue;
    }
    // Recenter the clump onto its own origin (x/z only — the scans are
    // already ground-anchored in y) so scatter placement owns the position.
    const box = new THREE.Box3();
    for (const piece of pieces) {
      piece.geometry.computeBoundingBox();
      box.union(piece.geometry.boundingBox!);
    }
    const center = box.getCenter(new THREE.Vector3());
    for (const piece of pieces) {
      piece.geometry.translate(-center.x, 0, -center.z);
      piece.geometry.computeBoundingBox();
      piece.geometry.computeBoundingSphere();
    }
    variants.push({ pieces });
  }
  return variants;
}

export function loadGardenFlora(): Promise<FloraLibrary> {
  if (libraryPromise === null) {
    const loader = new GLTFLoader();
    libraryPromise = Promise.all(
      FLORA_MODELS.map(async (name): Promise<[string, FloraVariant[]]> => [name, await loadModel(loader, name)]),
    ).then((entries) => new Map(entries));
  }
  return libraryPromise;
}
