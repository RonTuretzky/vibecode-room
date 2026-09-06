import * as THREE from 'three';
import { mulberry32 } from '../ui/tree/spec';

let paintedWood: THREE.CanvasTexture | null = null;
/** Subtle raised grain under paint; generated once and reused by rebuilds. */
function woodTexture() {
  if (paintedWood || typeof document === 'undefined') return paintedWood;
  const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 256;
  const ctx = canvas.getContext('2d')!, rng = mulberry32(19396737);
  ctx.fillStyle = '#d7dbd2'; ctx.fillRect(0, 0, 1024, 256);
  for (let line = 0; line < 360; line++) {
    const y = rng() * 256, phase = rng() * Math.PI * 2, frequency = .003 + rng() * .006;
    const amplitude = 1 + rng() * 3;
    ctx.strokeStyle = rng() > .35 ? 'rgba(77,86,72,.085)' : 'rgba(255,255,237,.18)';
    ctx.lineWidth = .35 + rng() * .65;
    for (const offset of [-256, 0, 256]) {
      ctx.beginPath();
      for (let x = 0; x <= 1024; x += 8) {
        const yy = y + offset + Math.sin(x * frequency + phase) * amplitude;
        if (x === 0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
      }
      ctx.stroke();
    }
  }
  paintedWood = new THREE.CanvasTexture(canvas);
  paintedWood.colorSpace = THREE.SRGBColorSpace;
  paintedWood.wrapS = paintedWood.wrapT = THREE.RepeatWrapping;
  paintedWood.anisotropy = 8;
  return paintedWood;
}

export function parkFurnitureMaterials() {
  const grain = woodTexture();
  return {
    // Paint is a dielectric coating even when the underlying casting is iron.
    iron: new THREE.MeshStandardMaterial({ color: 0x26372f, roughness: .54, metalness: .08 }),
    wood: new THREE.MeshStandardMaterial({ color: 0x4b6b54, map: grain, bumpMap: grain, bumpScale: .0006,
      vertexColors: true, roughness: .66, metalness: 0 }),
    hardware: new THREE.MeshStandardMaterial({ color: 0x879187, roughness: .43, metalness: .7 }),
    // Thin tinted glazing preserves the lantern's open structure. Avoid a
    // transmission framebuffer for these small, repeated decorative objects.
    glass: new THREE.MeshStandardMaterial({ color: 0xe1e5d5, roughness: .24, metalness: .08,
      transparent: true, opacity: .38, depthWrite: false }),
  };
}
