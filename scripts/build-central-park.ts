// Bake the Central Park ground-layer asset from OpenStreetMap data.
//
//   bun run scripts/build-central-park.ts [--raw path/to/overpass.json]
//
// Fetches Central Park's vector data (park outline, water bodies, lawns,
// gardens, woods, footpaths, individually-mapped trees) from the Overpass API
// unless a cached raw response is supplied, then bakes it into the compact
// local-meters JSON the garden scene loads (public/assets/garden/
// central-park.json — see src/ui/central-park.ts for the renderer).
//
// Coordinate pipeline: lon/lat → equirectangular meters around the park's
// center → rotated so the park's LONG axis lies along +X (the Manhattan grid
// sits ~29° off true north; the principal axis is found by PCA over the park
// outline) → z flipped for three.js (north ends up at -Z pre-rotation).
// Everything is filtered to the park outline, Douglas-Peucker simplified, and
// rounded to 0.1 m. Data © OpenStreetMap contributors, ODbL.

const RAW_FLAG = process.argv.indexOf("--raw");
const RAW_PATH = RAW_FLAG !== -1 ? process.argv[RAW_FLAG + 1] : null;
const OUT_PATH = new URL("../public/assets/garden/central-park.json", import.meta.url).pathname;

// Bounding box: Central Park plus a thin margin (S,W,N,E).
const QUERY = `
[out:json][timeout:90][bbox:40.7639,-73.9832,40.8013,-73.9482];
(
  way["name"="Central Park"]["leisure"="park"];
  way["highway"~"^(footway|path|cycleway|pedestrian|bridleway|steps|service)$"];
  way["natural"="water"];
  relation["natural"="water"];
  way["water"];
  way["landuse"="grass"];
  way["leisure"~"^(pitch|garden|playground|common)$"];
  way["natural"~"^(wood|scrub)$"];
  node["natural"="tree"];
);
out geom;
`;
const OVERPASS_MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

interface LonLat {
  lon: number;
  lat: number;
}
interface OsmElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  geometry?: LonLat[];
  members?: { type: string; role: string; geometry?: LonLat[] }[];
}

async function loadRaw(): Promise<{ elements: OsmElement[] }> {
  if (RAW_PATH !== null) {
    console.log(`reading cached overpass response: ${RAW_PATH}`);
    return JSON.parse(await Bun.file(RAW_PATH).text());
  }
  for (const mirror of OVERPASS_MIRRORS) {
    console.log(`querying ${mirror} …`);
    try {
      const res = await fetch(mirror, { method: "POST", body: QUERY });
      const text = await res.text();
      if (!res.ok || !text.trimStart().startsWith("{")) {
        console.warn(`  mirror answered ${res.status} / non-JSON, trying next`);
        continue;
      }
      return JSON.parse(text);
    } catch (error) {
      console.warn(`  mirror failed: ${String(error)}`);
    }
  }
  throw new Error("all Overpass mirrors failed — retry later or pass --raw <file>");
}

type Pt = [number, number]; // [x, z] meters, park-centered, long axis on +X

const raw = await loadRaw();

// ── park outline ───────────────────────────────────────────────────────────
const outlineEl = raw.elements.find(
  (el) => el.type === "way" && el.tags?.name === "Central Park" && el.tags.leisure === "park",
);
if (outlineEl?.geometry === undefined) {
  throw new Error("Central Park outline way not found in the response");
}

// Equirectangular projection centered on the outline's bbox center. Meters per
// degree at ~40.78°N; plenty for a stylized diorama.
const lats = outlineEl.geometry.map((p) => p.lat);
const lons = outlineEl.geometry.map((p) => p.lon);
const lat0 = (Math.min(...lats) + Math.max(...lats)) / 2;
const lon0 = (Math.min(...lons) + Math.max(...lons)) / 2;
const M_PER_DEG_LAT = 110_574;
const M_PER_DEG_LON = 111_320 * Math.cos((lat0 * Math.PI) / 180);
const projectRaw = (p: LonLat): Pt => [(p.lon - lon0) * M_PER_DEG_LON, -(p.lat - lat0) * M_PER_DEG_LAT];

