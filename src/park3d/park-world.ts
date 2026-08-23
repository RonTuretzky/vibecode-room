// The baked open-data Central Park world (public/assets/park, produced by
// scripts/fetch-park-data.py): a NAIP leaf-on orthophoto draped over USGS
// 3DEP terrain, the tree canopy raised into real mass by a relief map
// classified from the photo, and the surrounding city extruded from NYC's
// building footprints. No proprietary content — storable, offline, and the
// same module serves the park3d page (?src=open) and the room (?env=park).
//
// Local frame: metres, +X east, +Y up, −Z north, origin at the park centre
// (see park-frame.ts). The terrain is unlit — the photograph carries its own
// sun — with the canopy's slope shading baked into vertex colours so the
// relief reads as 3D under any scene lighting; the buildings are plain
// Lambert so the host scene's light rig owns their look.

import * as THREE from "three";
import { AXIS_BEARING, DEG, PARK_CENTER, PARK_HALF_LEN, PARK_HALF_WIDTH, insidePark } from "./park-frame";
import { buildLandmarks } from "./park-landmarks";
import { loadSkylineModels, skylineSites } from "./park-models";

export interface ParkManifest {
  center: { lat: number; lon: number; surfaceHeightM: number };
  axisBearingDeg: number;
  park: { halfLen: number; halfWidth: number };
  extent: { halfEast: number; halfNorth: number };
  anchors: { sheepMeadow: { lat: number; lon: number; x: number; z: number; groundM: number } };
  ortho: { file: string; width: number; height: number; source: string };
  dem: { file: string; cols: number; rows: number; stepM: number; unitM: number };
  relief: { file: string; width: number; height: number; unitM: number };
  water: { file: string; width: number; height: number };
  lawn: { file: string; width: number; height: number };
  buildings: { file: string; count: number; unitM: number };
}

export interface ParkWorldOptions {
  // Asset base URL (default /assets/park).
  base?: string;
  // Terrain grid step in metres (default 8 — the DEM's own resolution; the
  // 2 m relief is sampled through it, so 6 sharpens crowns at ~2× the verts).
  stepM?: number;
  // Load the canopy relief map (default true). Off gives the bare
  // orthophoto drape and `canopyAt` reads 0 everywhere.
  relief?: boolean;
  // Displace the terrain by the canopy (default true). Off keeps the map
  // loaded for `canopyAt` — the room scatters real trees from it instead of
  // raising lumpy mass.
  displace?: boolean;
  // Extrude the city (default true).
  buildings?: boolean;
  // Lay reflective water over the mapped water bodies (default true).
  water?: boolean;
  // Stand the hand-built landmarks (park-landmarks.ts) on the ground
  // (default true).
  landmarks?: boolean;
  // Load the real CC-BY skyline models (the Plaza, Billionaires' Row) and
  // clear the extruded footprints under them (default true).
  models?: boolean;
  // Dress the extruded footprints in a window-grid facade texture instead
  // of flat vertex colour (default true) — boxes read as buildings.
  facades?: boolean;
  // Additional footprint-clearing discs (local metres) on top of the model
  // sites — the room clears the blocks pressing on its stage.
  clearFootprints?: { x: number; z: number; r: number }[];
  // Drop every extruded footprint INSIDE the park rectangle (default false).
  // The footprints dataset includes the park's own structures — Wollman
  // Rink, the Arsenal, the Zoo — and city-style window boxes standing in
  // the greenery read as a massive building in the middle of the park; at
  // eye level the hand-built landmarks and trees carry the park instead.
  clearParkInterior?: boolean;
  // Ground parity with the garden: drape the terrain in the garden's tiled
  // photoscan grass (crisp underfoot), tinted per-vertex by the orthophoto
  // so paths, woodland floor and lawns keep their large-scale colour. The
  // default (false) keeps the raw orthophoto — right for the aerial page.
  detailGround?: boolean;
  // Blend the surface to the anchor's ground height inside `radius`, easing
  // back to the real terrain over `feather` — the room parks its meadow disc
  // on Sheep Meadow and must not have the lawn poke through it.
  flatten?: { x: number; z: number; radius: number; feather: number };
  // Downscale the orthophoto on decode to at most this many pixels wide. The
  // bake is 4638×6417 (~160 MB of GPU memory with mips per WebGL context);
  // the room's ground-level view is fine at 2048 and runs two contexts.
  orthoMaxWidth?: number;
}

