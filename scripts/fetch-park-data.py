#!/usr/bin/env python3
"""Bake the public-domain Central Park world into public/assets/park/.

The park3d page (?src=open) and the room's ?env=park environment render the
WHOLE park — 59th→110th St, 5th Ave→Central Park West — plus a margin of the
city that frames it (the iconic aerial: a green rectangle cut out of the
Manhattan grid). Everything here is open government data, so unlike Google's
photogrammetry it may be stored, modified, and shipped offline:

  ortho.jpg      USDA NAIP leaf-on orthoimagery via the USGS National Map
                 export endpoint (public domain). NAIP is flown in summer, so
                 the park reads as the lush green of the postcard; the NYS
                 15 cm orthos are sharper but leaf-off (bare brown trees).
  dem.bin        USGS 3DEP bare-earth elevation (National Map image
                 service), Int16 little-endian DECIMETRES relative to the park
                 centre's surface height, row 0 = north edge.
  relief.png     Tree-canopy height field (8-bit, 0.1 m units) derived from
                 the ortho: leaf-on canopy is textured dark green, lawns are
                 smooth bright green, water is smooth and dark — a local-
                 variance classifier separates them. Displacing the terrain by
                 it gives the canopy real mass from the air (the same lumpy
                 look photogrammetry has) without any tree models.
  buildings.json NYC DOITT building footprints with roof heights (NYC Open
                 Data, dataset 5zhs-2jue) in local decimetres — the skyline
                 that makes the rectangle read as Central Park and not as any
                 park: the Plaza, the San Remo, Billionaires' Row, the Met.
  manifest.json  The frame (centre, axis bearing, park/segment extents, the
                 covered rectangle) and per-file dimensions.

Local frame (shared with src/park3d/park-frame.ts): metres, +X east, −Z
north, origin at the park centre; web-mercator metres are converted to true
metres by cos(lat) (locally uniform). Needs numpy + Pillow.

    python3 scripts/fetch-park-data.py            # full bake (~6 MB, ~1 min)
    python3 scripts/fetch-park-data.py --ortho nys  # leaf-off 15 cm variant
"""
import argparse
import io
import json
import math
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

import numpy as np
from PIL import Image

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "assets", "park")

# ── the frame ───────────────────────────────────────────────────────────────
# Park centre (midpoint of the corner diagonals, ~85th St on the centre line).
CENTER_LAT = 40.7829
CENTER_LON = -73.9656
# Manhattan grid: the park's long axis runs ~29° east of true north.
AXIS_BEARING_DEG = 29.0
# 59th→110th St is ~4.08 km; 5th Ave→CPW ~0.85 km.
PARK_HALF_LEN = 2040.0
PARK_HALF_WIDTH = 424.0
# The branch's original evaluation slab (110th→90th St), kept as a crop mode.
SEGMENT_LAT = 40.7922
SEGMENT_LON = -73.9584
SEGMENT_HALF_LEN = 805.0
SEGMENT_HALF_WIDTH = 465.0
# City margin around the park rectangle, along the axis (south, north) and
# across (each side). South reaches ~48th St so Billionaires' Row and the
# Midtown wall stand in the foreground of the classic view from the south;
# across covers to Park Ave / Columbus Ave so the avenue walls are solid.
MARGIN_SOUTH = 900.0
MARGIN_NORTH = 250.0
MARGIN_ACROSS = 400.0

MERC = 20037508.342789244
DEG = math.pi / 180.0


def lon_to_merc_x(lon):
    return lon / 180.0 * MERC


def lat_to_merc_y(lat):
    return math.log(math.tan(math.pi / 4 + lat * DEG / 2)) / math.pi * MERC


def merc_x_to_lon(x):
    return x / MERC * 180.0


def merc_y_to_lat(y):
    return (2 * math.atan(math.exp(y / MERC * math.pi)) - math.pi / 2) / DEG


COS_LAT = math.cos(CENTER_LAT * DEG)
CX = lon_to_merc_x(CENTER_LON)
CY = lat_to_merc_y(CENTER_LAT)


def local_to_merc(x, z):
    """Local metres (x east, z south) → web-mercator metres."""
    return CX + x / COS_LAT, CY - z / COS_LAT


def merc_to_local(mx, my):
    return (mx - CX) * COS_LAT, -(my - CY) * COS_LAT


def lonlat_to_local(lon, lat):
    return merc_to_local(lon_to_merc_x(lon), lat_to_merc_y(lat))


