// The baked open-data Central Park world (public/assets/park, produced by
// scripts/fetch-park-data.py): a NAIP leaf-on orthophoto draped over USGS
// 3DEP terrain, the tree canopy raised into real mass by a relief map
// classified from the photo, and the surrounding city extruded from NYC's
// building footprints. No proprietary content — storable, offline, and the
// same module serves the park3d page (?src=open) and the room (?env=park).
//
// Local frame: metres, +X east, +Y up, −Z north, origin at the park centre
// (see park-frame.ts). The aerial page keeps the unlit orthophoto; the room
// uses lit turf and path materials, a carved waterbed, and physical facades
// so the host scene's sky and sun determine their appearance.

import * as THREE from "three";
import { parkTerrainAxis, terrainAxisCoordinate } from "./park-terrain-grid";
import { parkGroundColor } from "./park-ground";
import { parkGroundDetailTexture } from "./park-materials";
import { AXIS_BEARING, DEG, PARK_CENTER, PARK_HALF_LEN, PARK_HALF_WIDTH } from "./park-frame";
import { insideParkOutline as insidePark } from "./park-outline";
import { waterInteriorAt } from "./park-pond-material";
import { createGapstowCrossing } from "./park-gapstow-ground";
import { PARK_SITES, hallettWoodlandAt } from "./park-sites";
import { createWollmanGrade } from "./park-wollman";
import { buildLandmarks } from "./park-landmarks";
import { loadSkylineModels, skylineSites } from "./park-models";
import { buildParkStreets } from "./park-streets";
import { refreshSouthWalks, type ParkWalk, type ParkStreetData } from "./park-walks";
import { createWalkGrade } from "./park-walk-grade";
import { buildPaths } from "./park-paths";
export { buildPaths } from "./park-paths";
import { buildBuildings } from "./park-buildings";
export { buildBuildings } from "./park-buildings";
export type { BuildBuildingsOptions } from "./park-buildings";

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
  paths: { file: string; count: number; unitM: number };
  buildings: { file: string; count: number; unitM: number };
}

