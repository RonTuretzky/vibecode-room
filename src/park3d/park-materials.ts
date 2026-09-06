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

/** A rounded spray of broad leaves, with gaps that survive mipmapping. */
export function parkFoliageTexture(): THREE.CanvasTexture {
  return texture("foliage", 256, (ctx) => {
    const rng = mulberry32(7291);
    for (let branch = 0; branch < 7; branch++) {
      const angle = -Math.PI + .32 + branch * (Math.PI - .64) / 6;
      const bx = 128, by = 220 - Math.abs(branch - 3) * 12;
      const reach = Math.min(134 + rng() * 45, 100 / Math.max(.05, Math.abs(Math.cos(angle))));
      const dx = Math.cos(angle) * reach, dy = Math.sin(angle) * reach;
      ctx.strokeStyle = "#8b9170"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(bx, by); ctx.quadraticCurveTo(bx + dx * .55, by + dy * .3, bx + dx, by + dy); ctx.stroke();
      for (let i = 0; i < 8; i++) {
        const t = .25 + i * .095, side = i % 2 ? 1 : -1;
        const x = bx + dx * t - Math.sin(angle) * side * 13;
        const y = by + dy * t + Math.cos(angle) * side * 13;
        ctx.save(); ctx.translate(x, y); ctx.rotate(angle + Math.PI / 2 + side * .7);
        const w = 8 + rng() * 4, h = 13 + rng() * 6;
        const shade = ctx.createLinearGradient(-w, 0, w, 0);
        shade.addColorStop(0, "#aabb87"); shade.addColorStop(.5, "#e0e9af"); shade.addColorStop(1, "#bdcf94");
        ctx.fillStyle = shade;
        ctx.beginPath(); ctx.moveTo(0, h);
        ctx.bezierCurveTo(-w * 1.3, h * .35, -w, -h * .65, 0, -h);
        ctx.bezierCurveTo(w, -h * .65, w * 1.3, h * .35, 0, h); ctx.fill();
        ctx.strokeStyle = "rgba(100,123,68,.25)"; ctx.lineWidth = .65;
        ctx.beginPath(); ctx.moveTo(0, h); ctx.lineTo(0, -h * .8); ctx.stroke();
        ctx.restore();
      }
    }
  });
}

/** Thin-leaf diffuse response, reusing the already shadowed direct light.
 * No extra render target, transmission pass, or unshadowed emissive glow. */
export function parkLeafMaterial(color = 0xffffff, map: THREE.Texture = parkFoliageTexture()): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ map, color,
    alphaTest: .25, alphaToCoverage: true, side: THREE.DoubleSide, roughness: .92 });
  material.onBeforeCompile = shader => {
    const physical = THREE.ShaderChunk.lights_physical_pars_fragment.replace(
      "reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution );",
      `float leafCosine = dot( geometryNormal, directLight.direction );
       float leafDiffuse = max( 0.0, ( leafCosine + 0.3 ) / 1.3 ) * 0.86
         + max( 0.0, -leafCosine ) * 0.18;
       reflectedLight.directDiffuse += leafDiffuse * directLight.color * BRDF_Lambert( material.diffuseContribution );`,
    );
    shader.fragmentShader = shader.fragmentShader.replace("#include <lights_physical_pars_fragment>", physical);
  };
  material.customProgramCacheKey = () => "park-leaf-wrap-v1";
  return material;
}

/** Neutral fine detail: grass/soil hue comes from linear terrain colors. */
export function parkGroundDetailTexture(): THREE.CanvasTexture {
  const map = texture("ground-detail", 512, (ctx, size) => {
    const rng = mulberry32(39121);
    ctx.fillStyle = "#deded6"; ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 38000; i++) {
      const x = rng() * size, y = rng() * size, light = 160 + rng() * 85;
      ctx.strokeStyle = `rgba(${light},${light},${light * .96},.32)`;
      ctx.lineWidth = .5 + rng() * .8;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + rng() * 2 - 1, y - 1 - rng() * 4); ctx.stroke();
    }
  });
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  return map;
}

/** Ten courses of running-bond masonry in a 2.4 × .8 m UV tile. Neutral
 * mineral grain lets the landmark material supply its orange brick hue. */