// Principal axis of the outline via PCA → rotate the long axis onto +X.
const rawOutline = outlineEl.geometry.map(projectRaw);
const mean = rawOutline
  .reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1]], [0, 0])
  .map((v) => v / rawOutline.length);
let sxx = 0;
let szz = 0;
let sxz = 0;
for (const [x, z] of rawOutline) {
  sxx += (x - mean[0]) * (x - mean[0]);
  szz += (z - mean[1]) * (z - mean[1]);
  sxz += (x - mean[0]) * (z - mean[1]);
}
const theta = 0.5 * Math.atan2(2 * sxz, sxx - szz);
const cosT = Math.cos(-theta);
const sinT = Math.sin(-theta);
const project = (p: LonLat): Pt => {
  const [x, z] = projectRaw(p);
  return [x * cosT - z * sinT, x * sinT + z * cosT];
};

// Re-center on the rotated outline's bbox so the diorama sits symmetric.
let outline = outlineEl.geometry.map(project);
const xs = outline.map((p) => p[0]);
const zs = outline.map((p) => p[1]);
const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
const cz = (Math.min(...zs) + Math.max(...zs)) / 2;
const recenter = ([x, z]: Pt): Pt => [x - cx, z - cz];
outline = outline.map(recenter);
const lengthM = Math.max(...xs) - Math.min(...xs);
const widthM = Math.max(...zs) - Math.min(...zs);

// ── geometry helpers ───────────────────────────────────────────────────────
const insideOutline = (x: number, z: number): boolean => {
  let inside = false;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const [xi, zi] = outline[i];
    const [xj, zj] = outline[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) {
      inside = !inside;
    }
  }
  return inside;
};
const mostlyInside = (pts: Pt[]): boolean => {
  const hits = pts.reduce((n, [x, z]) => n + (insideOutline(x, z) ? 1 : 0), 0);
  return hits / pts.length >= 0.5;
};

// Douglas-Peucker with a meters tolerance.
function simplify(pts: Pt[], tol: number): Pt[] {
  if (pts.length <= 2) {
    return pts;
  }
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length > 0) {
    const [a, b] = stack.pop()!;
    const [ax, az] = pts[a];
    const [bx, bz] = pts[b];
    const dx = bx - ax;
    const dz = bz - az;
    const len2 = dx * dx + dz * dz;
    let worst = -1;
    let worstD = tol * tol;
    for (let i = a + 1; i < b; i++) {
      const [px, pz] = pts[i];
      let d2: number;
      if (len2 === 0) {
        d2 = (px - ax) * (px - ax) + (pz - az) * (pz - az);
      } else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len2));
        const qx = ax + t * dx;
        const qz = az + t * dz;
        d2 = (px - qx) * (px - qx) + (pz - qz) * (pz - qz);
      }
      if (d2 > worstD) {
        worstD = d2;
        worst = i;
      }
    }
    if (worst !== -1) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  return pts.filter((_, i) => keep[i] === 1);
}

const ringArea = (pts: Pt[]): number => {
  let area = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    area += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
  }
  return Math.abs(area / 2);
};

