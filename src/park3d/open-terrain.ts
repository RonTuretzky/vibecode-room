// Open-data terrain for the park3d evaluation page (?src=open): the SAME
// Central Park segment built entirely from public-domain / open government
// sources instead of Google's proprietary tiles — so the result may be baked,
// stored, stripped of trees, and shipped offline with no license strings.
//
//   elevation  Mapzen/AWS "terrarium" tiles (USGS 3DEP; public AWS Open Data,
//              no key, CORS-open): h = (R·256 + G + B/256) − 32768 meters.
//   imagery    NYS statewide orthophoto export (~15 cm, arcgis REST) with a
//              USGS NAIP tile fallback (~50 cm, public domain) when the NYS
//              server refuses cross-origin use.
//
// Local frame matches the tiles mode: meters, +X east, −Z north, surface
// height at the segment center sits at y = 0.

import * as THREE from "three";

const DEG = Math.PI / 180;
const MERC = 20037508.342789244;
const lonToMercX = (lon: number): number => (lon / 180) * MERC;
const latToMercY = (lat: number): number => (Math.log(Math.tan(Math.PI / 4 + (lat * DEG) / 2)) / Math.PI) * MERC;

const loadImage = (url: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`image failed: ${url}`));
    img.src = url;
  });

export interface OpenTerrainOptions {
  centerLat: number;
  centerLon: number;
  // Half-extents of the covered rectangle in TRUE meters, east/north aligned
  // (the caller's clipping planes crop it to the park slab).
  halfEast: number;
  halfNorth: number;
  stepM?: number; // grid resolution (default 10 m)
}

export async function buildOpenTerrain(opts: OpenTerrainOptions): Promise<THREE.Mesh> {
  const { centerLat, centerLon, halfEast, halfNorth } = opts;
  const step = opts.stepM ?? 10;
  const cosLat = Math.cos(centerLat * DEG);
  const cx = lonToMercX(centerLon);
  const cy = latToMercY(centerLat);
  // Local true meters ↔ mercator meters (locally uniform 1/cos(lat) stretch).
  const mercHalfE = halfEast / cosLat;
  const mercHalfN = halfNorth / cosLat;

  // ── elevation: stitch the covering terrarium tiles onto one canvas ───────
  const Z = 15;
  const n = 2 ** Z;
  const mercToTileX = (mx: number): number => ((mx + MERC) / (2 * MERC)) * n;
  const mercToTileY = (my: number): number => ((MERC - my) / (2 * MERC)) * n;
  const tx0 = Math.floor(mercToTileX(cx - mercHalfE));
  const tx1 = Math.floor(mercToTileX(cx + mercHalfE));
  const ty0 = Math.floor(mercToTileY(cy + mercHalfN));
  const ty1 = Math.floor(mercToTileY(cy - mercHalfN));
  const demCanvas = document.createElement("canvas");
  demCanvas.width = (tx1 - tx0 + 1) * 256;
  demCanvas.height = (ty1 - ty0 + 1) * 256;
  const demCtx = demCanvas.getContext("2d")!;
  const fetches: Promise<void>[] = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      fetches.push(
        loadImage(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${Z}/${tx}/${ty}.png`).then((img) => {
          demCtx.drawImage(img, (tx - tx0) * 256, (ty - ty0) * 256);
        }),
      );
    }
  }
  await Promise.all(fetches);
  const dem = demCtx.getImageData(0, 0, demCanvas.width, demCanvas.height);
  const heightAtMerc = (mx: number, my: number): number => {
    const px = Math.min(dem.width - 1, Math.max(0, (mercToTileX(mx) - tx0) * 256));
    const py = Math.min(dem.height - 1, Math.max(0, (mercToTileY(my) - ty0) * 256));
    const i = ((py | 0) * dem.width + (px | 0)) * 4;
    return dem.data[i] * 256 + dem.data[i + 1] + dem.data[i + 2] / 256 - 32768;
  };
  const h0 = heightAtMerc(cx, cy);

  // ── imagery: NYS 15 cm orthos, NAIP tile fallback ────────────────────────
  const texCanvas = document.createElement("canvas");
  const texSize = 4096;
  texCanvas.width = texSize;
  texCanvas.height = texSize;
  const texCtx = texCanvas.getContext("2d")!;
  const bbox = [cx - mercHalfE, cy - mercHalfN, cx + mercHalfE, cy + mercHalfN].join(",");
  try {
    const img = await loadImage(
      `https://orthos.its.ny.gov/arcgis/rest/services/wms/Latest/MapServer/export?bbox=${bbox}&bboxSR=3857&imageSR=3857&size=${texSize},${texSize}&format=jpg&f=image`,
    );
    texCtx.drawImage(img, 0, 0, texSize, texSize);
  } catch {
    // USGS imagery tiles (z17 ≈ 0.9 m/px here): stitch the covering tiles,
    // then crop the bbox region into the texture canvas.
    const IZ = 17;
    const inum = 2 ** IZ;
    const toTX = (mx: number): number => ((mx + MERC) / (2 * MERC)) * inum;
    const toTY = (my: number): number => ((MERC - my) / (2 * MERC)) * inum;
    const ix0 = Math.floor(toTX(cx - mercHalfE));
    const ix1 = Math.floor(toTX(cx + mercHalfE));
    const iy0 = Math.floor(toTY(cy + mercHalfN));
    const iy1 = Math.floor(toTY(cy - mercHalfN));
    const stitch = document.createElement("canvas");
    stitch.width = (ix1 - ix0 + 1) * 256;
    stitch.height = (iy1 - iy0 + 1) * 256;
    const sctx = stitch.getContext("2d")!;
    await Promise.all(
      Array.from({ length: (ix1 - ix0 + 1) * (iy1 - iy0 + 1) }, (_, k) => {
        const tx = ix0 + (k % (ix1 - ix0 + 1));
        const ty = iy0 + Math.floor(k / (ix1 - ix0 + 1));
        return loadImage(
          `https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/${IZ}/${ty}/${tx}`,
        ).then((img) => sctx.drawImage(img, (tx - ix0) * 256, (ty - iy0) * 256));
      }),
    );
    const sx = (toTX(cx - mercHalfE) - ix0) * 256;
    const sy = (toTY(cy + mercHalfN) - iy0) * 256;
    const sw = (toTX(cx + mercHalfE) - toTX(cx - mercHalfE)) * 256;
    const sh = (toTY(cy - mercHalfN) - toTY(cy + mercHalfN)) * 256;
    texCtx.drawImage(stitch, sx, sy, sw, sh, 0, 0, texSize, texSize);
  }
  const texture = new THREE.CanvasTexture(texCanvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;

  // ── mesh: regular local-meters grid, heights sampled from the DEM ────────
  const segsX = Math.ceil((halfEast * 2) / step);
  const segsZ = Math.ceil((halfNorth * 2) / step);
  const geometry = new THREE.PlaneGeometry(halfEast * 2, halfNorth * 2, segsX, segsZ);
  // Plane XY → world XZ with -Z north: plane +Y (north) must land on -Z.
  geometry.rotateX(-Math.PI / 2);
  const pos = geometry.getAttribute("position");
  for (let i = 0; i < pos.count; i++) {
    const east = pos.getX(i);
    const north = -pos.getZ(i);
    pos.setY(i, heightAtMerc(cx + east / cosLat, cy + north / cosLat) - h0);
  }
  geometry.computeVertexNormals();
  // Photography carries its own lighting — render unlit like the Google tiles.
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ map: texture }));
  mesh.name = "open-terrain";
  return mesh;
}