export function parkBrickTexture(): THREE.CanvasTexture {
  const map = texture('arsenal-brick', 512, (ctx, size) => {
    const rng = mulberry32(1851), course = size / 10;
    ctx.fillStyle = '#a6a395'; ctx.fillRect(0, 0, size, size);
    for (let row = 0; row < 10; row++) for (let col = -1; col < 11; col++) {
      const x = (col + (row % 2) * .5) * course, y = row * course;
      const tone = 190 + rng() * 40;
      ctx.fillStyle = `rgb(${tone},${tone * .97},${tone * .9})`;
      ctx.fillRect(x + 2, y + 3, course - 4, course - 6);
    }
    for (let i = 0; i < 21000; i++) {
      ctx.fillStyle = rng() < .5 ? 'rgba(255,246,225,.1)' : 'rgba(72,63,49,.1)';
      ctx.fillRect(rng() * size, rng() * size, 1 + rng() * 2, 1 + rng() * 2);
    }
  });
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  return map;
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
    ctx.fillStyle = "#817e70"; ctx.fillRect(0, 0, size, size);
    const courses = [50, 62, 58, 71, 61, 54, 81, 75];
    let y = 0;
    for (const height of courses) {
      let x = -rng() * 65;
      while (x < size) {
        const w = 43 + rng() * 58, l = 137 + rng() * 22;
        const bevel = 3 + rng() * 4;
        ctx.fillStyle = `rgb(${l * 1.04},${l * 1.01},${l * .91})`;
        ctx.beginPath();
        ctx.moveTo(x + bevel, y + 2); ctx.lineTo(x + w - bevel, y + 2 + rng() * 3);
        ctx.lineTo(x + w - 2, y + bevel); ctx.lineTo(x + w - 3, y + height - bevel);
        ctx.lineTo(x + w - bevel, y + height - 2); ctx.lineTo(x + bevel, y + height - 2 - rng() * 3);
        ctx.lineTo(x + 2, y + height - bevel); ctx.lineTo(x + 2, y + bevel); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = "rgba(214,210,191,.18)"; ctx.lineWidth = 1.2; ctx.stroke();
        x += w;
      }
      y += height;
    }
    // Overlapping translucent mineral/moss stains span the joints, so stone
    // variation reads as weathering instead of a high-contrast checkerboard.
    for (let i = 0; i < 65; i++) {
      const x = rng() * size, y = rng() * size, r = 12 + rng() * 42;
      const wash = ctx.createRadialGradient(x, y, 0, x, y, r);
      wash.addColorStop(0, i % 3 ? "rgba(73,81,51,.13)" : "rgba(228,222,196,.12)");
      wash.addColorStop(1, "rgba(90,93,62,0)"); ctx.fillStyle = wash;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
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
  const map = texture("path", 1024, (ctx, size) => {
    const rng = mulberry32(8042);
    ctx.fillStyle = "#dedbd4";
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 260000; i++) {
      const light = 130 + rng() * 115;
      ctx.fillStyle = `rgba(${light},${light},${light},.4)`;
      ctx.fillRect(rng() * size, rng() * size, .5 + rng() * 1.3, .5 + rng() * 1.3);
    }
  });
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  return map;
}

/** Quiet rolled-roof grain; the architectural details supply real shadows. */
export function parkRoofTexture(): THREE.CanvasTexture {
  const map = texture('roof', 512, (ctx, size) => {
    const rng = mulberry32(76815);
    ctx.fillStyle = '#d5d4cd'; ctx.fillRect(0, 0, size, size);
    for (let strip = 0; strip < 4; strip++) {
      const tone = 203 + rng() * 16;
      ctx.fillStyle = `rgb(${tone},${tone},${tone * .98})`; ctx.fillRect(strip * 128, 0, 128, size);
      ctx.fillStyle = 'rgba(91,96,92,.13)'; ctx.fillRect(strip * 128, 0, 2, size);
    }
    for (let i = 0; i < 22000; i++) {
      ctx.fillStyle = rng() > .5 ? 'rgba(250,248,240,.16)' : 'rgba(58,62,57,.12)';
      ctx.fillRect(rng() * size, rng() * size, .6 + rng(), .6 + rng());
    }
  });
  map.wrapS = map.wrapT = THREE.RepeatWrapping; return map;
}