export interface ParkWorld {
  manifest: ParkManifest;
  group: THREE.Group;
  terrain: THREE.Mesh;
  buildings: THREE.Mesh | null;
  water: THREE.Mesh | null;
  // 1 where the map has water (the Lake, the Reservoir…), 0 elsewhere.
  waterAt: (x: number, z: number) => number;
  // Bare-earth height (flatten applied) at a local point.
  groundAt: (x: number, z: number) => number;
  // Surface height including the canopy relief when displaced (flatten
  // applied); equals groundAt when `displace` is off.
  heightAt: (x: number, z: number) => number;
  // Canopy height from the relief map (metres above ground, 0 = no trees),
  // independent of flatten/displace.
  canopyAt: (x: number, z: number) => number;
  // 1 where the map has open lawn (mowed bright green), 0 elsewhere.
  lawnAt: (x: number, z: number) => number;
  dispose: () => void;
}

export const PARK_ATTRIBUTION = "USDA NAIP · USGS 3DEP · NYC Open Data footprints (public domain) · water © OpenStreetMap contributors";

const loadImage = (url: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`image failed: ${url}`));
    img.src = url;
  });

// Orthophoto texture, optionally resized while decoding off the main thread
// (createImageBitmap), which also avoids the synchronous 30 MP decode the
// plain TextureLoader pays at first upload.
async function loadOrtho(url: string, width: number, height: number, maxWidth?: number): Promise<THREE.Texture> {
  if (maxWidth === undefined || maxWidth >= width || typeof createImageBitmap !== "function") {
    return new THREE.TextureLoader().loadAsync(url);
  }
  const scale = maxWidth / width;
  const bitmap = await new THREE.ImageBitmapLoader()
    .setOptions({
      // Same orientation the TextureLoader path gives (three flips images on
      // upload; bitmaps are pre-flipped here and uploaded as-is).
      imageOrientation: "flipY",
      resizeWidth: Math.round(width * scale),
      resizeHeight: Math.round(height * scale),
      resizeQuality: "high",
    })
    .loadAsync(url);
  const texture = new THREE.CanvasTexture(bitmap);
  texture.flipY = false;
  return texture;
}

// Let the frame loop (and the gesture pipeline) breathe between the heavy
// synchronous build stages.
const nextFrame = (): Promise<void> =>
  new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });

const fetchOk = async (url: string): Promise<Response> => {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${url}: HTTP ${res.status} — run scripts/fetch-park-data.py to bake the park assets`);
  }
  return res;
};

// Bilinear sampler over a row-major grid whose pixel/node centres span the
// extent; `inset` is 0 for node grids (DEM: node 0 sits ON the west edge) and
// 0.5 for pixel grids (relief: pixel 0 is centred half a cell in).
function makeSampler(
  data: ArrayLike<number>,
  cols: number,
  rows: number,
  halfEast: number,
  halfNorth: number,
  inset: number,
  scale: number,
): (x: number, z: number) => number {
  const spanCols = inset === 0 ? cols - 1 : cols;
  const spanRows = inset === 0 ? rows - 1 : rows;
  return (x, z) => {
    const u = Math.min(cols - 1.001, Math.max(0, ((x + halfEast) / (2 * halfEast)) * spanCols - inset));
    const v = Math.min(rows - 1.001, Math.max(0, ((z + halfNorth) / (2 * halfNorth)) * spanRows - inset));
    const i = Math.floor(u);
    const j = Math.floor(v);
    const fu = u - i;
    const fv = v - j;
    const i1 = Math.min(cols - 1, i + 1);
    const j1 = Math.min(rows - 1, j + 1);
    return (
      (data[j * cols + i] * (1 - fu) * (1 - fv) +
        data[j * cols + i1] * fu * (1 - fv) +
        data[j1 * cols + i] * (1 - fu) * fv +
        data[j1 * cols + i1] * fu * fv) *
      scale
    );
  };
}

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

// Deterministic per-building variation.
const hash01 = (n: number): number => {
  let h = (n * 2654435761) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519) >>> 0;
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
};

// Facade palettes: pre-war Manhattan is limestone, brownstone and brick;
// mid-century is beige and grey masonry; the towers are glass.
const PREWAR = [0xcfc2ad, 0x9a7561, 0xa86a55, 0xb89b78, 0xc4b59c];
const MIDCENTURY = [0xb7b2a8, 0xa8a39a, 0x9e9b93, 0xc0b8aa];
const GLASS = [0x8fa6b8, 0x7f95a8, 0xa3b4c2, 0x6f8799, 0x9fb3c4];

function facadeTone(year: number, height: number, seed: number): THREE.Color {
  let palette: number[];
  if (height > 150 || year >= 1990) {
    palette = GLASS;
  } else if (year !== 0 && year < 1945) {
    palette = PREWAR;
  } else if (year === 0 && height < 45) {
    palette = PREWAR;
  } else {
    palette = MIDCENTURY;
  }
  const tone = new THREE.Color(palette[Math.floor(hash01(seed) * palette.length)]);
  // ±8% brightness jitter so rows of identical brownstones don't band.
  return tone.multiplyScalar(0.92 + hash01(seed + 7919) * 0.16);
}

export async function loadParkWorld(opts: ParkWorldOptions = {}): Promise<ParkWorld> {
  const base = opts.base ?? "/assets/park";
  const manifest = (await (await fetchOk(`${base}/manifest.json`)).json()) as ParkManifest;
  if (
    Math.abs(manifest.center.lat - PARK_CENTER.lat) > 1e-6 ||
    Math.abs(manifest.center.lon - PARK_CENTER.lon) > 1e-6 ||
    Math.abs(manifest.axisBearingDeg * DEG - AXIS_BEARING) > 1e-6 ||
    manifest.park.halfLen !== PARK_HALF_LEN ||
    manifest.park.halfWidth !== PARK_HALF_WIDTH
  ) {
    console.warn("park manifest frame differs from park-frame.ts — crop/presets may be offset; re-run the bake", manifest);
  }
  const { halfEast, halfNorth } = manifest.extent;

  const [demBuffer, reliefImage, waterImage, lawnImage, orthoTexture, buildingsJson] = await Promise.all([
    fetchOk(`${base}/${manifest.dem.file}`).then((r) => r.arrayBuffer()),
    opts.relief === false ? null : loadImage(`${base}/${manifest.relief.file}`),
    opts.water === false ? null : loadImage(`${base}/${manifest.water.file}`),
    opts.relief === false ? null : loadImage(`${base}/${manifest.lawn.file}`),
    loadOrtho(`${base}/${manifest.ortho.file}`, manifest.ortho.width, manifest.ortho.height, opts.orthoMaxWidth),
    opts.buildings === false
      ? null
      : fetchOk(`${base}/${manifest.buildings.file}`).then((r) => r.json() as Promise<{ buildings: [number, number, number, number[]][] }>),
  ]);

  // ── samplers ────────────────────────────────────────────────────────────
  const dem = new Int16Array(demBuffer);
  if (dem.length !== manifest.dem.cols * manifest.dem.rows) {
    throw new Error(`dem.bin has ${dem.length} cells, manifest says ${manifest.dem.cols}x${manifest.dem.rows}`);
  }
  const sampleDem = makeSampler(dem, manifest.dem.cols, manifest.dem.rows, halfEast, halfNorth, 0, manifest.dem.unitM);

  // 8-bit map → bilinear sampler over the frame (pixel-centred grid).
  const maskSampler = (image: HTMLImageElement | null, unit: number): ((x: number, z: number) => number) => {
    if (image === null) {
      return () => 0;
    }
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(image, 0, 0);
    const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const red = new Uint8Array(canvas.width * canvas.height);
    for (let i = 0; i < red.length; i++) {
      red[i] = rgba[i * 4];
    }
    return makeSampler(red, canvas.width, canvas.height, halfEast, halfNorth, 0.5, unit);
  };
  const sampleRelief = maskSampler(reliefImage, manifest.relief.unitM);
  const sampleWater = maskSampler(waterImage, 1 / 255);
  const sampleLawn = maskSampler(lawnImage, 1 / 255);

  const flatten = opts.flatten;
  const anchorGround = flatten === undefined ? 0 : sampleDem(flatten.x, flatten.z);
  // 0 inside the flattened disc, 1 on the untouched terrain.
  const terrainWeight = (x: number, z: number): number => {
    if (flatten === undefined) {
      return 1;
    }
    const d = Math.hypot(x - flatten.x, z - flatten.z);
    return smoothstep(flatten.radius, flatten.radius + flatten.feather, d);
  };
  const groundAt = (x: number, z: number): number => {
    const w = terrainWeight(x, z);
    return w === 1 ? sampleDem(x, z) : anchorGround + (sampleDem(x, z) - anchorGround) * w;
  };
  const displace = opts.displace !== false;
  const heightAt = (x: number, z: number): number => {
    if (!displace) {
      return groundAt(x, z);
    }
    const w = terrainWeight(x, z);
    const h = sampleDem(x, z) + sampleRelief(x, z);
    return w === 1 ? h : anchorGround + (h - anchorGround) * w;
  };

  // ── terrain ─────────────────────────────────────────────────────────────
  await nextFrame();
  const step = opts.stepM ?? manifest.dem.stepM;
  const segsX = Math.ceil((2 * halfEast) / step);
  const segsZ = Math.ceil((2 * halfNorth) / step);
  const geometry = new THREE.PlaneGeometry(2 * halfEast, 2 * halfNorth, segsX, segsZ);
  // Plane XY → world XZ with −Z north: plane +Y (north, texture row 0 after
  // three's default flipY) lands on −Z.
  geometry.rotateX(-Math.PI / 2);
  const pos = geometry.getAttribute("position") as THREE.BufferAttribute;
  const reliefAt = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const w = terrainWeight(x, z);
    reliefAt[i] = displace ? sampleRelief(x, z) * w : 0;
    pos.setY(i, heightAt(x, z));
  }
  await nextFrame();
  geometry.computeVertexNormals();
  // Bake the canopy's slope shading: a fixed afternoon sun from the
  // south-west, normalised so flat ground keeps the photo's own exposure and
  // only the raised crowns gain light/shade.
  const sun = new THREE.Vector3(-0.45, 0.75, 0.45).normalize();
  const nrm = geometry.getAttribute("normal") as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const flatShade = 0.55 + 0.45 * sun.y;
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    n.fromBufferAttribute(nrm, i);
    let shade = 1;
    if (reliefAt[i] > 0.05) {
      shade = (0.55 + 0.45 * Math.max(0, n.dot(sun))) / flatShade;
      // Crown tops read lighter than the shaded gaps between trees.
      shade *= 0.86 + 0.14 * Math.min(1, reliefAt[i] / 18);
      shade = Math.min(1.2, Math.max(0.5, shade));
    }
    colors[i * 3] = shade;
    colors[i * 3 + 1] = shade;
    colors[i * 3 + 2] = shade;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  if (opts.detailGround !== true) {
    // The normals only served the bake above — the unlit photo material
    // never reads them, so don't ship 400k of them to the GPU. The lit
    // detail-ground material DOES need them.
    geometry.deleteAttribute("normal");
  }
  geometry.computeBoundingSphere();

  orthoTexture.colorSpace = THREE.SRGBColorSpace;
  orthoTexture.anisotropy = 8;
  let terrainMaterial: THREE.Material;
  if (opts.detailGround === true) {
    // Tint each vertex from a small readback of the photo, then let the
    // garden's tiled grass carry the surface detail. Lifted toward the
    // meadow's brightness so the room's stage and the park ground match.
    const sampleCanvas = document.createElement("canvas");
    const sw = 512;
    const sh = Math.round((sw * manifest.ortho.height) / manifest.ortho.width);
    sampleCanvas.width = sw;
    sampleCanvas.height = sh;
    const sctx = sampleCanvas.getContext("2d", { willReadFrequently: true })!;
    // loadOrtho may hand back a pre-flipped ImageBitmap (flipY=false) — keep
    // orientation consistent: row 0 of the DRAWN canvas must be north.
    const image = orthoTexture.image as CanvasImageSource;
    if (orthoTexture.flipY) {
      sctx.drawImage(image, 0, 0, sw, sh);
    } else {
      sctx.translate(0, sh);
      sctx.scale(1, -1);
      sctx.drawImage(image, 0, 0, sw, sh);
      sctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    const rgba = sctx.getImageData(0, 0, sw, sh).data;
    // The garden disc's tint — lawns pull toward it so the stage never sits
    // on a differently-green island.
    const meadowTint = new THREE.Color(0xaef29a);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const px = Math.min(sw - 1, Math.max(0, Math.round(((x + halfEast) / (2 * halfEast)) * sw)));
      const py = Math.min(sh - 1, Math.max(0, Math.round(((z + halfNorth) / (2 * halfNorth)) * sh)));
      const o = (py * sw + px) * 4;
      const t = sampleLawn(x, z) * 0.6;
      colors[i * 3] *= Math.min(1, (rgba[o] / 255) * 2.1) * (1 - t) + meadowTint.r * t;
      colors[i * 3 + 1] *= Math.min(1, (rgba[o + 1] / 255) * 2.1) * (1 - t) + meadowTint.g * t;
      colors[i * 3 + 2] *= Math.min(1, (rgba[o + 2] / 255) * 2.1) * (1 - t) + meadowTint.b * t;
    }
    (geometry.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
    const texLoader = new THREE.TextureLoader();
    const repeat = { x: (2 * halfEast) / 10, y: (2 * halfNorth) / 10 };
    const groundDiff = texLoader.load("/assets/garden/ground/aerial_grass_rock_diff_1k.jpg");
    groundDiff.wrapS = THREE.RepeatWrapping;
    groundDiff.wrapT = THREE.RepeatWrapping;
    groundDiff.repeat.set(repeat.x, repeat.y);
    groundDiff.colorSpace = THREE.SRGBColorSpace;
    groundDiff.anisotropy = 8;
    const groundNor = texLoader.load("/assets/garden/ground/aerial_grass_rock_nor_1k.jpg");
    groundNor.wrapS = THREE.RepeatWrapping;
    groundNor.wrapT = THREE.RepeatWrapping;
    groundNor.repeat.set(repeat.x, repeat.y);
    groundNor.anisotropy = 8;
    terrainMaterial = new THREE.MeshStandardMaterial({
      map: groundDiff,
      normalMap: groundNor,
      vertexColors: true,
      roughness: 1,
      metalness: 0,
    });
    // The photo no longer drapes the ground; release it.
    orthoTexture.dispose();
  } else {
    terrainMaterial = new THREE.MeshBasicMaterial({ map: orthoTexture, vertexColors: true });
  }
  const terrain = new THREE.Mesh(geometry, terrainMaterial);
  terrain.name = "park-terrain";

  const group = new THREE.Group();
  group.name = "park-world";
  group.add(terrain);

  // ── water ───────────────────────────────────────────────────────────────
  // Flat reflective sheets over the mapped water, a hand above the photo
  // (the DEM already sits at the water surface over lakes). Built on its own
  // 4 m grid so shorelines stay crisp whatever the terrain step.
  let water: THREE.Mesh | null = null;
  if (waterImage !== null) {
    await nextFrame();
    water = buildWater(sampleWater, groundAt, halfEast, halfNorth, 4);
    if (water !== null) {
      group.add(water);
    }
  }

  if (opts.landmarks !== false) {
    group.add(buildLandmarks(groundAt));
  }

  // ── buildings ───────────────────────────────────────────────────────────
  const models = opts.models !== false;
  let buildings: THREE.Mesh | null = null;
  if (buildingsJson !== null) {
    await nextFrame();
    buildings = buildBuildings(buildingsJson.buildings, manifest.buildings.unitM, groundAt, {
      facades: opts.facades !== false,
      exclude: [...(models ? skylineSites() : []), ...(opts.clearFootprints ?? [])],
      excludeInsidePark: opts.clearParkInterior === true,
    });
    group.add(buildings);
  }
  if (models) {
    // Async on top of the resolved world: the scene stands while the six
    // glbs stream in.
    loadSkylineModels(groundAt)
      .then((skyline) => group.add(skyline))
      .catch((error: unknown) => console.warn("skyline models failed to load; extruded city only", error));
  }

  return {
    manifest,
    group,
    terrain,
    buildings,
    water,
    groundAt,
    heightAt,
    canopyAt: sampleRelief,
    lawnAt: sampleLawn,
    waterAt: sampleWater,
    dispose: () => {
      geometry.dispose();
      const tm = terrain.material as THREE.MeshStandardMaterial;
      tm.map?.dispose();
      tm.normalMap?.dispose();
      tm.dispose();
      orthoTexture.dispose();
      if (buildings !== null) {
        buildings.geometry.dispose();
        for (const m of Array.isArray(buildings.material) ? buildings.material : [buildings.material]) {
          m.dispose();
        }
      }
      group.getObjectByName("park-skyline")?.traverse((node) => {
        if (node instanceof THREE.Mesh) {
          node.geometry.dispose();
          for (const m of Array.isArray(node.material) ? node.material : [node.material]) {
            m.dispose();
          }
        }
      });
      if (water !== null) {
        water.geometry.dispose();
        (water.material as THREE.Material).dispose();
      }
      group.getObjectByName("park-landmarks")?.traverse((node) => {
        if (node instanceof THREE.Mesh) {
          node.geometry.dispose();
          (node.material as THREE.Material).dispose();
        }
      });
      group.removeFromParent();
    },
  };
}

// One quad per water cell, merged. Glossy standard material: the host scene
// may hand it an envMap (the room gives it the sky panorama) so the Lake
// mirrors the clouds; without one it still catches the sun.
export function buildWater(
  waterAt: (x: number, z: number) => number,
  groundAt: (x: number, z: number) => number,
  halfEast: number,
  halfNorth: number,
  cell: number,
): THREE.Mesh | null {
  const cols = Math.ceil((2 * halfEast) / cell);
  const rows = Math.ceil((2 * halfNorth) / cell);
  // Which cells are water, then one LEVEL per connected body: lidar DEMs
  // slope and ripple over lakes, and a sheet that follows them reads as a
  // staircase. Each body takes its 20th-percentile ground height (the
  // true surface sits low in the noise).
  const isWater = new Uint8Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      if (waterAt(-halfEast + (i + 0.5) * cell, -halfNorth + (j + 0.5) * cell) >= 0.5) {
        isWater[j * cols + i] = 1;
      }
    }
  }
  const level = new Float32Array(cols * rows);
  const label = new Int32Array(cols * rows).fill(-1);
  const stack: number[] = [];
  let bodies = 0;
  for (let seed = 0; seed < isWater.length; seed++) {
    if (isWater[seed] === 0 || label[seed] !== -1) {
      continue;
    }
    const cells: number[] = [];
    stack.push(seed);
    label[seed] = bodies;
    while (stack.length > 0) {
      const c = stack.pop()!;
      cells.push(c);
      const ci = c % cols;
      const cj = (c - ci) / cols;
      for (const [di, dj] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const ni = ci + di;
        const nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) {
          continue;
        }
        const n = nj * cols + ni;
        if (isWater[n] === 1 && label[n] === -1) {
          label[n] = bodies;
          stack.push(n);
        }
      }
    }
    const heights = cells.map((c) => groundAt(-halfEast + ((c % cols) + 0.5) * cell, -halfNorth + (Math.floor(c / cols) + 0.5) * cell));
    heights.sort((a, b) => a - b);
    const surface = heights[Math.floor(heights.length * 0.2)];
    for (const c of cells) {
      level[c] = surface;
    }
    bodies++;
  }
  const positions: number[] = [];
  const index: number[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      if (isWater[j * cols + i] === 0) {
        continue;
      }
      const x0 = -halfEast + i * cell;
      const z0 = -halfNorth + j * cell;
      const y = level[j * cols + i] + 0.25;
      const v = positions.length / 3;
      positions.push(x0, y, z0, x0 + cell, y, z0, x0 + cell, y, z0 + cell, x0, y, z0 + cell);
      // Counter-clockwise from above (+Y): (x0,z0) → (x0,z1) → (x1,z1) …
      index.push(v, v + 3, v + 2, v, v + 2, v + 1);
    }
  }
  if (positions.length === 0) {
    return null;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  const normals = new Float32Array(positions.length);
  for (let i = 1; i < normals.length; i += 3) {
    normals[i] = 1;
  }
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.setIndex(index);
  geometry.computeBoundingSphere();
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ color: 0x6d8f96, roughness: 0.12, metalness: 0.35 }),
  );
  mesh.name = "park-water";
  return mesh;
}

// Page-lifetime shared world (the garden-flora pattern): the room rebuilds
// its environment on every garden↔orbit or layout switch, and re-fetching
// 9 MB plus rebuilding 1.4M vertices each time is wasteful — so the world is
// memoised per option set and its `dispose` only detaches it. GPU memory is
// held for the page, exactly like the flora cache.
const sharedWorlds = new Map<string, Promise<ParkWorld>>();

export function loadParkWorldShared(opts: ParkWorldOptions = {}): Promise<ParkWorld> {
  const key = JSON.stringify(opts);
  let promise = sharedWorlds.get(key);
  if (promise === undefined) {
    promise = loadParkWorld(opts).then((world) => ({
      ...world,
      dispose: () => {
        world.group.removeFromParent();
      },
    }));
    // A failed load must not poison the page: let the next build retry.
    promise.catch(() => sharedWorlds.delete(key));
    sharedWorlds.set(key, promise);
  }
  return promise;
}

// One indexed mesh for the whole city: per building, a quad per footprint
// edge (own normals, so the facades shade as flat faces) and an ear-clipped
// roof. Vertex colours carry the facade tone with a darker base (cheap
// ambient occlusion from the street canyon).
export interface BuildBuildingsOptions {
  facades?: boolean;
  exclude?: { x: number; z: number; r: number }[];
  excludeInsidePark?: boolean;
}

export function buildBuildings(
  rows: [number, number, number, number[]][],
  unit: number,
  groundAt: (x: number, z: number) => number,
  opts: BuildBuildingsOptions = {},
): THREE.Mesh {
  let vertexCount = 0;
  let indexCount = 0;
  for (const [, , , ring] of rows) {
    const n = ring.length / 2;
    vertexCount += 4 * n + n;
    indexCount += 6 * n + 3 * (n - 2);
  }
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const wallIndex: number[] = [];
  const roofIndex: number[] = [];
  let v = 0;
  const roofGrey = new THREE.Color(0x8c8c8c);
  const contour: THREE.Vector2[] = [];
  const exclude = opts.exclude ?? [];
  // One facade tile = FACADE_TILE_M metres of wall in both directions.

  const put = (x: number, y: number, z: number, nx: number, ny: number, nz: number, c: THREE.Color, shade: number, u: number, w: number): number => {
    positions[v * 3] = x;
    positions[v * 3 + 1] = y;
    positions[v * 3 + 2] = z;
    normals[v * 3] = nx;
    normals[v * 3 + 1] = ny;
    normals[v * 3 + 2] = nz;
    colors[v * 3] = c.r * shade;
    colors[v * 3 + 1] = c.g * shade;
    colors[v * 3 + 2] = c.b * shade;
    uvs[v * 2] = u;
    uvs[v * 2 + 1] = w;
    return v++;
  };

  rows.forEach(([hUnits, , year, ringUnits], b) => {
    const n = ringUnits.length / 2;
    const xs = new Float64Array(n);
    const zs = new Float64Array(n);
    let area = 0;
    for (let i = 0; i < n; i++) {
      xs[i] = ringUnits[i * 2] * unit;
      zs[i] = ringUnits[i * 2 + 1] * unit;
    }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      area += xs[i] * zs[j] - xs[j] * zs[i];
    }
    // Positive shoelace in (x, z) is clockwise seen from above (+Y); the
    // roof and the outward wall normals below assume counter-clockwise.
    if (area > 0) {
      xs.reverse();
      zs.reverse();
    }
    let cx0 = 0;
    let cz0 = 0;
    for (let i = 0; i < n; i++) {
      cx0 += xs[i] / n;
      cz0 += zs[i] / n;
    }
    if (
      (opts.excludeInsidePark === true && insidePark(cx0, cz0, -6)) ||
      exclude.some((site) => (site.x - cx0) ** 2 + (site.z - cz0) ** 2 < site.r * site.r)
    ) {
      // A real model stands here — pad the reserved index slots with
      // degenerate triangles so the preallocated buffers stay dense.
      const a = put(0, -1000, 0, 0, 1, 0, roofGrey, 1, 0, 0);
      for (let k = 0; k < 6 * n; k++) {
        wallIndex.push(a);
      }
      for (let k = 0; k < 3 * (n - 2); k++) {
        roofIndex.push(a);
      }
      return;
    }
    const height = Math.max(3, hUnits * unit);
    // With a facade texture the near-white tile multiplies the tone; undim
    // it and sun-facing walls blow out to paper.
    const toneScale = opts.facades !== false ? 0.78 : 1;
    let base = Infinity;
    for (let i = 0; i < n; i++) {
      base = Math.min(base, groundAt(xs[i], zs[i]));
    }
    // Sink slightly so sloped lots never show a floating slab edge.
    base -= 0.4;
    const top = base + height;
    const tone = facadeTone(year, height, b + 1).multiplyScalar(toneScale);
    const roof = tone.clone().lerp(roofGrey, 0.5).multiplyScalar(0.9 / Math.max(toneScale, 0.01));

    let run = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const dx = xs[j] - xs[i];
      const dz = zs[j] - zs[i];
      const len = Math.hypot(dx, dz) || 1;
      // Counter-clockwise from above: outward is the right-hand side.
      const nx = -dz / len;
      const nz = dx / len;
      // Facade UVs run in wall-metres (u along the ring so window columns
      // never stretch, v vertically from the base).
      const u0 = run / FACADE_TILE_M;
      const u1 = (run + len) / FACADE_TILE_M;
      const v1 = height / FACADE_TILE_M;
      run += len;
      const a = put(xs[i], base, zs[i], nx, 0, nz, tone, 0.78, u0, 0);
      const c = put(xs[j], base, zs[j], nx, 0, nz, tone, 0.78, u1, 0);
      const d = put(xs[j], top, zs[j], nx, 0, nz, tone, 1, u1, v1);
      const e = put(xs[i], top, zs[i], nx, 0, nz, tone, 1, u0, v1);
      wallIndex.push(a, c, d, a, d, e);
    }

    contour.length = 0;
    for (let i = 0; i < n; i++) {
      // Earcut in (x, −z) so the ring is counter-clockwise in a y-up plane
      // seen from +Y, matching the roof normal.
      contour.push(new THREE.Vector2(xs[i], -zs[i]));
    }
    const roofStart = v;
    for (let i = 0; i < n; i++) {
      put(xs[i], top, zs[i], 0, 1, 0, roof, 1, 0, 0);
    }
    const tris = THREE.ShapeUtils.triangulateShape(contour, []);
    for (const [p, q, r] of tris) {
      // Earcut's output winding depends on its own conventions; orient each
      // roof triangle so its face normal points up (+Y).
      const ny = (zs[q] - zs[p]) * (xs[r] - xs[p]) - (xs[q] - xs[p]) * (zs[r] - zs[p]);
      roofIndex.push(roofStart + p, roofStart + (ny < 0 ? r : q), roofStart + (ny < 0 ? q : r));
    }
    // Degenerate rings (earcut dropping triangles) leave unused slots — pad
    // with a zero-area triangle so the index stays dense.
    const expected = 3 * (n - 2);
    for (let k = tris.length * 3; k < expected; k++) {
      roofIndex.push(roofStart);
    }
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  const index = new Uint32Array(wallIndex.length + roofIndex.length);
  index.set(wallIndex, 0);
  index.set(roofIndex, wallIndex.length);
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.addGroup(0, wallIndex.length, 0);
  geometry.addGroup(wallIndex.length, roofIndex.length, 1);
  geometry.computeBoundingSphere();
  const wallMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
  if (opts.facades !== false && typeof document !== "undefined") {
    wallMaterial.map = facadeTexture();
  }
  const mesh = new THREE.Mesh(geometry, [wallMaterial, new THREE.MeshLambertMaterial({ vertexColors: true })]);
  mesh.name = "park-buildings";
  return mesh;
}

// One repeating facade tile: FACADE_TILE_M metres of wall — a 4×4 grid of
// punched windows over a near-white ground the vertex tone colours. A few
// windows glow warm, most sit dark blue-grey; drawn once per page.
const FACADE_TILE_M = 13;
let facadeCanvasTexture: THREE.CanvasTexture | null = null;

function facadeTexture(): THREE.CanvasTexture {
  if (facadeCanvasTexture !== null) {
    return facadeCanvasTexture;
  }
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#f3f1ec";
  ctx.fillRect(0, 0, size, size);
  let seed = 0x46414341;
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const cells = 4;
  const cell = size / cells;
  for (let row = 0; row < cells; row++) {
    for (let col = 0; col < cells; col++) {
      // Window ~55% of the bay, sitting low (sill) and centred.
      const w = cell * 0.52;
      const h = cell * 0.58;
      const x = col * cell + (cell - w) / 2;
      const y = row * cell + cell * 0.24;
      const r = rand();
      if (r > 0.93) {
        ctx.fillStyle = "#ffe9b8"; // lit
      } else {
        const glass = 46 + Math.floor(rand() * 34);
        ctx.fillStyle = `rgb(${glass},${glass + 8},${glass + 18})`;
      }
      ctx.fillRect(x, y, w, h);
      // Mullion.
      ctx.fillStyle = "rgba(240,238,232,0.85)";
      ctx.fillRect(x + w / 2 - 1, y, 2, h);
    }
    // Floor line.
    ctx.fillStyle = "rgba(120,116,108,0.35)";
    ctx.fillRect(0, row * cell, size, 2);
  }
  facadeCanvasTexture = new THREE.CanvasTexture(canvas);
  facadeCanvasTexture.wrapS = THREE.RepeatWrapping;
  facadeCanvasTexture.wrapT = THREE.RepeatWrapping;
  facadeCanvasTexture.colorSpace = THREE.SRGBColorSpace;
  facadeCanvasTexture.anisotropy = 4;
  return facadeCanvasTexture;
}
