# Central Park rendering

The browser renderer uses locally stored park data and models, with generated
material textures. It needs no cloud rendering or external asset service.

## Visual systems

- `park-atmosphere.ts`: physical sky, ACES exposure, environment lighting,
  and one sun shadow map. Shadow coverage follows the camera. Elevated
  project overviews ease the haze and widen shadow coverage. Renderer
  settings are restored when leaving the park.
- `park-outline.ts`: the mapped park boundary controls surface materials,
  building exclusion and planting. The rectangle in `park-frame.ts` remains
  the coordinate/crop frame. Spatial buckets accelerate boundary queries.
- `park-streets.ts` / `park-walks.ts`: mapped surrounding streets, sidewalks,
  perimeter walls and refreshed south-end walks. A 3,072-pixel local atlas
  puts broad road surfaces on the existing terrain; only nearby curbs and
  walls need separate geometry. This avoids road/terrain intersections and
  more than a million extra triangles from fully meshed carriageways.
- `park-walk-grade.ts` / `park-paths.ts`: walks shape narrow terrain corridors
  before triangulation. Actual shore contours clip the walking surface, and
  adaptive triangles follow banks without disappearing into terrain. Mapped
  stairs get horizontal treads and vertical risers; Gapstow's arch stays open.
  Distant walks use fewer segments and share vertices. `park-walk-materials.ts`
  uses retained OSM surface tags for asphalt, pavers, gravel/earth, mulch and
  wooden boards, batching each texture instead of making a mesh per way.
- `park-buildings.ts` / `park-roof-details.ts`: geographic extrusion is isolated
  from world loading. Nearby roofs have inset parapets, coping, recessed roof
  membranes and low access/mechanical housings. Details remain inside mapped
  footprints and roof-height limits. Convex footprints with extra survey
  vertices retain restrained setbacks; concave lots keep their silhouettes.
  Whole buildings and existing skyline models cast consistent sun shadows.
- `park-facades.ts`: generated color, relief and roughness maps distinguish
  recessed window panes, mullions, sills and matte masonry. Known prewar
  buildings retain masonry at tall heights. Reduced atmospheric density
  preserves more contrast in nearby façades.
- `park-materials.ts`: deterministic, page-cached turf, broadleaf sprays,
  weathered stone, and path textures. Leaf materials soften direct diffuse
  lighting using the existing shadowed light; no extra transmission pass.
- `park-grove-geometry.ts` / `park-grove.ts`: three distinct crown/trunk
  forms, each below 1,500 triangles, with spatial instancing and rounded
  crown normals. Curved forks, tapered root flares and layered foliage
  distinguish vase-shaped, tiered and irregular crowns. The nearest 16
  trees within 120 m retain photoscans.
- `park-wind.ts`: shared time/strength uniforms gently bend and flutter grove
  foliage. Instance positions vary the phase, and the same deformation runs
  in the leaf shadow material. Root geometry stays fixed; reduced motion sets
  wind strength to zero, including preference changes while the room is open.
  Instance bounds include the small crown displacement.
- `park-ground.ts` / `park-terrain-grid.ts`: continuous, linear grass/soil
  albedo and a graded terrain grid. Two-metre sampling around the lawn
  and Pond gradually becomes 18 m near the distant city. Paths and project
  placement interpolate those exact rendered triangles.
- `park-pond-material.ts`: gentler normals and reflection distortion, with
  an olive margin fading into deeper green water. The gradient follows the
  water mask; it represents optical shoreline coverage, not measured depth.
  Three's Fresnel, sun, shadows and color management remain in use.
- `park-shoreline.ts`: patchy sedges and cattails rooted on rendered banks,
  clear of mapped paths and Gapstow's approaches. Two solid geometries stay
  below 300 triangles per clump, use spatial instancing and distance culling,
  and add no texture downloads. Only the taller cattails join reflections.
- `park-reflection.ts`: planar reflections update at full rate during
  camera movement, and at up to 30 Hz at rest. Ripple animation continues
  each frame. Projection changes invalidate the cached reflection.
- `park-cameras.ts`: lawn, Pond, overlook and Wollman views, plus a content fit that
  accounts for viewport aspect and crown size. It no longer stops at 40 m
  when a larger forest needs more room. Fixed projector rigs retain their
  camera restrictions.
- `park-furniture.ts`: instanced slatted benches and acorn lamps, with
  explicit geometry/material cleanup on environment changes.