def frame_extent():
    """Half-extents (east, north) of the axis-aligned rectangle that covers the
    rotated park-plus-margin slab."""
    b = AXIS_BEARING_DEG * DEG
    ax = (math.sin(b), -math.cos(b))  # along-axis unit vector (x, z)
    px = (math.cos(b), math.sin(b))  # across-axis unit vector (x, z)
    xs, zs = [], []
    for a in (-(PARK_HALF_LEN + MARGIN_SOUTH), PARK_HALF_LEN + MARGIN_NORTH):
        for p in (-(PARK_HALF_WIDTH + MARGIN_ACROSS), PARK_HALF_WIDTH + MARGIN_ACROSS):
            xs.append(a * ax[0] + p * px[0])
            zs.append(a * ax[1] + p * px[1])
    half_east = math.ceil(max(abs(min(xs)), abs(max(xs))))
    half_north = math.ceil(max(abs(min(zs)), abs(max(zs))))
    return half_east, half_north


OPENER = urllib.request.build_opener()
OPENER.addheaders = [("User-Agent", "vibersyn-park-fetch/1.0")]
urllib.request.install_opener(OPENER)


def fetch(url, timeout=180):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return r.read()
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise SystemExit(f"fetch failed: {url.split('?')[0]} — {error}") from error


# ── orthoimagery ────────────────────────────────────────────────────────────
USGS_EXPORT = "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/export"
NYS_EXPORT = "https://orthos.its.ny.gov/arcgis/rest/services/wms/Latest/MapServer/export"
EXPORT_MAX = 4096


def fetch_ortho(half_east, half_north, source, px_per_m):
    """One stitched image of the extent at ~px_per_m, from ≤4096² exports."""
    width = int(round(2 * half_east * px_per_m))
    height = int(round(2 * half_north * px_per_m))
    endpoint = USGS_EXPORT if source == "naip" else NYS_EXPORT
    print(f"[ortho] {source}: {width}x{height} px ({1 / px_per_m:.2f} m/px)")
    out = Image.new("RGB", (width, height))
    cols = math.ceil(width / EXPORT_MAX)
    rows = math.ceil(height / EXPORT_MAX)
    for r in range(rows):
        for c in range(cols):
            x0 = c * EXPORT_MAX
            y0 = r * EXPORT_MAX
            w = min(EXPORT_MAX, width - x0)
            h = min(EXPORT_MAX, height - y0)
            # pixel → local metres → mercator bbox for this strip
            lx0 = -half_east + x0 / px_per_m
            lx1 = lx0 + w / px_per_m
            lz0 = -half_north + y0 / px_per_m
            lz1 = lz0 + h / px_per_m
            mx0, my1 = local_to_merc(lx0, lz0)
            mx1, my0 = local_to_merc(lx1, lz1)
            q = urllib.parse.urlencode(
                {
                    "bbox": f"{mx0},{my0},{mx1},{my1}",
                    "bboxSR": "3857",
                    "imageSR": "3857",
                    "size": f"{w},{h}",
                    "format": "jpg",
                    "f": "image",
                }
            )
            print(f"  export strip r{r} c{c}: {w}x{h}")
            img = Image.open(io.BytesIO(fetch(endpoint + "?" + q))).convert("RGB")
            if img.size != (w, h):
                img = img.resize((w, h), Image.LANCZOS)
            out.paste(img, (x0, y0))
    return out


# ── elevation ───────────────────────────────────────────────────────────────
# USGS 3DEP via the National Map's elevation image service: one float32 TIFF
# of bare-earth metres at exactly our grid. (The Mapzen/AWS terrarium tiles
# the first cut used carry corrupted blocks over Manhattan — ramps down to
# −24 km — so they were dropped in favour of the source itself.)
USGS_3DEP = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage"


