import * as THREE from 'three';
import { parkWalkTexture } from './park-walk-textures';
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

export function walkMaterial(kind: WalkTexture): THREE.MeshStandardMaterial {
  const map = typeof document === 'undefined' ? null : parkWalkTexture(kind === 'edging' ? 'aggregate' : kind);
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