The room limits terrain and building geometry to a 1,250 m neighbourhood.
Its controlled ground palette removes baked photograph shadows and avoids
fetching/decoding the 4.9 MB orthophoto. The separate aerial page retains
its photograph, regular terrain grid, and optional canopy displacement.
Each connected water body has a level surface, carved bed, graded bank,
and clipped shoreline. Dry bank vertices now meet the water contour instead
of following the submerged bed profile, removing the artificial trench at
the shoreline. Water geometry is independent of terrain detail.

Gapstow has an open arch, earthen approaches, metre-scale masonry UVs,
irregular stone courses, and hanging ivy clusters. Simple tower footprints
receive restrained roof setbacks while retaining their geographic footprint
and height. These are illustrative architectural details, not surveyed
building models; existing detailed landmark models are preserved.

Project trees retain branch IDs, picking, status adornments, and shadows.
Broader leaf sprays need fewer animated instances. Fine landscape plants
are distance-culled in spatial batches, with hysteresis to avoid flickering
at the cutoff. Trees and rocks remain in wide views. Zen also hides the
clock, fullscreen button, and project navigation, including keyboard focus.

## Verification

- Earlier full unit suite: 2,622 passed, 20 credential-dependent tests skipped.
- Current park suite: 66 passed; 324 passed including the relevant room,
  projector and spatial-navigation suites. Coverage includes terrain/ray agreement on the
  nonuniform grid, crown geometry budgets, building/bridge winding and
  openings, shoreline clipping, reflection invalidation, and fitting
  2/32/64 projects at multiple camera angles and viewport proportions.
- New shoreline tests cover optical coverage, dry-bank continuity, the
  installed Water shader integration, planting clearances, rooted geometry,
  room-coordinate culling and disposal on environment changes.
- Walk tests cover steep crossfalls, shore clipping, bank-ridge subdivision,
  corridor continuity at junctions and bucket boundaries, waterbed/bridge
  preservation, stair winding and natural path margins/material batches.
- City tests cover the true outline and its padding, street dimensions,
  junction clearances, geometry budgets, actual wall openings, façade
  classification and joining refreshed walks to the older northern network.
- Production build and TypeScript checks passed. The development graphics
  fixture was also checked explicitly (the main tsconfig excludes e2e).
- Browser checks cover planting controls, branch controls, park cameras,
  environment switches, narrow screens, Zen, and fixed projector cameras.
  Software-rendered automation skips heavy park assets, so real GPU
  inspection is a separate required check.
- Real GPU inspection covered the lawn, Pond, overlook, project selection,
  Orbit/Meadow return trips, and a 32-project fixture. LM Studio's local
  `room-local-code` endpoint generated synthetic code during load checks.
  No real project data was changed by the graphics fixture.

## Full graphics regression

On a machine with hardware WebGL, run:

```sh
VIBERSYN_PORT=18998 VIBERSYN_PARK_GPU=1 bun run test:e2e e2e/park-gpu.e2e-pw.ts --workers=1
```

Add `VIBERSYN_PARK_DPR=2` to exercise a 2,560 × 1,800 drawing canvas.
Add `VIBERSYN_PARK_MOTION=1` to enable motion and retain a WebM recording.
Recording and screenshot capture add overhead; frame samples are diagnostic,
not a formal frame-rate benchmark. The default test context now places
`reducedMotion` under Playwright's `contextOptions`, where it is actually
supported. The hardware test also toggles this preference without reloading
the scene and verifies that the mounted room responds. After correcting the
preference option, all nine navigation tests and the full graphics test passed;
the live preference toggle then passed on a fresh final build as well.
The opt-in test uses Metal on macOS, requires `data-park-ready=true`, and
fails if it sees software rendering, too little geometry, shader/load errors
or WebGL context loss. It captures the four park presets and portrait UI/Zen
views, then checks Orbit and Meadow return trips. PNGs and renderer/frame
samples are written under `test-results/`. Images require human/agent review;
the test does not decide whether a scene looks good. It uses an isolated,
in-memory demo room and does not change live projects.

The walk and rooftop passes were inspected through these full-renderer captures. Junction
edging and abrupt bank grading were corrected after the first screenshots.
Rooftop review also caught isolated parapet shadows; building bodies and
landmark models now cast alongside their details. Frame diagnostics are read
before screenshots to avoid including the capture readback in those samples.
The Mac's locked screen prevented direct interaction with the user's existing
tab during this pass; the separate hardware-rendered browser test succeeded.

## Reproducing the larger forest

