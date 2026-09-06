import * as THREE from "three";
import { mulberry32 } from "../ui/tree/spec";

// These textures are generated locally once; no remote images or GPU readback.
const textures = new Map<string, THREE.CanvasTexture>();
function texture(name: string, size: number, paint: (ctx: CanvasRenderingContext2D, size: number) => void) {
  const existing = textures.get(name);
  if (existing) return existing;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  paint(canvas.getContext("2d")!, size);
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  textures.set(name, map);
  return map;
}

/** A whole twig on a card, with small separated leaves instead of giant blades. */
export function parkFoliageTexture(): THREE.CanvasTexture {
  return texture("foliage", 256, (ctx, size) => {
    const rng = mulberry32(7291);
    ctx.strokeStyle = "#899778";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(128, 249); ctx.quadraticCurveTo(108, 135, 133, 22); ctx.stroke();
    for (let i = 0; i < 17; i++) {
      const y = 33 + i * 11;
      const side = i % 2 ? 1 : -1;
      const x = 123 + side * (20 + rng() * 22);
      ctx.strokeStyle = "#9ca68c";
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(124, y + 25); ctx.lineTo(x, y); ctx.stroke();
      ctx.save(); ctx.translate(x, y); ctx.rotate(side * (.6 + rng() * .4));
      const w = 14 + rng() * 6, h = 23 + rng() * 12;
      const shade = ctx.createLinearGradient(-w, 0, w, 0);
      shade.addColorStop(0, "#95ac7e"); shade.addColorStop(.47, "#f0f4c7"); shade.addColorStop(1, "#becd9e");
      ctx.fillStyle = shade;
      ctx.beginPath(); ctx.moveTo(0, h); ctx.bezierCurveTo(-w * 1.5, h * .1, -w, -h * .7, 0, -h); ctx.bezierCurveTo(w, -h * .6, w * 1.5, h * .2, 0, h); ctx.fill();
      ctx.strokeStyle = "rgba(105,126,79,.35)"; ctx.lineWidth = .8;
      ctx.beginPath(); ctx.moveTo(0, h); ctx.lineTo(0, -h); ctx.stroke();
      ctx.restore();
    }
  });
}

export function parkTurfTexture(): THREE.CanvasTexture {
  const map = texture("turf", 512, (ctx, size) => {
    const rng = mulberry32(93271);
    ctx.fillStyle = "#75874c"; ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 42000; i++) {
      const x = rng() * size, y = rng() * size;
      const light = 70 + rng() * 65;
      ctx.strokeStyle = `rgba(${light * .94},${light * 1.12},${light * .53},.45)`;
      ctx.lineWidth = .5 + rng() * .8;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + rng() * 2 - 1, y - 1 - rng() * 5); ctx.stroke();
    }
  });
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  return map;
}

export function parkStoneTexture(): THREE.CanvasTexture {
  const map = texture("stone", 512, (ctx, size) => {
    const rng = mulberry32(18476);
    ctx.fillStyle = "#716f5d"; ctx.fillRect(0, 0, size, size);
    for (let row = 0; row < 9; row++) {
      let x = row % 2 ? -42 : 0;
      while (x < size) {
        const w = 43 + rng() * 52, y = row * size / 9;
        const l = 95 + rng() * 58;
        ctx.fillStyle = `rgb(${l * 1.06},${l * 1.02},${l * .89})`;
        ctx.beginPath(); ctx.roundRect(x + 2, y + 2, w - 4, size / 9 - 4, 4 + rng() * 5); ctx.fill();
        ctx.strokeStyle = "rgba(226,220,190,.2)"; ctx.lineWidth = 2; ctx.stroke();
        x += w;
      }
    }
    for (let i = 0; i < 32000; i++) {
      ctx.fillStyle = rng() > .5 ? "rgba(26,32,22,.1)" : "rgba(244,237,210,.12)";
      ctx.fillRect(rng() * size, rng() * size, 1 + rng() * 2, 1 + rng() * 2);
    }
  });
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  return map;
}

/** Fine aggregate shared by the paths; world-space UVs keep grain at human scale. */
export function parkPathTexture(): THREE.CanvasTexture {
  const map = texture("path", 256, (ctx, size) => {
    const rng = mulberry32(8042);
    ctx.fillStyle = "#dedbd4";
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 24000; i++) {
      const light = 130 + rng() * 115;
      ctx.fillStyle = `rgba(${light},${light},${light},.4)`;
      ctx.fillRect(rng() * size, rng() * size, .5 + rng() * 1.3, .5 + rng() * 1.3);
    }
  });
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  return map;
}
