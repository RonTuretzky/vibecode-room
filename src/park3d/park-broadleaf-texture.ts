import * as THREE from 'three';
import { mulberry32 } from '../ui/tree/spec';

const textures = new Map<number, THREE.CanvasTexture>();

/** Elm-like serrated leaves, pointed oak lobes and palmate plane leaves.
 * These small sprays share the grove card UVs; the atlas is generated once. */
export function broadleafTexture(form: number) {
  if (textures.has(form)) return textures.get(form)!;
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 512;
  const ctx = canvas.getContext('2d')!; ctx.scale(2, 2);
  const rng = mulberry32(0x4c454146 + form * 1297);
  for (let branch = 0; branch < 7; branch++) {
    const angle = -Math.PI + .32 + branch * (Math.PI - .64) / 6;
    const bx = 128, by = 220 - Math.abs(branch - 3) * 12;
    const reach = Math.min(134 + rng() * 45, 100 / Math.max(.05, Math.abs(Math.cos(angle))));
    const dx = Math.cos(angle) * reach, dy = Math.sin(angle) * reach;
    ctx.strokeStyle = '#777765'; ctx.lineWidth = 1.3;
    ctx.beginPath(); ctx.moveTo(bx, by); ctx.quadraticCurveTo(bx + dx * .55, by + dy * .3, bx + dx, by + dy); ctx.stroke();
    for (let i = 0; i < 8; i++) {
      const t = .25 + i * .095, side = i % 2 ? 1 : -1;
      ctx.save(); ctx.translate(bx + dx * t - Math.sin(angle) * side * 13, by + dy * t + Math.cos(angle) * side * 13);
      ctx.rotate(angle + Math.PI / 2 + side * .7);
      const width = (form === 2 ? 12 : 8) + rng() * 4, height = 13 + rng() * 6;
      ctx.scale(width, height);
      const gradient = ctx.createLinearGradient(-1, 0, 1, 0);
      gradient.addColorStop(0, '#98aa77'); gradient.addColorStop(.46, '#d3e2a4'); gradient.addColorStop(1, '#b6c88d');
      ctx.fillStyle = gradient; ctx.beginPath();
      if (form === 0) {
        // Unequal halves and a toothed edge suggest simple elm leaves.
        for (let j = 0; j <= 40; j++) {
          const a = j / 40 * Math.PI * 2, tooth = j % 2 ? .88 : 1;
          const x = Math.sin(a) * tooth * (a < Math.PI ? .87 : 1.0), y = Math.cos(a);
          if (j === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
      } else {
        const outline = form === 1
          ? [[0, 1], [.29, .65], [.64, .58], [.45, .36], [.91, .21], [.52, .07], [.85, -.3], [.41, -.25], [.51, -.65], [.18, -.49], [0, -1]]
          : [[0, 1], [.28, .53], [.83, .6], [.69, .19], [1, -.13], [.48, -.26], [.6, -.71], [.24, -.47], [0, -1]];
        outline.forEach(([x, y], j) => { if (j === 0) ctx.moveTo(x!, y!); else ctx.lineTo(x!, y!); });
        for (let j = outline.length - 2; j > 0; j--) ctx.lineTo(-outline[j]![0]!, outline[j]![1]!);
      }
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(69,99,51,.26)'; ctx.lineWidth = .035;
      ctx.beginPath(); ctx.moveTo(0, .96); ctx.lineTo(0, -.89); ctx.stroke();
      for (let vein = 0; vein < 4; vein++) for (const side of [-1, 1]) {
        const y = .53 - vein * .28;
        ctx.beginPath(); ctx.moveTo(0, y + .1); ctx.lineTo(side * (.65 - vein * .08), y - .14); ctx.stroke();
      }
      ctx.restore();
    }
  }
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8; texture.name = `park-broadleaf-${form}`;
  textures.set(form, texture); return texture;
}