Run the Vite development server and open
`/e2e/park-performance.html?trees=32&live=0`. The fixture supports 1–64
projects, forces the offline transport before mounting, and is excluded
from the production entry. Click **Fit** to frame the complete forest;
the initial lawn camera deliberately shows only the nearby projects.
Use Zen to inspect the scene without panels, and Escape to restore them.

## Measurements and their limits

Inspect `data-*` on `[data-testid="room-scene"]`:

- `triangles` / `draw-calls`: the latest sampled complete render, including
  any reflection and shadow work. Automatic nested resets are disabled.
- `average-triangles` / `average-draw-calls`: averages since the previous
  diagnostics update, useful because reflections and shadows skip frames.
- `frame-ms` / `frame-p95-ms`: recent animation-frame intervals, including
  stalls. These are not GPU timer measurements or long-run percentiles.
- `pixel-ratio`: the adaptive drawing resolution.

On the M4 Max at a 1,904 × 1,996 drawing canvas, pixel ratio 2, and the same
Pond camera with two projects, the original instrumented frame contained
5.66 million triangles. The intermediate adaptive-terrain version contained
3.42 million, about 40% fewer before adding reflection reuse. A later idle
sample averaged about 2.27 million triangles and 8.3 ms between frames.
The original default Three.js counters undercounted nested rendering and
must not be used as the baseline.

A fully fitted 32-project development fixture exposed much more of the
park and skyline. Distance-culling fine vegetation reduced an observed
wide-view average from about 1,430 draw calls to 718. These local snapshots
vary with camera position, shadow cadence, model inference, development
versus production builds, and other GPU work. They are not guaranteed FPS
or a claim that all devices can sustain the same quality.

The Pond/vegetation detail pass on 2026-09-06 averaged approximately 2.06
million triangles and 154 draw calls in the live two-project Pond view at
1,832 × 1,884 drawing pixels, pixel ratio 2. Recent frame intervals averaged
9.2 ms, with a 24.4 ms p95. The finer terrain and fuller crowns increase
geometry cost; this pass improves appearance rather than claiming a speedup.
The shoreline itself uses 264 clumps in spatial batches and no additional
render target. These are brief local diagnostics, not a controlled benchmark.

After the city/perimeter pass, the same live Pond preset at 1,832 × 1,884
pixels averaged about 2.17 million triangles, 167 draw calls and 10.1 ms frame
intervals, with a 31.4 ms p95. This adds street and perimeter detail with a
modest geometry increase, but the longer frames still require profiling.
The walk pass now has about 198,000 path triangles and 201,000 vertices in
this neighbourhood. Its initial uniformly dense version had about 518,000
triangles and 1.55 million vertices. These are mesh counts, not full-frame
render costs or measured speedups. A check of triangle centroids within 400 m
of the project lawn found no buried walk or stair triangles. Exact path geometry
still depends on the modeled DEM grading.

The visual improvement goal remains open; see the [current audit](central-park-visual-audit.md).

## Spatial controls

Controls contains **Plant an idea**, **Projects**, the **Explore** movement and
view pads, room settings, and **Help & shortcuts**. Planting starts with an idea;
a GitHub repository or reference URL is optional. The panel remains open until
closed, clicked outside, or replaced by another panel.

In the room and `/hands` guest controller, hold a direction with a mouse, touch,
or Space/Enter. Enable **Dwell to move** for mouse hover: a 700 ms progress bar
precedes continuous movement. Room hand/guest cursors use the existing dwell
ring and keep moving until their original cursor leaves the direction.
Releasing, cancelling touch, losing focus, hiding the page, or covering/closing
the pad releases its input. Guest heartbeats retain the existing 1.5 s stale
release. Independent sources cannot release one another's held directions.

W/A/S/D move relative to the view; arrows turn or raise/lower the view; =/− zoom;
Home or **Back to projects** frames the trees again. F fits, while Shift+F changes
fullscreen. Flat projector pairs share a moving pose with the same movement
vocabulary; rigid corner projector views remain fixed and disable their pads.

`e2e/spatial-navigation.e2e-pw.ts` checks real camera changes, sustained mouse and
remote dwell, keyboard and touch holds, stopping, and guest disconnection.

## Geographic accuracy

The south-end accuracy pass adds locally bundled OSM sites, corrected landmark
positions, mapped Gapstow dimensions and orientation, connected bridge
approaches, Wollman Rink and its camera view, and Hallett woodland coverage.
Vegetation avoids mapped paths and structures. The former 325 m clearing of
city blocks is removed. See [sources and limitations](central-park-accuracy.md).
