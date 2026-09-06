import * as THREE from 'three';

// CC0 Poly Haven scans. Textures persist for the page; materials belong to the
// current grove. See public/assets/park/bark/sources.json for original files.
const maps = new Map<string, THREE.Texture>();
function barkMap(asset: string, kind: 'diff' | 'nor' | 'rough') {
  const key = `${asset}_${kind}`;
  if (maps.has(key)) return maps.get(key)!;
  const texture = new THREE.TextureLoader().load(`/assets/park/bark/${key}_1k.jpg`);
  texture.name = key;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  if (kind === 'diff') texture.colorSpace = THREE.SRGBColorSpace;
  maps.set(key, texture); return texture;
}

export function parkBarkMaterial(plane = false) {
  const asset = plane ? 'bark_platanus' : 'bark_willow';
  return new THREE.MeshStandardMaterial({
    color: plane ? 0xffffff : 0xd0d7cf,
    map: barkMap(asset, 'diff'), normalMap: barkMap(asset, 'nor'), roughnessMap: barkMap(asset, 'rough'),
    normalScale: new THREE.Vector2(.65, .65), roughness: 1,
  });
}
