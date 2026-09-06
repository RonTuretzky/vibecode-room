import * as THREE from 'three';
import { mulberry32 } from '../ui/tree/spec';

export const FACADE_TILE_M = 13;
export function glassBuilding(height: number, year: number): boolean {
  // A tall prewar masonry building does not become a curtain wall simply
  // because of its height. Unknown dates retain the height-based fallback.
  return year >= 1960 || (year === 0 && height > 140);
}

interface FacadeMaps { color: THREE.CanvasTexture; relief: THREE.CanvasTexture; roughness: THREE.CanvasTexture }
const cache = new Map<boolean, FacadeMaps>();

/** Locally generated surface maps. Window glass has a recessed profile and
 * its own roughness, while the masonry stays matte. No emissive night grid. */
function facadeMaps(glass: boolean): FacadeMaps {
  const cached = cache.get(glass); if (cached) return cached;
  const canvases = Array.from({ length: 3 }, () => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 512; return canvas;
  });
  const [color, relief, rough] = canvases.map(canvas => canvas.getContext('2d')!);
  const rng = mulberry32(glass ? 67190 : 62481);
  color!.fillStyle = glass ? '#aeb9bd' : '#e4e0d5'; color!.fillRect(0, 0, 512, 512);
  relief!.fillStyle = '#b5b5b5'; relief!.fillRect(0, 0, 512, 512);
  rough!.fillStyle = glass ? '#949494' : '#eeeeee'; rough!.fillRect(0, 0, 512, 512);
  const cols = glass ? 8 : 4, cw = 512 / cols, ch = 128;
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < cols; col++) {
      const x = col * cw + (glass ? 3 : 26), y = row * ch + (glass ? 4 : 23);
      const w = glass ? cw - 6 : 76, h = glass ? 109 : 83;
      const shade = rng(), g = color!.createLinearGradient(x, y, x + w * .3, y + h);
      if (glass) {
        g.addColorStop(0, shade > .4 ? '#9eafb7' : '#879ca7');
        g.addColorStop(.42, '#708995'); g.addColorStop(1, '#a1aeb0');
      } else {
        g.addColorStop(0, '#697c84'); g.addColorStop(.65, '#465a63'); g.addColorStop(1, '#7c8989');
      }
      color!.fillStyle = g; color!.fillRect(x, y, w, h);
      relief!.fillStyle = glass ? '#737373' : '#303030'; relief!.fillRect(x, y, w, h);
      rough!.fillStyle = glass ? '#666666' : '#555555'; rough!.fillRect(x, y, w, h);
      if (!glass) {
        // Recessed reveal, pale sill, a dark head, and asymmetric shades.
        color!.fillStyle = '#97968b'; color!.fillRect(x - 3, y - 3, w + 6, 3);
        color!.fillStyle = '#f0ecdf'; color!.fillRect(x - 4, y + h, w + 8, 4);
        relief!.fillStyle = '#dddddd'; relief!.fillRect(x - 4, y + h, w + 8, 4);
        if (shade > .5) {
          color!.fillStyle = shade > .8 ? '#b0ab97' : '#87908a';
          color!.fillRect(x + 2, y + 2, w - 4, h * (.15 + rng() * .35));
        }
        for (const [mx, my, mw, mh] of [[x + w * .5 - 1.5, y, 3, h], [x, y + h * .5, w, 2]]) {
          color!.fillStyle = '#c8c7bc'; color!.fillRect(mx!, my!, mw!, mh!);
          relief!.fillStyle = '#b0b0b0'; relief!.fillRect(mx!, my!, mw!, mh!);
          rough!.fillStyle = '#adadad'; rough!.fillRect(mx!, my!, mw!, mh!);
        }
        // Narrow, low-contrast rain streaks below sills.
        const streak = color!.createLinearGradient(0, y + h + 4, 0, row * ch + ch);
        streak.addColorStop(0, 'rgba(80,77,66,.10)'); streak.addColorStop(1, 'rgba(80,77,66,0)');
        color!.fillStyle = streak; color!.fillRect(x - 1, y + h + 4, 3, ch - (y + h + 4 - row * ch));
      }
    }
    if (glass) {
      color!.fillStyle = '#8a979b'; color!.fillRect(0, row * ch + 115, 512, 10);
      rough!.fillStyle = '#b0b0b0'; rough!.fillRect(0, row * ch + 115, 512, 10);
    } else {
      color!.fillStyle = 'rgba(129,124,111,.18)'; color!.fillRect(0, row * ch, 512, 1);
    }
  }
  // Fine surface grain breaks perfectly smooth generated stone without
  // introducing large baked shadows or additional geometry.
  for (let i = 0; i < (glass ? 2500 : 16000); i++) {
    color!.fillStyle = rng() > .5 ? 'rgba(255,255,255,.06)' : 'rgba(35,38,36,.04)';
    color!.fillRect(rng() * 512, rng() * 512, 1, 1);
  }
  const maps = canvases.map((canvas, index) => {
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = index === 0 ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.anisotropy = 8;
    return texture;
  });
  const result = { color: maps[0]!, relief: maps[1]!, roughness: maps[2]! };
  cache.set(glass, result); return result;
}

export function buildingFacadeMaterial(glass: boolean, textured: boolean): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1,
    metalness: glass ? .08 : 0, envMapIntensity: glass ? 1.3 : .75 });
  if (textured && typeof document !== 'undefined') {
    const maps = facadeMaps(glass);
    material.map = maps.color; material.bumpMap = maps.relief; material.roughnessMap = maps.roughness;
    material.bumpScale = glass ? .035 : .16;
  } else material.roughness = glass ? .4 : .88;
  return material;
}