def fetch_dem(half_east, half_north, step_m):
    """Regular local grid of heights (metres), row 0 = north edge, sample i at
    x = −half_east + i·step; returns (grid, h0) with h0 the centre height."""
    cols = int(round(2 * half_east / step_m)) + 1
    rows = int(round(2 * half_north / step_m)) + 1
    # exportImage maps the bbox to pixel EDGES, so pad by half a cell to put
    # pixel centres exactly on the grid nodes.
    mx0, my1 = local_to_merc(-half_east - step_m / 2, -half_north - step_m / 2)
    mx1, my0 = local_to_merc(half_east + step_m / 2, half_north + step_m / 2)
    q = urllib.parse.urlencode(
        {
            "bbox": f"{mx0},{my0},{mx1},{my1}",
            "bboxSR": "3857",
            "imageSR": "3857",
            "size": f"{cols},{rows}",
            "format": "tiff",
            "pixelType": "F32",
            "noData": "-9999",
            "interpolation": "RSP_BilinearInterpolation",
            "f": "image",
        }
    )
    print(f"[dem] 3DEP export {cols}x{rows} @ {step_m} m")
    grid = np.asarray(Image.open(io.BytesIO(fetch(USGS_3DEP + "?" + q)))).astype(np.float32)
    if grid.shape != (rows, cols):
        raise SystemExit(f"3DEP returned {grid.shape}, wanted {(rows, cols)}")
    nodata = grid < -1000
    if nodata.any():
        print(f"[dem] {nodata.sum()} nodata cells → 0 m")
        grid[nodata] = 0.0
    h0 = float(grid[rows // 2, cols // 2])
    print(f"[dem] centre {h0:.1f} m, range {grid.min():.1f}..{grid.max():.1f}")
    return grid, h0


# ── canopy relief ───────────────────────────────────────────────────────────
def box_blur(a, r):
    """Mean over a (2r+1)² window via an integral image (edge-padded)."""
    k = 2 * r + 1
    p = np.pad(a, r, mode="edge").astype(np.float64)
    c = np.cumsum(np.cumsum(p, 0), 1)
    c = np.pad(c, ((1, 0), (1, 0)))
    H, W = a.shape
    s = c[k : k + H, k : k + W] - c[0:H, k : k + W] - c[k : k + H, 0:W] + c[0:H, 0:W]
    return (s / (k * k)).astype(np.float32)


def park_mask(half_east, half_north, px_per_m, pad=12.0):
    """1 inside the (rotated) park rectangle, 0 outside — relief is a PARK
    feature; the streets keep their buildings instead of bumpy sidewalks."""
    width = int(round(2 * half_east * px_per_m))
    height = int(round(2 * half_north * px_per_m))
    xs = -half_east + (np.arange(width) + 0.5) / px_per_m
    zs = -half_north + (np.arange(height) + 0.5) / px_per_m
    gx, gz = np.meshgrid(xs, zs)
    b = AXIS_BEARING_DEG * DEG
    along = gx * math.sin(b) - gz * math.cos(b)
    across = gx * math.cos(b) + gz * math.sin(b)
    return ((np.abs(along) <= PARK_HALF_LEN + pad) & (np.abs(across) <= PARK_HALF_WIDTH + pad)).astype(np.float32)


def build_relief(ortho, half_east, half_north, seed=0x5041524B):
    """Canopy height field (metres) at 2 m/px from a LEAF-ON (NAIP) ortho —
    the classifier below keys on summer canopy colour, so the caller passes
    NAIP here even when the shipped ortho.jpg is the leaf-off NYS variant."""
    # Classify at 1 m/px. Leaf-on canopy is DARK green (V ≲ 95: crowns shade
    # each other and the ground between them); lawns are bright green
    # (V ≳ 100); water is dark, smooth and blue-shifted; paths, rock and roofs
    # are grey (no excess green). A local-variance rule was tried first and
    # rejected: dense canopy is uniform, and every sharp lawn/ballfield edge
    # lit up as a halo that dragged the lawn texture up the canopy walls.
    w1 = int(round(2 * half_east))
    h1 = int(round(2 * half_north))
    im = np.asarray(ortho.resize((w1, h1), Image.BILINEAR)).astype(np.float32)
    R, G, B = im[..., 0], im[..., 1], im[..., 2]
    exg = box_blur(2 * G - R - B, 1)
    V1 = box_blur(im.max(-1), 1)
    L = 0.3 * R + 0.59 * G + 0.11 * B
    m = box_blur(L, 4)
    std = np.sqrt(np.maximum(box_blur(L * L, 4) - m * m, 0))
    water = (box_blur(im.max(-1), 4) < 85) & (std < 5) & (box_blur(B - R, 2) > 0)
    canopy = (exg > 8) & (V1 < 95) & ~water
    # Speck cleanup (2 m blur + re-threshold) then a light erosion so the
    # relief's slope starts a metre or two inside the crown edge, on tree
    # pixels, and a wider blur to round the crowns.
    mask = (box_blur(canopy.astype(np.float32), 2) > 0.5).astype(np.float32)
    mask = (box_blur(mask, 2) > 0.6).astype(np.float32)
    mask *= park_mask(half_east, half_north, 1.0)
    cover = box_blur(mask, 3)
    # Crown bumps: two octaves of blurred noise so the canopy is lumpy, not a
    # flat slab — individual crowns 12-20 m, gaps lower.
    rng = np.random.default_rng(seed)
    noise = box_blur(rng.random((h1, w1), dtype=np.float32), 3) * 0.6 + box_blur(rng.random((h1, w1), dtype=np.float32), 8) * 0.4
    noise = (noise - noise.mean()) / (noise.std() + 1e-6)
    height = cover * np.clip(13.0 + 4.0 * noise, 6.0, 22.0)
    print(f"[relief] canopy cover {100 * mask.mean():.1f}% of frame, water {100 * water.mean():.1f}%")
    # Down to 2 m/px for the file.
    rel = Image.fromarray(np.clip(height * 10.0, 0, 255).astype(np.uint8), "L").resize((w1 // 2, h1 // 2), Image.BILINEAR)
    return rel


# ── buildings ───────────────────────────────────────────────────────────────
SOCRATA = "https://data.cityofnewyork.us/resource/5zhs-2jue.geojson"
FT = 0.3048


def fetch_buildings(half_east, half_north):
    lon0, lat0 = merc_x_to_lon(CX - half_east / COS_LAT), merc_y_to_lat(CY - half_north / COS_LAT)
    lon1, lat1 = merc_x_to_lon(CX + half_east / COS_LAT), merc_y_to_lat(CY + half_north / COS_LAT)
    poly = f"POLYGON(({lon0} {lat0},{lon1} {lat0},{lon1} {lat1},{lon0} {lat1},{lon0} {lat0}))"
    q = urllib.parse.urlencode(
        {
            "$where": f"intersects(the_geom, '{poly}')",
            "$select": "the_geom,height_roof,ground_elevation,construction_year,name",
            "$limit": "50000",
        }
    )
    print("[buildings] querying NYC Open Data (5zhs-2jue)…")
    data = json.loads(fetch(SOCRATA + "?" + q, timeout=300))
    features = data["features"]
    print(f"[buildings] {len(features)} footprints")
    out = []
    dropped = 0
    for f in features:
        p = f["properties"]
        try:
            h = float(p.get("height_roof") or 0) * FT
        except ValueError:
            h = 0.0
        if h < 2.5:
            dropped += 1
            continue
        try:
            g = float(p.get("ground_elevation") or 0) * FT
        except ValueError:
            g = 0.0
        try:
            year = int(p.get("construction_year") or 0)
        except ValueError:
            year = 0
        geom = f["geometry"]
        polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
        for rings in polys:
            ring = simplify_ring([lonlat_to_local(lon, lat) for lon, lat in rings[0]])
            if ring is None:
                dropped += 1
                continue
            cx = sum(x for x, _ in ring) / len(ring)
            cz = sum(z for _, z in ring) / len(ring)
            if abs(cx) > half_east or abs(cz) > half_north:
                dropped += 1
                continue
            flat = []
            for x, z in ring:
                flat.append(int(round(x * 10)))
                flat.append(int(round(z * 10)))
            out.append([int(round(h * 10)), int(round(g * 10)), year, flat])
    print(f"[buildings] kept {len(out)}, dropped {dropped} (tiny / outside)")
    return out


def sample_grid(grid, half_east, half_north, step_m, x, z):
    """Bilinear height at a local point from the DEM grid (row 0 = north)."""
    u = min(grid.shape[1] - 1.001, max(0.0, (x + half_east) / step_m))
    v = min(grid.shape[0] - 1.001, max(0.0, (z + half_north) / step_m))
    i, j = int(u), int(v)
    fu, fv = u - i, v - j
    return float(
        grid[j, i] * (1 - fu) * (1 - fv)
        + grid[j, i + 1] * fu * (1 - fv)
        + grid[j + 1, i] * (1 - fu) * fv
        + grid[j + 1, i + 1] * fu * fv
    )


# Sheep Meadow (66th–69th St): the room's anchor and the ground-level preset.
# Mirrored in src/park3d/park-frame.ts (SHEEP_MEADOW, SHEEP_MEADOW_GROUND_M).
SHEEP_MEADOW_LAT = 40.772
SHEEP_MEADOW_LON = -73.9748


def simplify_ring(pts, min_step=0.8, min_area=10.0):
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts = pts[:-1]
    kept = []
    for x, z in pts:
        if kept and math.hypot(x - kept[-1][0], z - kept[-1][1]) < min_step:
            continue
        kept.append((x, z))
    if len(kept) > 2 and math.hypot(kept[0][0] - kept[-1][0], kept[0][1] - kept[-1][1]) < min_step:
        kept.pop()
    if len(kept) < 3:
        return None
    area = 0.0
    for i in range(len(kept)):
        x0, z0 = kept[i]
        x1, z1 = kept[(i + 1) % len(kept)]
        area += x0 * z1 - x1 * z0
    if abs(area) / 2 < min_area:
        return None
    return kept


# ── main ────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ortho", choices=["naip", "nys"], default="naip", help="imagery source (naip = leaf-on, default)")
    ap.add_argument("--px-per-m", type=float, default=1.08, help="ortho resolution (default ~0.93 m/px)")
    ap.add_argument("--dem-step", type=float, default=8.0, help="DEM grid step in metres")
    ap.add_argument("--skip-buildings", action="store_true")
    args = ap.parse_args()

    half_east, half_north = frame_extent()
    print(f"[frame] ±{half_east} m east, ±{half_north} m north around {CENTER_LAT},{CENTER_LON}")

    # Fetch and compute EVERYTHING before writing anything, so a failed
    # request (Socrata is the slow one) can never leave dem.bin or ortho.jpg
    # newer than the manifest that describes them.
    ortho = fetch_ortho(half_east, half_north, args.ortho, args.px_per_m)
    leaf_on = ortho if args.ortho == "naip" else fetch_ortho(half_east, half_north, "naip", 1.0)
    relief = build_relief(leaf_on, half_east, half_north)
    grid, h0 = fetch_dem(half_east, half_north, args.dem_step)
    dem = np.clip(np.round((grid - h0) * 10.0), -32768, 32767).astype("<i2")
    buildings_path = os.path.join(ROOT, "buildings.json")
    buildings = None
    if args.skip_buildings and os.path.exists(buildings_path):
        count = len(json.load(open(buildings_path))["buildings"])
    else:
        buildings = fetch_buildings(half_east, half_north)
        count = len(buildings)
    meadow_x, meadow_z = lonlat_to_local(SHEEP_MEADOW_LON, SHEEP_MEADOW_LAT)
    meadow_ground = sample_grid(grid, half_east, half_north, args.dem_step, meadow_x, meadow_z) - h0
    print(f"[anchor] Sheep Meadow at ({meadow_x:.1f}, {meadow_z:.1f}), ground {meadow_ground:+.1f} m vs centre")

    manifest = {
        "center": {"lat": CENTER_LAT, "lon": CENTER_LON, "surfaceHeightM": round(h0, 2)},
        "axisBearingDeg": AXIS_BEARING_DEG,
        "park": {"halfLen": PARK_HALF_LEN, "halfWidth": PARK_HALF_WIDTH},
        "segment": {
            "lat": SEGMENT_LAT,
            "lon": SEGMENT_LON,
            "halfLen": SEGMENT_HALF_LEN,
            "halfWidth": SEGMENT_HALF_WIDTH,
        },
        "margin": {"south": MARGIN_SOUTH, "north": MARGIN_NORTH, "across": MARGIN_ACROSS},
        "extent": {"halfEast": half_east, "halfNorth": half_north},
        "anchors": {
            "sheepMeadow": {
                "lat": SHEEP_MEADOW_LAT,
                "lon": SHEEP_MEADOW_LON,
                "x": round(meadow_x, 1),
                "z": round(meadow_z, 1),
                "groundM": round(meadow_ground, 1),
            }
        },
        "ortho": {"file": "ortho.jpg", "width": ortho.width, "height": ortho.height, "source": args.ortho},
        "dem": {"file": "dem.bin", "cols": dem.shape[1], "rows": dem.shape[0], "stepM": args.dem_step, "unitM": 0.1},
        "relief": {"file": "relief.png", "width": relief.width, "height": relief.height, "unitM": 0.1},
        "buildings": {"file": "buildings.json", "count": count, "unitM": 0.1},
    }

    # ── write ───────────────────────────────────────────────────────────────
    os.makedirs(ROOT, exist_ok=True)
    ortho.save(os.path.join(ROOT, "ortho.jpg"), quality=82, optimize=True)
    relief.save(os.path.join(ROOT, "relief.png"), optimize=True)
    dem.tofile(os.path.join(ROOT, "dem.bin"))
    if buildings is not None:
        with open(buildings_path, "w") as f:
            # One building per line keeps diffs readable at ~2 MB.
            f.write('{"units":"decimetres","fields":["roofHeight","groundElevation","year","ring[x,z,...]"],"buildings":[\n')
            f.write(",\n".join(json.dumps(b, separators=(",", ":")) for b in buildings))
            f.write("\n]}\n")
    with open(os.path.join(ROOT, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")

    total = sum(os.path.getsize(os.path.join(ROOT, n)) for n in os.listdir(ROOT))
    print(f"[done] {total // 1024} KB in {os.path.relpath(ROOT)}")


if __name__ == "__main__":
    sys.exit(main())