// Stitch a multipolygon relation's outer ways into closed rings (member ways
// arrive in arbitrary order/direction; shared endpoint nodes match exactly).
function stitchRings(segments: LonLat[][]): Pt[][] {
  const pool = segments.map((seg) => seg.map(project).map(recenter)).filter((seg) => seg.length >= 2);
  const same = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) < 0.01 && Math.abs(a[1] - b[1]) < 0.01;
  const rings: Pt[][] = [];
  while (pool.length > 0) {
    const ring = pool.shift()!;
    let grew = true;
    while (grew && !same(ring[0], ring[ring.length - 1])) {
      grew = false;
      for (let i = 0; i < pool.length; i++) {
        const seg = pool[i];
        const head = ring[0];
        const tail = ring[ring.length - 1];
        if (same(tail, seg[0])) {
          ring.push(...seg.slice(1));
        } else if (same(tail, seg[seg.length - 1])) {
          ring.push(...seg.slice(0, -1).reverse());
        } else if (same(head, seg[seg.length - 1])) {
          ring.unshift(...seg.slice(0, -1));
        } else if (same(head, seg[0])) {
          ring.unshift(...seg.slice(1).reverse());
        } else {
          continue;
        }
        pool.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (same(ring[0], ring[ring.length - 1]) && ring.length >= 4) {
      rings.push(ring.slice(0, -1));
    }
  }
  return rings;
}

// ── classify + bake ────────────────────────────────────────────────────────
const POLY_TOL = 2; // m
const PATH_TOL = 2.5; // m
const MIN_POLY_AREA = 120; // m² — drop slivers
const round1 = (v: number): number => Math.round(v * 10) / 10;
const flat = (pts: Pt[]): number[] => pts.flatMap(([x, z]) => [round1(x), round1(z)]);

const water: number[][] = [];
const lawns: number[][] = [];
const gardens: number[][] = [];
const woods: number[][] = [];
const paths: { k: string; pts: number[] }[] = [];
const trees: number[] = [];

const addPoly = (bucket: number[][], pts: Pt[]) => {
  const simplified = simplify([...pts, pts[0]], POLY_TOL).slice(0, -1);
  if (simplified.length >= 3 && ringArea(simplified) >= MIN_POLY_AREA && mostlyInside(simplified)) {
    bucket.push(flat(simplified));
  }
};

const PATH_KIND: Record<string, string> = {
  footway: "walk",
  path: "walk",
  pedestrian: "walk",
  steps: "steps",
  cycleway: "cycle",
  bridleway: "cycle",
  service: "drive",
};

for (const el of raw.elements) {
  const tags = el.tags ?? {};
  if (el.type === "node") {
    if (tags.natural === "tree" && el.lat !== undefined && el.lon !== undefined) {
      const [x, z] = recenter(project({ lon: el.lon, lat: el.lat }));
      if (insideOutline(x, z)) {
        trees.push(round1(x), round1(z));
      }
    }
    continue;
  }
  if (el.type === "relation") {
    if (tags.natural === "water" && el.members !== undefined) {
      const outers = el.members
        .filter((m) => m.type === "way" && m.role !== "inner" && m.geometry !== undefined)
        .map((m) => m.geometry!);
      for (const ring of stitchRings(outers)) {
        addPoly(water, ring);
      }
    }
    continue;
  }
  if (el.geometry === undefined || el.id === outlineEl.id) {
    continue;
  }
  const pts = el.geometry.map(project).map(recenter);
  const closed = pts.length >= 4 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1];
  const hw = tags.highway;
  if (hw !== undefined && PATH_KIND[hw] !== undefined) {
    const simplified = simplify(pts, PATH_TOL);
    if (simplified.length >= 2 && mostlyInside(simplified)) {
      paths.push({ k: PATH_KIND[hw], pts: flat(simplified) });
    }
  } else if ((tags.natural === "water" || tags.water !== undefined) && closed) {
    addPoly(water, pts.slice(0, -1));
  } else if (tags.natural === "wood" || tags.natural === "scrub") {
    if (closed) {
      addPoly(woods, pts.slice(0, -1));
    }
  } else if (tags.leisure === "garden") {
    if (closed) {
      addPoly(gardens, pts.slice(0, -1));
    }
  } else if ((tags.landuse === "grass" || ["pitch", "playground", "common"].includes(tags.leisure ?? "")) && closed) {
    addPoly(lawns, pts.slice(0, -1));
  }
}

const layout = {
  meta: {
    name: "Central Park, New York",
    source: "OpenStreetMap via the Overpass API",
    license: "ODbL — © OpenStreetMap contributors, openstreetmap.org/copyright",
    baked: new Date().toISOString().slice(0, 10),
    lengthM: round1(lengthM),
    widthM: round1(widthM),
  },
  outline: flat(simplify([...outline, outline[0]], POLY_TOL).slice(0, -1)),
  water,
  lawns,
  gardens,
  woods,
  paths,
  trees,
};

await Bun.write(OUT_PATH, JSON.stringify(layout));
const kb = Math.round((await Bun.file(OUT_PATH).size) / 1024);
console.log(
  `baked ${OUT_PATH} (${kb} KB): park ${Math.round(lengthM)}×${Math.round(widthM)} m, ` +
    `${water.length} water, ${lawns.length} lawns, ${gardens.length} gardens, ${woods.length} woods, ` +
    `${paths.length} paths, ${trees.length / 2} trees`,
);
