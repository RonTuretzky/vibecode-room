import * as THREE from 'three';

type WalkTexture = 'aggregate' | 'pavers' | 'earth' | 'mulch' | 'boards';
const textures = new Map<WalkTexture, THREE.Texture>();

/** Page-lifetime textures, baked from the original seeded canvas painters.
 * Shared by paths, streets and the rink; materials do not own these maps. */
export function parkWalkTexture(kind: WalkTexture): THREE.Texture {
  const cached = textures.get(kind);
  if (cached) return cached;
  const map = new THREE.TextureLoader().load(`/assets/park/walks/${kind}.png`);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.anisotropy = 8;
  textures.set(kind, map);
  return map;
}
