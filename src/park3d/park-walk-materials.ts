import * as THREE from 'three';
import { mulberry32 } from '../ui/tree/spec';
import { parkPathTexture } from './park-materials';
import type { ParkWalk } from './park-walks';

type WalkTexture = 'aggregate' | 'pavers' | 'earth' | 'mulch' | 'boards' | 'edging';
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
  if (kind === 'aggregate' || kind === 'edging') return parkPathTexture();
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
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, map, bumpMap: map,
    bumpScale: kind === 'mulch' ? .02 : kind === 'pavers' ? .008 : .0025, roughness: .95 });
  material.onBeforeCompile = shader => {
    const vertex = '#include <begin_vertex>', color = '#include <color_fragment>', normals = '#include <normal_fragment_maps>';
    if (!shader.vertexShader.includes(vertex) || !shader.fragmentShader.includes(color) || !shader.fragmentShader.includes(normals)) {
      throw new Error('Three walk material shader changed');
    }
    shader.vertexShader = 'attribute vec2 parkWalkCoord; varying vec2 vParkWalkCoord; varying vec3 vParkWalkPosition;\n' + shader.vertexShader
      .replace(vertex, `${vertex}\nvParkWalkCoord = parkWalkCoord; vParkWalkPosition = position;`);
    shader.fragmentShader = `
      varying vec2 vParkWalkCoord; varying vec3 vParkWalkPosition;
      float walkHash(vec2 p) { return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
      float walkNoise(vec2 p) {
        vec2 c = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
        return mix(mix(walkHash(c),walkHash(c+vec2(1,0)),f.x),mix(walkHash(c+vec2(0,1)),walkHash(c+vec2(1,1)),f.x),f.y);
      }
    ` + shader.fragmentShader.replace(color, `${color}
      float walkVariation = walkNoise(vParkWalkPosition.xz * .42);
      diffuseColor.rgb *= .93 + .14 * walkVariation;
      float walkRelief = 0.0;
      ${kind === 'edging' ? `
        // Half-metre stone courses follow the walk through bends. Joints
        // fade at distance instead of aliasing into a bright dotted stripe.
        float phase = fract(vParkWalkCoord.x / .48);
        float jointDistance = min(phase, 1.0-phase) * .48;
        float footprint = max(fwidth(vParkWalkCoord.x), .0005);
        float detail = 1.0-smoothstep(.025,.12,footprint);
        float joint = (1.0-smoothstep(.004-footprint,.004+footprint,jointDistance)) * detail;
        float stoneTone = walkHash(vec2(floor(vParkWalkCoord.x / .48), 7.0));
        diffuseColor.rgb *= mix(.90 + stoneTone*.17, .43, joint);
        float soilEdge = (1.0-smoothstep(.012,.045,vParkWalkCoord.y + walkVariation*.014)) * detail;
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.13,.12,.087), soilEdge*.3);
        walkRelief = -joint * .003;
      ` : ''}
    `).replace(normals, `${normals}
      #ifdef USE_BUMPMAP
        normal = perturbNormalArb(-vViewPosition, normal, vec2(dFdx(walkRelief), dFdy(walkRelief)), faceDirection);
      #endif
    `);
  };
  material.customProgramCacheKey = () => `park-walk-detail-v1-${kind}`;
  return material;
}
