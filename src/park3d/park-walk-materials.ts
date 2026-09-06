import * as THREE from 'three';
import { mulberry32 } from '../ui/tree/spec';
import { parkPathTexture } from './park-materials';
import type { ParkWalk } from './park-walks';

type WalkTexture = 'aggregate' | 'pavers' | 'earth' | 'mulch' | 'boards';
export interface WalkSurface { texture: WalkTexture; color: number; hardEdge: boolean }

/** Surface tags determine the material family. Untagged routes keep the
 * earlier neutral finish; the exact paver sizes/grain are interpretations. */
export function walkSurface(line: ParkWalk): WalkSurface {
  if (line.surface === 'wood') return { texture: 'boards', color: 0x9a8a6e, hardEdge: false };
  if (['woodchips', 'mulch'].includes(line.surface ?? '')) return { texture: 'mulch', color: 0x857157, hardEdge: false };
  if (['dirt', 'unpaved', 'compacted', 'fine_gravel'].includes(line.surface ?? '')) {
    return { texture: 'earth', color: line.surface === 'fine_gravel' ? 0xa49b85 : 0x94846b, hardEdge: false };
  }
  if (['paving_stones', 'pebblestone'].includes(line.surface ?? '')) return { texture: 'pavers', color: 0xaaa294, hardEdge: true };
  if (line.surface === 'asphalt') return { texture: 'aggregate', color: 0x797b76, hardEdge: true };
  if (line.surface === 'concrete' || line.kind === 'steps') return { texture: 'aggregate', color: 0xa09a8b, hardEdge: true };
  if (line.surface === 'rock' || line.surface === 'stone') return { texture: 'earth', color: 0x989689, hardEdge: false };
  return { texture: 'aggregate', color: line.width > 5.5 ? 0x716f6b : 0x958e85, hardEdge: true };
}

const textures = new Map<WalkTexture, THREE.CanvasTexture>();
function surfaceTexture(kind: WalkTexture): THREE.CanvasTexture {
  if (kind === 'aggregate') return parkPathTexture();
  const cached = textures.get(kind); if (cached) return cached;
  const size = 512, canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!, rng = mulberry32(kind === 'pavers' ? 91877 : kind === 'mulch' ? 71193 : 34491);
  ctx.fillStyle = kind === 'pavers' ? '#a6a49e' : '#d0ccc1'; ctx.fillRect(0, 0, size, size);
  if (kind === 'pavers') {
    // Low-contrast joints and rounded worn edges. The 2 m tile contains four
    // half-metre courses across, without high-contrast baked lighting.
    const rowHeight = size / 6, width = size / 4;
    for (let row = 0; row < 6; row++) for (let col = -1; col <= 4; col++) {
      const x = col * width + row % 2 * width / 2, y = row * rowHeight, tone = 210 + rng() * 16;
      ctx.fillStyle = `rgb(${tone},${tone},${tone * .98})`;
      ctx.beginPath(); ctx.roundRect(x + 1.5, y + 1.5, width - 3, rowHeight - 3, 2); ctx.fill();
      ctx.strokeStyle = 'rgba(248,244,232,.18)'; ctx.lineWidth = 1; ctx.stroke();
    }
  } else if (kind === 'boards') {
    for (let plank = 0; plank < 12; plank++) {
      const x = plank * size / 12, tone = 202 + rng() * 24;
      ctx.fillStyle = `rgb(${tone},${tone},${tone * .96})`; ctx.fillRect(x + 1.5, 0, size / 12 - 3, size);
      for (let grain = 0; grain < 9; grain++) {
        ctx.strokeStyle = 'rgba(86,80,69,.1)'; ctx.lineWidth = .7;
        const gx = x + 3 + rng() * (size / 12 - 6);
        ctx.beginPath(); ctx.moveTo(gx, 0); ctx.bezierCurveTo(gx - 2, size / 3, gx + 2, size * 2 / 3, gx, size); ctx.stroke();
      }
    }
  }
  for (let i = 0; i < (kind === 'mulch' ? 7500 : 30000); i++) {
    const x = rng() * size, y = rng() * size, light = 125 + rng() * 120;
    ctx.fillStyle = `rgba(${light},${light},${light * .96},${kind === 'mulch' ? .55 : .25})`;
    if (kind === 'mulch') {
      ctx.save(); ctx.translate(x, y); ctx.rotate(rng() * Math.PI);
      ctx.fillRect(-1, -3, 1 + rng() * 2, 3 + rng() * 7); ctx.restore();
    } else {
      const r = .4 + rng() * (kind === 'earth' ? 2.2 : 1);
      ctx.beginPath(); ctx.ellipse(x, y, r, r * .65, rng() * Math.PI, 0, Math.PI * 2); ctx.fill();
    }
  }
  const map = new THREE.CanvasTexture(canvas); map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping; map.anisotropy = 8; textures.set(kind, map); return map;
}

export function walkMaterial(kind: WalkTexture): THREE.MeshStandardMaterial {
  const map = typeof document === 'undefined' ? null : surfaceTexture(kind);
  return new THREE.MeshStandardMaterial({ vertexColors: true, map, bumpMap: map,
    bumpScale: kind === 'mulch' ? .035 : kind === 'pavers' ? .018 : .025, roughness: .95 });
}