export interface ParkWorldOptions {
  // A room view needs its neighbourhood, not every triangle across Manhattan.
  viewBounds?: { x: number; z: number; radius: number };
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
  // Lay the OSM path/drive ribbons over the terrain (default true) — the
  // curling walks are half of what makes the map read as Central Park.
  paths?: boolean;
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
  // Use fine tiled ground detail and a continuous lawn/woodland palette. The
  // default (false) keeps the raw orthophoto — right for the aerial page.
  detailGround?: boolean;
  // Blend the surface to the anchor's ground height inside `radius`, easing
  // back to the real terrain over `feather` — the room parks its meadow disc
  // on Sheep Meadow and must not have the lawn poke through it.
  flatten?: { x: number; z: number; radius: number; feather: number };
  // Split the hero water body (the one containing this local point) out of
  // the merged sheet and expose its geometry for a real reflective water
  // material (the room hands the Pond to three.js Water).
  heroWaterAt?: { x: number; z: number };
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
  // Hero body geometry (local XY plane, +Z up — rotate -90° about X and set
  // position.y to `level`) for a planar-reflection water material.
  heroWater: { geometry: THREE.BufferGeometry; level: number } | null;
  paths: THREE.Mesh | null;
  // Path centrelines in local metres (width, flat [x,z,...] runs) for the
  // caller's street furniture — lamps and benches stand along these.
  pathLines: ParkWalk[];
  perimeterTrees: ParkStreetData['trees'];
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

export const PARK_ATTRIBUTION = "USDA NAIP · USGS 3DEP · NYC Open Data footprints (public domain) · park outline, water, streets, paths, trees and sites © OpenStreetMap contributors";

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
export function makeSampler(
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

  const [demBuffer, reliefImage, waterImage, lawnImage, orthoTexture, buildingsJson, pathsJson, streetData] = await Promise.all([
    fetchOk(`${base}/${manifest.dem.file}`).then((r) => r.arrayBuffer()),
    opts.relief === false ? null : loadImage(`${base}/${manifest.relief.file}`),
    opts.water === false ? null : loadImage(`${base}/${manifest.water.file}`),
    opts.relief === false ? null : loadImage(`${base}/${manifest.lawn.file}`),
    opts.detailGround === true ? null : loadOrtho(`${base}/${manifest.ortho.file}`, manifest.ortho.width, manifest.ortho.height, opts.orthoMaxWidth),
    opts.buildings === false
      ? null
      : fetchOk(`${base}/${manifest.buildings.file}`).then((r) => r.json() as Promise<{ buildings: [number, number, number, number[]][] }>),
    opts.paths === false
      ? null
      : fetchOk(`${base}/${manifest.paths.file}`).then((r) => r.json() as Promise<{ paths: [number, number[]][] }>),
    opts.detailGround && opts.paths !== false ? fetchOk(`${base}/streets.json`).then(r => r.json() as Promise<ParkStreetData>) : null,
  ]);

  let pathLines: ParkWalk[] = [];
  if (pathsJson !== null) {
    for (const [widthUnits, line] of pathsJson.paths) {
      const pts: number[] = [];
      for (let i = 0; i < line.length; i += 2) {
        pts.push(line[i] * manifest.paths.unitM, line[i + 1] * manifest.paths.unitM);
      }
      pathLines.push({ width: widthUnits * manifest.paths.unitM, pts });
    }
    if (streetData?.walks?.length) pathLines = refreshSouthWalks(pathLines, streetData);
  }

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
  const photoRelief = maskSampler(reliefImage, manifest.relief.unitM);
  const woodland = opts.detailGround === true && opts.relief !== false ? hallettWoodlandAt : () => 0;
  const sampleRelief = (x: number, z: number) => Math.max(photoRelief(x, z), woodland(x, z) * 12);
  const sampleWater = maskSampler(waterImage, 1 / 255);
  const photoLawn = maskSampler(lawnImage, 1 / 255);
  const sampleLawn = (x: number, z: number) => photoLawn(x, z) * (1 - woodland(x, z));

  const rinkGrade = opts.landmarks !== false ? createWollmanGrade(sampleDem) : null;
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
  const dryGroundAt = (x: number, z: number): number => {
    const w = terrainWeight(x, z);
    const base = w === 1 ? sampleDem(x, z) : anchorGround + (sampleDem(x, z) - anchorGround) * w;
    return rinkGrade?.heightAt(x, z, base) ?? base;
  };
  const view = opts.viewBounds;
  const west = view ? Math.max(-halfEast, view.x - view.radius) : -halfEast;
  const east = view ? Math.min(halfEast, view.x + view.radius) : halfEast;
  const north = view ? Math.max(-halfNorth, view.z - view.radius) : -halfNorth;
  const south = view ? Math.min(halfNorth, view.z + view.radius) : halfNorth;
  const cx = (west + east) / 2, cz = (north + south) / 2;
  const width = east - west, depth = south - north;
  const builtWater = waterImage === null ? null : buildWater(sampleWater, dryGroundAt, width / 2, depth / 2, 2, opts.heroWaterAt, { x: cx, z: cz });
  const gapstowLevel = builtWater?.surfaceAt(PARK_SITES.gapstow.x, PARK_SITES.gapstow.z);
  const crossing = opts.landmarks !== false && gapstowLevel != null ? createGapstowCrossing(gapstowLevel) : null;
  const displace = opts.displace !== false;
  const carvedGroundAt = (x: number, z: number) => Math.min(dryGroundAt(x, z), builtWater?.bankHeightAt(x, z) ?? Infinity);
  const walkGrade = opts.detailGround && !displace ? createWalkGrade(pathLines, {
    groundAt: carvedGroundAt,
    referenceAt: (x, z) => crossing?.grade(x, z, carvedGroundAt(x, z)) ?? carvedGroundAt(x, z),
    waterAt: sampleWater,
    waterLevelAt: (x, z) => {
      if (!builtWater) return null;
      for (const [dx, dz] of [[0, 0], [3, 0], [-3, 0], [0, 3], [0, -3]]) {
        const level = builtWater.surfaceAt(x + dx!, z + dz!);
        if (level != null) return level;
      }
      return null;
    },
    bridgeAt: crossing?.deckAt,
  }, { west, east, north, south }) : null;
  const bedGroundAt = (x: number, z: number) => {
    const bed = walkGrade?.heightAt(x, z) ?? carvedGroundAt(x, z);
    return crossing?.grade(x, z, bed) ?? bed;
  };
  const heightAt = (x: number, z: number): number => {
    if (!displace) {
      return bedGroundAt(x, z);
    }
    const w = terrainWeight(x, z);
    return bedGroundAt(x, z) + (sampleWater(x, z) < .4 ? sampleRelief(x, z) * w : 0);
  };

  // ── terrain ─────────────────────────────────────────────────────────────
  await nextFrame();
  const step = opts.stepM ?? manifest.dem.stepM;
  // Avoid spending most of the frame on metre-scale triangles beneath
  // distant city blocks. Preserve the regular grid for the aerial renderer.
  const axes = opts.detailGround && !displace && view ? {
    x: parkTerrainAxis(west, east, view.x, step),
    z: parkTerrainAxis(north, south, view.z, step),
  } : undefined;
  const segsX = axes ? axes.x.length - 1 : Math.ceil(width / step);
  const segsZ = axes ? axes.z.length - 1 : Math.ceil(depth / step);
  const geometry = new THREE.PlaneGeometry(width, depth, segsX, segsZ);
  // Plane XY → world XZ with −Z north: plane +Y (north, texture row 0 after
  // three's default flipY) lands on −Z.
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(cx, 0, cz);
  const pos = geometry.getAttribute("position") as THREE.BufferAttribute;
  const groundUv = geometry.getAttribute("uv") as THREE.BufferAttribute;
  const reliefAt = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const x = axes ? axes.x[i % (segsX + 1)]! : pos.getX(i);
    const z = axes ? axes.z[Math.floor(i / (segsX + 1))]! : pos.getZ(i);
    pos.setX(i, x); pos.setZ(i, z);
    groundUv.setXY(i, (x + halfEast) / (2 * halfEast), 1 - (z + halfNorth) / (2 * halfNorth));
    const w = terrainWeight(x, z);
    reliefAt[i] = displace ? sampleRelief(x, z) * w : 0;
    pos.setY(i, heightAt(x, z));
  }
  const groundAt = displace ? bedGroundAt : terrainSurfaceSampler(pos, segsX, segsZ, west, north, width, depth, bedGroundAt, axes);
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

