# Central Park world assets

Everything in this directory is **public domain / open government data**,
baked by `scripts/fetch-park-data.py` and consumed by `src/park3d/park-world.ts`
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
| `buildings.json` | NYC Open Data, DOITT Building Footprints (dataset `5zhs-2jue`) | 17k footprints with roof height, ground elevation, construction year; rings in local decimetres, one building per line. |
| `manifest.json` | — | The frame, per-file dimensions and anchors (Sheep Meadow's local position and ground height); `park-world.ts` validates it against `park-frame.ts` and the tests pin the two together. |

Re-bake with `python3 scripts/fetch-park-data.py` (needs numpy + Pillow,
~30 s, ~9 MB). The Google tiles page needs no bake.
