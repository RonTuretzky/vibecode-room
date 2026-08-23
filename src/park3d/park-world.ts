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
import { AXIS_BEARING, DEG, PARK_CENTER, PARK_HALF_LEN, PARK_HALF_WIDTH } from "./park-frame";

export interface ParkManifest {
  center: { lat: number; lon: number; surfaceHeightM: number };
  axisBearingDeg: number;
  park: { halfLen: number; halfWidth: number };
  extent: { halfEast: number; halfNorth: number };
  anchors: { sheepMeadow: { lat: number; lon: number; x: number; z: number; groundM: number } };
  ortho: { file: string; width: number; height: number; source: string };
  dem: { file: string; cols: number; rows: number; stepM: number; unitM: number };
  relief: { file: string; width: number; height: number; unitM: number };
  buildings: { file: string; count: number; unitM: number };
}

export interface ParkWorldOptions {
  // Asset base URL (default /assets/park).
  base?: string;
  // Terrain grid step in metres (default 8 — the DEM's own resolution; the
  // 2 m relief is sampled through it, so 6 sharpens crowns at ~2× the verts).
  stepM?: number;
  // Raise the canopy (default true). Off gives the bare orthophoto drape.
  relief?: boolean;
  // Extrude the city (default true).
  buildings?: boolean;
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
  // Bare-earth height (flatten applied) at a local point.
  groundAt: (x: number, z: number) => number;
  // Surface height including the canopy relief (flatten applied).
  heightAt: (x: number, z: number) => number;
  dispose: () => void;
}

export const PARK_ATTRIBUTION = "USDA NAIP · USGS 3DEP · NYC Open Data building footprints (public domain)";

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

  const [demBuffer, reliefImage, orthoTexture, buildingsJson] = await Promise.all([
    fetchOk(`${base}/${manifest.dem.file}`).then((r) => r.arrayBuffer()),
    opts.relief === false ? null : loadImage(`${base}/${manifest.relief.file}`),
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

  let sampleRelief: (x: number, z: number) => number = () => 0;
  if (reliefImage !== null) {
    const canvas = document.createElement("canvas");
    canvas.width = reliefImage.width;
    canvas.height = reliefImage.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(reliefImage, 0, 0);
    const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const red = new Uint8Array(canvas.width * canvas.height);
    for (let i = 0; i < red.length; i++) {
      red[i] = rgba[i * 4];
    }
    sampleRelief = makeSampler(red, canvas.width, canvas.height, halfEast, halfNorth, 0.5, manifest.relief.unitM);
  }

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
  const heightAt = (x: number, z: number): number => {
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
    reliefAt[i] = sampleRelief(x, z) * w;
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
  // The normals only served the bake above — the unlit material never reads
  // them, so don't ship 400k of them to the GPU.
  geometry.deleteAttribute("normal");
  geometry.computeBoundingSphere();

  orthoTexture.colorSpace = THREE.SRGBColorSpace;
  orthoTexture.anisotropy = 8;
  const terrain = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ map: orthoTexture, vertexColors: true }));
  terrain.name = "park-terrain";

  const group = new THREE.Group();
  group.name = "park-world";
  group.add(terrain);

  // ── buildings ───────────────────────────────────────────────────────────
  let buildings: THREE.Mesh | null = null;
  if (buildingsJson !== null) {
    await nextFrame();
    buildings = buildBuildings(buildingsJson.buildings, manifest.buildings.unitM, groundAt);
    group.add(buildings);
  }

  return {
    manifest,
    group,
    terrain,
    buildings,
    groundAt,
    heightAt,
    dispose: () => {
      geometry.dispose();
      (terrain.material as THREE.Material).dispose();
      orthoTexture.dispose();
      if (buildings !== null) {
        buildings.geometry.dispose();
        (buildings.material as THREE.Material).dispose();
      }
      group.removeFromParent();
    },
  };
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
export function buildBuildings(
  rows: [number, number, number, number[]][],
  unit: number,
  groundAt: (x: number, z: number) => number,
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
  const index = new Uint32Array(indexCount);
  let v = 0;
  let ii = 0;
  const roofGrey = new THREE.Color(0x8c8c8c);
  const contour: THREE.Vector2[] = [];

  const put = (x: number, y: number, z: number, nx: number, ny: number, nz: number, c: THREE.Color, shade: number): number => {
    positions[v * 3] = x;
    positions[v * 3 + 1] = y;
    positions[v * 3 + 2] = z;
    normals[v * 3] = nx;
    normals[v * 3 + 1] = ny;
    normals[v * 3 + 2] = nz;
    colors[v * 3] = c.r * shade;
    colors[v * 3 + 1] = c.g * shade;
    colors[v * 3 + 2] = c.b * shade;
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
    const height = Math.max(3, hUnits * unit);
    let base = Infinity;
    for (let i = 0; i < n; i++) {
      base = Math.min(base, groundAt(xs[i], zs[i]));
    }
    // Sink slightly so sloped lots never show a floating slab edge.
    base -= 0.4;
    const top = base + height;
    const tone = facadeTone(year, height, b + 1);
    const roof = tone.clone().lerp(roofGrey, 0.5).multiplyScalar(0.9);

    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const dx = xs[j] - xs[i];
      const dz = zs[j] - zs[i];
      const len = Math.hypot(dx, dz) || 1;
      // Counter-clockwise from above: outward is the right-hand side.
      const nx = -dz / len;
      const nz = dx / len;
      const a = put(xs[i], base, zs[i], nx, 0, nz, tone, 0.78);
      const c = put(xs[j], base, zs[j], nx, 0, nz, tone, 0.78);
      const d = put(xs[j], top, zs[j], nx, 0, nz, tone, 1);
      const e = put(xs[i], top, zs[i], nx, 0, nz, tone, 1);
      index[ii++] = a;
      index[ii++] = c;
      index[ii++] = d;
      index[ii++] = a;
      index[ii++] = d;
      index[ii++] = e;
    }

    contour.length = 0;
    for (let i = 0; i < n; i++) {
      // Earcut in (x, −z) so the ring is counter-clockwise in a y-up plane
      // seen from +Y, matching the roof normal.
      contour.push(new THREE.Vector2(xs[i], -zs[i]));
    }
    const roofStart = v;
    for (let i = 0; i < n; i++) {
      put(xs[i], top, zs[i], 0, 1, 0, roof, 1);
    }
    const tris = THREE.ShapeUtils.triangulateShape(contour, []);
    for (const [p, q, r] of tris) {
      // Earcut's output winding depends on its own conventions; orient each
      // roof triangle so its face normal points up (+Y).
      const ny = (zs[q] - zs[p]) * (xs[r] - xs[p]) - (xs[q] - xs[p]) * (zs[r] - zs[p]);
      index[ii++] = roofStart + p;
      index[ii++] = roofStart + (ny < 0 ? r : q);
      index[ii++] = roofStart + (ny < 0 ? q : r);
    }
    // Degenerate rings (earcut dropping triangles) leave unused slots — pad
    // with a zero-area triangle so the index stays dense.
    const expected = 3 * (n - 2);
    for (let k = tris.length * 3; k < expected; k++) {
      index[ii++] = roofStart;
    }
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.computeBoundingSphere();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ vertexColors: true }));
  mesh.name = "park-buildings";
  return mesh;
}