  if (orthoTexture) {
    orthoTexture.colorSpace = THREE.SRGBColorSpace;
    orthoTexture.anisotropy = 8;
  }
  let terrainMaterial: THREE.Material | THREE.Material[];
  if (opts.detailGround === true) {
    const tint = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const shore = Math.max(sampleWater(x, z), .6 * Math.max(sampleWater(x + 3, z), sampleWater(x - 3, z), sampleWater(x, z + 3), sampleWater(x, z - 3)));
      parkGroundColor(x, z, sampleLawn(x, z), sampleRelief(x, z), shore, insidePark(x, z, 6), tint);
      colors[i * 3] *= tint.r;
      colors[i * 3 + 1] *= tint.g;
      colors[i * 3 + 2] *= tint.b;
    }
    (geometry.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
    const texLoader = new THREE.TextureLoader();
    const repeat = { x: (2 * halfEast) / 10, y: (2 * halfNorth) / 10 };
    const groundDiff = parkGroundDetailTexture().clone();
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
      normalScale: new THREE.Vector2(.18, .18),
      vertexColors: true,
      roughness: 1,
      metalness: 0,
    });
    // The grass belongs INSIDE the wall only: split the index into a park
    // group (tiled grass) and a city group (neutral paving) by
    // triangle centroid, so the blocks between buildings read as street,
    // not meadow.
    const src = geometry.getIndex()!;
    const parkTris: number[] = [];
    const cityTris: number[] = [];
    for (let t = 0; t < src.count; t += 3) {
      const a = src.getX(t);
      const b = src.getX(t + 1);
      const c = src.getX(t + 2);
      const cxT = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3;
      const czT = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
      (insidePark(cxT, czT, 6) ? parkTris : cityTris).push(a, b, c);
    }
    const merged = new Uint32Array(parkTris.length + cityTris.length);
    merged.set(parkTris, 0);
    merged.set(cityTris, parkTris.length);
    geometry.setIndex(new THREE.BufferAttribute(merged, 1));
    geometry.clearGroups();
    geometry.addGroup(0, parkTris.length, 0);
    geometry.addGroup(parkTris.length, cityTris.length, 1);
    const paving = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
    terrainMaterial = [terrainMaterial, paving];
  } else {
    terrainMaterial = new THREE.MeshBasicMaterial({ map: orthoTexture, vertexColors: true });
  }
  const terrain = new THREE.Mesh(geometry, terrainMaterial);
  terrain.name = "park-terrain";

  const group = new THREE.Group();
  group.name = "park-world";
  group.add(terrain);

  // ── water ───────────────────────────────────────────────────────────────
  // Each mapped body has a level surface and a carved bed below it. The
  // water uses a separate 2 m grid so its outline is independent of terrain LOD.
  const water = builtWater?.mesh ?? null;
  const heroWater = builtWater?.hero ?? null;
  if (water) group.add(water);

  // ── paths ───────────────────────────────────────────────────────────────
  let paths: THREE.Mesh | null = null;
  if (pathLines.length) {
    await nextFrame();
    paths = buildPaths(pathLines,
      (x, z) => crossing?.deckAt(x, z) ?? groundAt(x, z),
      (x, z) => crossing?.deckAt(x, z) != null ? 0 : sampleWater(x, z), { west, east, north, south, focus: opts.flatten ?? opts.viewBounds });
    if (paths !== null) {
      group.add(paths);
    }
  }

  if (opts.landmarks !== false) {
    group.add(buildLandmarks(groundAt, { waterAt: builtWater?.surfaceAt, rinkLevel: rinkGrade?.level, paths: pathLines }));
  }

  let streets: ReturnType<typeof buildParkStreets> | null = null;
  if (streetData) {
    streets = buildParkStreets(streetData.ways, groundAt, { west, east, north, south }, pathLines);
    group.add(streets.group);
    if (streets.map && Array.isArray(terrain.material)) {
      const uv = new Float32Array(pos.count * 2);
      for (let i = 0; i < pos.count; i++) {
        uv[i * 2] = (pos.getX(i) - west) / width;
        uv[i * 2 + 1] = 1 - (pos.getZ(i) - north) / depth;
      }
      geometry.setAttribute('uv1', new THREE.BufferAttribute(uv, 2));
      const city = terrain.material[1] as THREE.MeshStandardMaterial;
      city.map = streets.map; city.vertexColors = false; city.needsUpdate = true;
    }
  }

  // ── buildings ───────────────────────────────────────────────────────────
  const models = opts.models !== false;
  let buildings: THREE.Mesh | null = null;
  if (buildingsJson !== null) {
    await nextFrame();
    const nearbyBuildings = view ? buildingsJson.buildings.filter((row: [number, number, number, number[]]) => {
      const ring = row[3], unit = manifest.buildings.unitM;
      let x = 0, z = 0;
      for (let i = 0; i < ring.length; i += 2) { x += ring[i]! * unit; z += ring[i + 1]! * unit; }
      x /= ring.length / 2; z /= ring.length / 2;
      return x >= west && x <= east && z >= north && z <= south;
    }) : buildingsJson.buildings;
    buildings = buildBuildings(nearbyBuildings, manifest.buildings.unitM, groundAt, {
      detail: opts.detailGround,
      focus: opts.viewBounds,
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
    heroWater,
    paths,
    pathLines,
    perimeterTrees: streetData?.trees ?? [],
    groundAt,
    heightAt: displace ? heightAt : groundAt,
    canopyAt: sampleRelief,
    lawnAt: sampleLawn,
    waterAt: sampleWater,
    dispose: () => {
      streets?.dispose();
      geometry.dispose();
      for (const m of Array.isArray(terrain.material) ? terrain.material : [terrain.material]) {
        const tm = m as THREE.MeshStandardMaterial;
        tm.map?.dispose();
        tm.normalMap?.dispose();
        tm.dispose();
      }
      orthoTexture?.dispose();
      if (buildings !== null) {
        buildings.traverse(node => {
          if (!(node instanceof THREE.Mesh)) return;
          node.geometry.dispose();
          for (const material of Array.isArray(node.material) ? node.material : [node.material]) material.dispose();
        });
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
      if (paths !== null) {
        paths.geometry.dispose();
        for (const material of Array.isArray(paths.material) ? paths.material : [paths.material]) material.dispose();
      }
      heroWater?.geometry.dispose();
      group.getObjectByName("park-landmarks")?.traverse((node) => {
        if (node instanceof THREE.Mesh) {
          node.geometry.dispose();
          if (node instanceof THREE.InstancedMesh) node.dispose();
          const material = node.material as THREE.MeshStandardMaterial;
          if (material.userData.ownsParkMap) material.map?.dispose();
          material.dispose();
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
  heroAt?: { x: number; z: number },
  offset = { x: 0, z: 0 },
): { mesh: THREE.Mesh | null; hero: { geometry: THREE.BufferGeometry; level: number } | null; surfaceAt: (x: number, z: number) => number | null; bankHeightAt: (x: number, z: number) => number | null } {
  const cols = Math.ceil((2 * halfEast) / cell);
  const rows = Math.ceil((2 * halfNorth) / cell);
  // Which cells are water, then one LEVEL per connected body: lidar DEMs
  // slope and ripple over lakes, and a sheet that follows them reads as a
  // staircase. Each body takes its 20th-percentile ground height (the
  // true surface sits low in the noise).
  const isWater = new Uint8Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = offset.x - halfEast + i * cell, z = offset.z - halfNorth + j * cell;
      if (Math.max(waterAt(x, z), waterAt(x + cell, z), waterAt(x, z + cell), waterAt(x + cell, z + cell), waterAt(x + cell / 2, z + cell / 2)) >= .5) {
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
    const heights = cells.map((c) => groundAt(offset.x - halfEast + ((c % cols) + 0.5) * cell, offset.z - halfNorth + (Math.floor(c / cols) + 0.5) * cell));
    heights.sort((a, b) => a - b);
    const surface = heights[Math.floor(heights.length * 0.2)];
    for (const c of cells) {
      level[c] = surface;
    }
    bodies++;
  }
  const surfaceAt = (x: number, z: number): number | null => {
    const i = Math.floor((x - offset.x + halfEast) / cell), j = Math.floor((z - offset.z + halfNorth) / cell);
    if (i < 0 || j < 0 || i >= cols || j >= rows || !isWater[j * cols + i]) return null;
    return level[j * cols + i]! + .1;
  };
  // Grow a narrow distance field out from each bank. DEM returns over water
  // can be metres above its level; a gradual bank avoids cutting vertical,
  // grid-shaped trenches into the surrounding paths and lawns.
  const distance = new Uint8Array(isWater.length).fill(255);
  const shoreLevel = new Float32Array(level);
  let front: number[] = [];
  for (let c = 0; c < isWater.length; c++) {
    if (!isWater[c]) continue;
    distance[c] = 0;
    const i = c % cols, j = Math.floor(c / cols);
    if ((i > 0 && !isWater[c - 1]) || (i < cols - 1 && !isWater[c + 1]) ||
        (j > 0 && !isWater[c - cols]) || (j < rows - 1 && !isWater[c + cols])) front.push(c);
  }
  const bankCells = Math.ceil(14 / cell);
  for (let step = 1; step <= bankCells; step++) {
    const next: number[] = [];
    for (const c of front) {
      const i = c % cols, j = Math.floor(c / cols);
      for (const [di, dj] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const ni = i + di!, nj = j + dj!;
        if (ni < 0 || ni >= cols || nj < 0 || nj >= rows) continue;
        const at = nj * cols + ni;
        if (distance[at] !== 255) continue;
        distance[at] = step;
        shoreLevel[at] = shoreLevel[c]!;
        next.push(at);
      }
    }
    front = next;
  }
  const bankHeightAt = (x: number, z: number): number | null => {
    const gx = (x - offset.x + halfEast) / cell - .5, gz = (z - offset.z + halfNorth) / cell - .5;
    if (gx < 0 || gz < 0 || gx >= cols - 1 || gz >= rows - 1) return null;
    const i = Math.floor(gx), j = Math.floor(gz), tx = gx - i, tz = gz - j;
    const corners = [j * cols + i, j * cols + i + 1, (j + 1) * cols + i, (j + 1) * cols + i + 1];
    if (corners.some(at => distance[at] === 255)) return null;
    const mix = (values: number[]) => values[0]! * (1 - tx) * (1 - tz) + values[1]! * tx * (1 - tz) + values[2]! * (1 - tx) * tz + values[3]! * tx * tz;
    const shore = mix(corners.map(at => shoreLevel[at]!)) + .09;
    const wet = waterAt(x, z);
    // Meet the water at its actual contour. The old quadratic left dry bank
    // vertices a metre below the surface, exposing dark trenches beside it.
    if (wet >= .5) return shore - smoothstep(.5, 1, wet) * 1.1;
    const run = Math.max(0, mix(corners.map(at => distance[at]! * cell)) - cell * .5);
    return shore + run * .42 + run * run * .025;
  };
  // Which body is the hero (real reflections)? The one under `heroAt`.
  let heroLabel = -1;
  if (heroAt !== undefined && Math.abs(heroAt.x - offset.x) < halfEast && Math.abs(heroAt.z - offset.z) < halfNorth) {
    const hi = Math.floor((heroAt.x - offset.x + halfEast) / cell);
    const hj = Math.floor((heroAt.z - offset.z + halfNorth) / cell);
    heroLabel = label[hj * cols + hi];
  }
  const positions: number[] = [];
  const uvs: number[] = [];
  const index: number[] = [];
  const heroPositions: number[] = [];
  const heroUvs: number[] = [];
  const heroInterior: number[] = [];
  const heroIndex: number[] = [];
  let heroLevel = 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      if (isWater[j * cols + i] === 0) {
        continue;
      }
      const x0 = offset.x - halfEast + i * cell;
      const z0 = offset.z - halfNorth + j * cell;
      const y = level[j * cols + i] + 0.1;
      const T = 3.5;
      const corners = [[x0, z0], [x0 + cell, z0], [x0 + cell, z0 + cell], [x0, z0 + cell]]
        .map(([x, z]) => ({ x: x!, z: z!, wet: waterAt(x!, z!) }));
      const isHero = label[j * cols + i] === heroLabel;
      const targetPositions = isHero ? heroPositions : positions;
      const targetUvs = isHero ? heroUvs : uvs;
      const targetIndex = isHero ? heroIndex : index;
      if (isHero) heroLevel = y;
      for (const order of [[0, 3, 2], [0, 2, 1]]) {
        const polygon = clipWaterTriangle(order.map(k => corners[k!]!));
        const base = targetPositions.length / 3;
        for (const p of polygon) {
          if (isHero) {
            targetPositions.push(p.x, -p.z, 0);
            heroInterior.push(waterInteriorAt(waterAt, p.x, p.z));
          }
          else targetPositions.push(p.x, y, p.z);
          targetUvs.push(p.x / T, p.z / T);
        }
        for (let k = 1; k + 1 < polygon.length; k++) targetIndex.push(base, base + k, base + k + 1);
      }
    }
  }
  let hero: { geometry: THREE.BufferGeometry; level: number } | null = null;
  if (heroPositions.length > 0) {
    const heroGeometry = new THREE.BufferGeometry();
    heroGeometry.setAttribute("position", new THREE.Float32BufferAttribute(heroPositions, 3));
    heroGeometry.setAttribute("uv", new THREE.Float32BufferAttribute(heroUvs, 2));
    heroGeometry.setAttribute("waterInterior", new THREE.Float32BufferAttribute(heroInterior, 1));
    const heroNormals = new Float32Array(heroPositions.length);
    for (let i = 2; i < heroNormals.length; i += 3) {
      heroNormals[i] = 1;
    }
    heroGeometry.setAttribute("normal", new THREE.BufferAttribute(heroNormals, 3));
    heroGeometry.setIndex(heroIndex);
    heroGeometry.computeBoundingSphere();
    hero = { geometry: heroGeometry, level: heroLevel };
  }
  if (positions.length === 0) {
    return { mesh: null, hero, surfaceAt, bankHeightAt };
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  const normals = new Float32Array(positions.length);
  for (let i = 1; i < normals.length; i += 3) {
    normals[i] = 1;
  }
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.setIndex(index);
  geometry.computeBoundingSphere();
  // The Pond in the photographs is dark glass: nearly black-green looked
  // into, mirror-bright toward grazing angles (Fresnel does that once the
  // base is dark and the surface is smooth), with fine ripples breaking the
  // reflection. The host hands it a sky envMap and scrolls the ripples.
  const material = new THREE.MeshStandardMaterial({ color: 0x0f1d1a, roughness: 0.12, metalness: 0 });
  if (typeof document !== "undefined") {
    material.normalMap = waterRippleNormals();
    material.normalScale.set(0.22, 0.22);
  }
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "park-water";
  return { mesh, hero, surfaceAt, bankHeightAt };
}

// Tileable ripple normal map (sum of sines), generated once per page.
let rippleTexture: THREE.CanvasTexture | null = null;

export function waterRippleNormals(): THREE.CanvasTexture {
  if (rippleTexture !== null) {
    return rippleTexture;
  }
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(size, size);
  const TAU = Math.PI * 2;
  const h = (x: number, y: number): number =>
    Math.sin((x * 3 + y) * TAU / size) * 0.5 +
    Math.sin((x * 7 - y * 4) * TAU / size + 1.7) * 0.3 +
    Math.sin((x * 2 + y * 9) * TAU / size + 4.1) * 0.2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = h(x + 1, y) - h(x - 1, y);
      const dy = h(x, y + 1) - h(x, y - 1);
      const o = (y * size + x) * 4;
      img.data[o] = 128 + dx * 90;
      img.data[o + 1] = 128 + dy * 90;
      img.data[o + 2] = 255;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  rippleTexture = new THREE.CanvasTexture(canvas);
  rippleTexture.wrapS = THREE.RepeatWrapping;
  rippleTexture.wrapT = THREE.RepeatWrapping;
  return rippleTexture;
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

/** Interpolate the same two triangles as PlaneGeometry, so paths and props sit
 * on the rendered terrain rather than a different continuous DEM surface. */
export function terrainSurfaceSampler(
  positions: Pick<THREE.BufferAttribute, "getY">, cols: number, rows: number,
  west: number, north: number, width: number, depth: number,
  fallback: (x: number, z: number) => number,
  axes?: { x: readonly number[]; z: readonly number[] },
): (x: number, z: number) => number {
  return (x, z) => {
    const gx = axes ? terrainAxisCoordinate(axes.x, x) : (x - west) / width * cols;
    const gz = axes ? terrainAxisCoordinate(axes.z, z) : (z - north) / depth * rows;
    if (gx < 0 || gz < 0 || gx > cols || gz > rows) return fallback(x, z);
    const i = Math.min(cols - 1, Math.floor(gx)), j = Math.min(rows - 1, Math.floor(gz));
    const tx = gx - i, tz = gz - j, a = j * (cols + 1) + i;
    const ha = positions.getY(a), hb = positions.getY(a + cols + 1);
    const hc = positions.getY(a + cols + 2), hd = positions.getY(a + 1);
    return tx + tz <= 1 ? ha + (hd - ha) * tx + (hb - ha) * tz
      : hc + (hb - hc) * (1 - tx) + (hd - hc) * (1 - tz);
  };
}

/** Clip a terrain cell triangle to the bilinear mask contour instead of drawing
 * a full square per water pixel. Keeps shorelines smooth at close range. */
export function clipWaterTriangle(points: { x: number; z: number; wet: number }[]): { x: number; z: number; wet: number }[] {
  const output: typeof points = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!, b = points[(i + 1) % points.length]!;
    if (a.wet >= .5) output.push(a);
    if ((a.wet >= .5) !== (b.wet >= .5)) {
      const t = (.5 - a.wet) / (b.wet - a.wet);
      output.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, wet: .5 });
    }
  }
  return output;
}
