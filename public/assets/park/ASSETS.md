# Central Park world assets

This directory contains **public domain / open government data**, OpenStreetMap
data under ODbL, CC0 ground/bark scans and the CC BY landmark models listed below.
The geographic layers are baked by `scripts/fetch-park-data.py` and consumed by `src/park3d/park-world.ts`
(the `park3d.html?src=open` evaluation page and the room's `?env=park`
environment). Unlike Google's Photorealistic 3D Tiles (the page's default
`?src=tiles` stream, which may never be persisted), these files may be stored,
modified and shipped offline.

Frame: the whole park (59th → 110th St, 5th Ave → Central Park West) plus a
city margin — ~900 m south (to ~48th St, so the Midtown wall fronts the
classic aerial), 250 m north, 400 m to each side — as an axis-aligned
rectangle of ±2147 m east / ±2971 m north around the park centre
(40.7829, −73.9656). Local frame: metres, +X east, −Z north; see
`src/park3d/park-frame.ts`.

| File | Source | Notes |
| --- | --- | --- |
| `ortho.jpg` | USDA NAIP via the USGS National Map `USGSImageryOnly` export service | Leaf-on summer imagery (~0.93 m/px, 4638×6417) — the lush green of the postcard. The NYS 15 cm orthos are sharper but leaf-off; `--ortho nys` bakes them instead. |
| `dem.bin` | USGS 3DEP via the National Map `3DEPElevation` image service | Bare-earth heights on an 8 m grid (538×744), Int16 little-endian decimetres relative to the park centre's surface (34.6 m), row 0 = north. |
| `relief.png` | derived from the NAIP imagery (always leaf-on, even under `--ortho nys`) | Tree-canopy height field at 2 m/px, 8-bit in 0.1 m units (0–22 m). Leaf-on canopy is dark green, lawns bright green, water dark/smooth/blue-shifted — a colour classifier, restricted to the park rectangle, with noise for crown bumps. |
| `water.png` | OpenStreetMap `natural=water` polygons (© OpenStreetMap contributors, ODbL), rasterised at 2 m/px | The Lake, the Pond, Turtle Pond, the Reservoir, Harlem Meer, the Pool, Conservatory Water, the fountains, the river edges. The photo classifier is only a fallback when Overpass is down. |
| `paths.json` | OpenStreetMap footway/drive polylines clipped to the park (© OpenStreetMap contributors, ODbL) | 1.8k segments in local decimetres at photograph widths (~2.5 m walks); the runtime lays brick-edged ribbon geometry on the terrain and stands lamps/benches along them. |
| `streets.json` | OpenStreetMap centerlines, walls, walks and tree nodes (© OpenStreetMap contributors, ODbL) | Local south-end snapshot with source IDs, available dimensions and revision metadata. Refresh with `scripts/fetch-park-streets.py`; the same script stores the actual park outline in `src/park3d/data/park-outline.json`. Runtime street/sidewalk dimensions without tags are illustrative. |
| `waternormals.jpg` | three.js examples (MIT) | Normal map for the Pond's reflective Water material in the room. |
| `buildings.json` | NYC Open Data, DOITT Building Footprints (dataset `5zhs-2jue`) | 17k footprints with roof height, ground elevation, construction year; rings in local decimetres, one building per line. |
| `manifest.json` | — | The frame, per-file dimensions and anchors (Sheep Meadow's local position and ground height); `park-world.ts` validates it against `park-frame.ts` and the tests pin the two together. |

## Landmark models (`models/*.glb`)

The room's `?env=park` scene is ONE iconic place — Gapstow Bridge over the
Pond — and its skyline is real models on their true footprints (fetched and
repacked by `scripts/fetch-park-models.py` via the Objaverse mirror,
quantized + WebP, placement in `src/park3d/park-models.ts`). All are
**CC Attribution 4.0** from Sketchfab:

| File | Model | Author |
| --- | --- | --- |
| `plaza_hotel.glb` | [Plaza Hotel](https://sketchfab.com/3d-models/fd4b083aca0245379418564c9105b4a7) | mshukla |
| `central_park_tower.glb` | [Central Park Tower](https://sketchfab.com/3d-models/53c2458a58104c708390149fc942b03a) | NanoRay |
| `220_cps.glb` | [220 Central Park South](https://sketchfab.com/3d-models/84c23b63fdbe42c393fa4a96a68f4ada) | NanoRay |
| `one57.glb` | [One57](https://sketchfab.com/3d-models/60327eb81d1147f6bc4d248c51813085) | NanoRay |
| `steinway_tower.glb` | [111 West 57th Street — Steinway Tower](https://sketchfab.com/3d-models/94deba673b494217b76de75fd0d149fc) | NanoRay |
| `432_park.glb` | [432 Park Avenue](https://sketchfab.com/3d-models/d1071ed9bd9549a5a03c83b72fbaffd1) | NanoRay |

Re-bake the data with `python3 scripts/fetch-park-data.py` (needs numpy +
Pillow, ~30 s, ~9 MB) and the models with
`python3 scripts/fetch-park-models.py` (~10 MB). The Google tiles page needs
no bake.

## South-end control points

`src/park3d/data/south-park-sites.json` is a bundled OpenStreetMap extract
(© OpenStreetMap contributors, [ODbL](https://www.openstreetmap.org/copyright)).
It retains source way IDs, versions, modification times and the extract's
snapshot timestamp. `scripts/fetch-park-sites.py` refreshes these nineteen sites.
The renderer uses their geometry for landmark placement, Gapstow's outline,
Wollman's recreation surface, and Hallett's woodland boundary. See
[`docs/central-park-accuracy.md`](../../../docs/central-park-accuracy.md) for
sources, corrections, and the distinction between mapped and modeled detail.

The Arsenal footprint and tagged height come from OSM way 265347583, retrieved
through the OSM API on 2026-09-06 with its revision metadata. The procedural
model's material and architectural references are the
[NYC LPC designation report](https://s-media.nyc.gov/agencies/lpc/lp/0312.pdf)
and [Central Park Conservancy](https://www.centralparknyc.org/locations/arsenal).
No reference photographs are included in the application.

The Wollman clubhouse/service footprints are OSM ways 265347591 and 265347590,
retrieved from the OSM API on 2026-09-06. Their tags provide building heights.
The [operator's rink map](https://assets.wollmanrinknyc.com/wp-content/uploads/2025/01/07210056/WRNYC-Rink-Map-8.5x11-v01.pdf-1.pdf)
guides the overlook, clubhouse frontage, canopy and patio relationship. The
map remains a reference document; it is not bundled as a game texture.

The Zoo uses OSM ways 265347580, 108111424, 265347582, 265347584 and 108111423,
retrieved through the OSM map API on 2026-09-06. The WCS visitor guide informs
modeled pavilion roles, open galleries and the clock. No WCS photographs or
map images are distributed as textures. See the accuracy document for the
source link and the distinction between source outlines and modeled detail.

## Broadleaf bark (`bark/*.jpg`)

Six unchanged 1024×1024 maps from Poly Haven: diffuse color, OpenGL normal and
roughness for [Bark Willow](https://polyhaven.com/a/bark_willow) and
[Bark Platanus](https://polyhaven.com/a/bark_platanus). They are covered by
[Poly Haven's CC0 asset license](https://polyhaven.com/license). The willow
scan supplies a furrowed-bark approximation for elm/oak forms; it is not an
elm or oak scan. Plane-like trees use the Platanus scan.

`bark/sources.json` pins the original download URLs and MD5 hashes. Restore
missing/changed maps with `python3 scripts/fetch-park-materials.py`; validate the
committed copies without network access with `--check`. All runtime requests
use these local files. The combined payload is approximately 5 MiB.

Crown and leaf shapes are authored geometry and canvas textures, informed by
the Conservancy's [American elm](https://www.centralparknyc.org/plants/american-elm),
[red oak](https://www.centralparknyc.org/plants/red-oak) and
[London plane](https://www.centralparknyc.org/plants/london-plane) descriptions.
They illustrate genus-level traits, rather than reproduce individual trees.

## Grass surface (`ground/*.jpg`)

[Leafy Grass](https://polyhaven.com/a/leafy_grass) by Charlotte Baglioni,
under the [Poly Haven CC0 asset license](https://polyhaven.com/license). The
unchanged 1k diffuse/OpenGL-normal JPEG pair covers two metres. The ground
shader removes the source's average color, retaining local blades, leaves
and relief while the terrain palette controls the broad lawn/woodland hue.
This scan is illustrative ground detail, not a Central Park survey image.

`ground/sources.json` pins both source URLs and hashes.
`python3 scripts/fetch-park-materials.py --check` validates all eight bark/grass
files offline; omit `--check` to restore missing or changed files. The grass
pair adds 2.54 MiB of local asset payload and replaces the prior generated
ground albedo and unrelated aerial-rock normal map in the park material.

## Baked paving (`walks/*.png`)

Five local procedural textures retain the original seeded aggregate, paver,
earth, mulch and board painters. They are illustrative finishes, not survey
photographs. Baking removes approximately 357,500 canvas marks from each
fresh park startup. Aggregate remains 1024×1024; the other maps remain
512×512. Their PNG payload totals 3.54 MiB, with unchanged sampling and bump
scales. No external service is used during baking or runtime loading.

Run `bun scripts/bake-park-walk-textures.ts` to rebuild them from
`scripts/lib/park-walk-texture-paint.ts` using the installed Playwright
Chromium. `--check` validates committed dimensions and SHA-256 hashes against
`walks/manifest.json` without launching a browser or accessing the network.
Canvas rasterization can differ across browser/platform versions; intentional
rebakes update the manifest and should be inspected visually.
