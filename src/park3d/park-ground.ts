import * as THREE from "three";

// World-space value noise: continuous across tile/mesh boundaries, with no
// photograph's baked shadows or road markings mixed into the grass albedo.
const smooth = (v: number) => v * v * (3 - 2 * v);
const hash = (x: number, z: number) => {
  const n = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return n - Math.floor(n);
};
export function groundNoise(x: number, z: number, scale: number): number {
  const sx = x / scale, sz = z / scale, ix = Math.floor(sx), iz = Math.floor(sz);
  const tx = smooth(sx - ix), tz = smooth(sz - iz);
  return THREE.MathUtils.lerp(
    THREE.MathUtils.lerp(hash(ix, iz), hash(ix + 1, iz), tx),
    THREE.MathUtils.lerp(hash(ix, iz + 1), hash(ix + 1, iz + 1), tx), tz,
  );
}
const lawn = new THREE.Color(0x829256), woodland = new THREE.Color(0x697048);
const earth = new THREE.Color(0x79705a), damp = new THREE.Color(0x575d43);
const paving = new THREE.Color(0x979994);

/** Linear albedo for the lit room terrain. The aerial page keeps its photo. */
export function parkGroundColor(
  x: number, z: number, lawnMask: number, canopy: number, waterMask: number,
  inPark: boolean, target: THREE.Color,
): THREE.Color {
  const broad = groundNoise(x, z, 43), fine = groundNoise(x, z, 9);
  if (!inPark) return target.copy(paving).multiplyScalar(.94 + broad * .12);
  const open = THREE.MathUtils.clamp(lawnMask, 0, 1);
  const wooded = THREE.MathUtils.smoothstep(canopy, 1, 10) * (1 - open * .85);
  target.copy(lawn).lerp(woodland, wooded * .72);
  // Restrained leaf litter beneath crowns; shoreline masks add damp earth.
  target.lerp(earth, wooded * (.12 + fine * .18));
  target.lerp(damp, THREE.MathUtils.smoothstep(waterMask, .02, .65) * .8);
  return target.multiplyScalar(.92 + broad * .12 + fine * .06);
}
