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
- `park-grove-geometry.ts` / `park-grove.ts`: elm-like vase, rounded oak and
  spreading plane crowns follow mapped genera where available. Spatially
  instanced distant forms stay below 1,500 triangles. The nearest 16 trees
  within 120 m of the project lawn use 15,288–16,800 triangle detail forms,
  with smoother trunks, connected secondary forks and small leaf sprays.
  Model bounds preserve the selected 10–24 m mapped or 13–19 m inferred height.
- `park-broadleaf-texture.ts` / `park-bark.ts`: three cached 512-pixel leaf
  atlases distinguish serrated elm, pointed oak and palmate plane shapes.
  Locally bundled CC0 bark scans add color, normal and roughness detail.
  Six 1k bark maps add roughly 5 MiB of downloads; all nine textures together
  require about 36 MiB as RGBA8 with mipmaps. Textures persist for the page;
  instanced buffers, geometry templates and materials are disposed on exit.
- `park-tree-bases.ts`: splits the original wood triangles below 1.3 local
  metres into compact bases and instanced upper trunks. Each base follows
  the rendered terrain; position and normal changes fade out at the join.
  Fitted bases sharing bark and a spatial cell share a mesh. No triangles are
  added by the split and no terrain sampling runs per frame.
- `park-wind.ts`: shared time/strength uniforms gently bend and flutter grove
  foliage. Instance positions vary the phase, and the same deformation runs
  in the leaf shadow material. Root geometry stays fixed; reduced motion sets
  wind strength to zero, including preference changes while the room is open.
  Instance bounds include the small crown displacement.
- `park-ground.ts` / `park-ground-material.ts` / `park-terrain-grid.ts`:
  continuous linear grass/soil color, a locally bundled grass scan with
  matching normals and a graded terrain grid. Two offset texture samples
  reduce tiling; the broad terrain palette remains independent of scan color. Two-metre sampling around the lawn
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
- `park-cameras.ts`: lawn, Pond, overlook, Wollman, Arsenal and Zoo views, plus a content fit that
  accounts for viewport aspect and crown size. It no longer stops at 40 m
  when a larger forest needs more room. Fixed projector rigs retain their
  camera restrictions.
- `park-furniture.ts`: instanced World's Fair-style benches and Type B-style lamps, with
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

The Arsenal is a locally generated landmark on its OSM footprint, with an
independent foundation grade and a short entrance/walk connector. Brick,
granite, pale trim, windows and roof geometry merge into five meshes; a cached
512 px brick texture supplies running-bond courses. It adds no remote asset
request. Its camera stop is included in the full hardware-renderer regression.
The first 2× render was inspected for silhouette, grounding and street context;
that inspection caught the entrance gap subsequently corrected by the apron.
The corrected pass has 12,518 landmark triangles. All 69 park geometry tests,
the product/test typechecks and the 10 navigation/full-GPU scenarios passed.
The final Metal/Apple M4 Max capture rendered at 2,560 × 1,800 pixels with no
shader or page errors. Its entrance connection was visually rechecked. These
checks cover graphics and navigation; they do not re-run AI generation flows.

`park-understorey.ts` adds clustered low shrubs below wooded canopy. Its seed is
independent of existing flora, so the tree and furniture layout stays stable.
Two 280-triangle forms share foliage/bark materials and are instanced in 70 m
cells. Candidates avoid water, walks, open lawns, steep grades and the project
clearing. The nearest 900 plants cap dense-source cost; camera-distance culling
and nearby-only shadow casting bound the visible cost. This is illustrative
undergrowth, not a surveyed shrub inventory. Its first full GPU pass kept the
Pond frame interval at approximately 8.3 ms on the test M4 Max while adding
about 44k visible/pass triangles and 22 draws in that brief sample. Such samples
are diagnostics, not controlled performance comparisons or device guarantees.
After tapering the shrub tips, all 72 park tests and the product typecheck
passed. A fresh 2× hardware test revisited all five camera stops, live motion
preferences, environment returns and portrait views without GPU/page errors.

`park-wollman-facilities.ts` renders the clubhouse/service footprint in four
material batches. Its roof sampler carries the mapped overlook footway while
the terrain grade keeps the frontage clear and joins the rear hill to
the terrace. Frontage normals, rather than a center-based half-plane, classify
the curved building's approaches. Patio polygons project the mapped frontage
to the nearest rink edge and share a planting exclusion mask. The rink's
rough neutral surface now has fine aggregate detail. Source dimensions and
modeled details are distinguished in the accuracy document.
Actual mesh sampling exposed 1.6 m and 4.1 m approach drops that the analytic
grade checks missed. A buried rear ledge wider than the terrain-cell diagonal
supports the deck-edge vertices. The regression samples triangles at four grid
phases on both crossings of the real mapped roof footway.

Overlapping lower walk corridors also pulled down the terrace approaches;
the final terrain composition now preserves the facility's engineered grade
without applying its feather twice. The roof edge has a 3.25 m supporting
apron on either side, wider than the cell diagonal. An actual DEM/network/grid
check measures 0.08 m at both entries (the modeled deck thickness). All 75 park
tests, the product typecheck and a fresh 2× Metal browser pass succeeded after
this correction; the Wollman capture was inspected again.

`park-zoo-layout.ts` separates the retained connected roof into pavilions and
open galleries and defines their ground treatment. `park-zoo.ts` batches the
exterior model into eight meshes: brick, stone, slate, frames, glazing, water,
turf and planting. Simplified arch surrounds reduce its initial 79k triangles
to about 54k while preserving the silhouette, projecting sills and frame depth.
Roofs include ridge vertices and closed gables; all three clock passages are
open geometry, tested by ray casting. Generic woodland planting excludes the
new buildings and formal court. The smaller water bodies now use a lighter
green material; the Pond's separate reflective material is unchanged.

Zoo verification passed 78 park tests, the product typecheck and all ten
park/navigation browser scenarios. A further 2× Metal pass after the final
grade/glazing refinements visited all six camera stops, live reduced-motion
changes, environment returns and portrait views with no GPU/page errors.
The final Zoo and Pond captures were inspected. The final Zoo mesh count is
eight with 54,174 triangles; the test caps it at 60k. Real DEM checks cover the
northern court entries, including overlapping terrain feathers that previously
left an unwanted ridge. The source visitor map informed the improved camera
composition, with the Arsenal behind the court instead of obscuring it.

The Zoo roof coverage test initially exceeded Bun's five-second limit on CI:
it scanned all 54k model triangles for every sample. Restricting coverage rays
to slate/glazing surfaces preserves the roof check, while the three passage
rays still test the complete model. Local runtime fell from about 1.3 seconds
to 0.3 seconds. Commit `af46898` passed all CI jobs, including the full browser
suite and the branch/recovery/deck flow checks.

The small basins' three-wave normal map produced a visible repeated grating.
`park-water-ripples.ts` now supplies a phase-distorted, sixteen-wave spectrum
with normalized, seamless tangent-space normals. Generation remains cached
once per page. A seven-metre repeat, weaker perturbation, zero metalness and
moderate roughness soften the excessively regular highlights. Secondary water
also freezes its current phase when reduced motion is requested. The final
2× hardware pass and product typecheck succeeded; 79 park tests passed, with
normalization and tile-edge coverage for the new map. The final Zoo capture
was inspected after the strength/roughness refinement.

Bank grading now uses the clipped water contour, with spatial buckets for
nearby segments. This removes the four-neighbour distance field's diagonal
bias. Near the shore, mask gradients preserve continuity with the bilinear
water mask; the outer four metres blend back to the existing terrain instead
of dropping the grade abruptly. The profile remains an illustrative correction
to the DEM, not surveyed bathymetry. Tests cover directional invariance, outer
continuity and independently elevated water bodies.

The terrain material now adds restrained mineral grain on steep faces and
small, rotated leaf fragments under woodland. Two weights per vertex control
cover; the existing terrain draw supplies the detail with no new textures or
render passes. Subpixel leaf fragments fade to prevent distant shimmer. The
82 park tests, product typecheck and fresh 2× Metal browser pass succeeded.
The Pond capture was inspected. A full DEM/network/terrain diagnostic checked
84,344 nearby path faces: no upward walking face was buried; one vertical
stair riser extended 2.2 cm into the ground. It also confirmed that the camera's
old 1.4 m global lower bound can fall below the local hillside, requiring a
separate camera-floor correction.

Park exploration now clamps both the desired and interpolated camera poses
to 1.4 m above the local terrain, walkable decks or water. This permits the
lower Pond shore while keeping hillside movement above ground; it is not
general building/tree collision. Nine room/guest navigation scenarios and
the six-view hardware test passed. A separate hardware route lowered the
camera, crossed into the Pond basin and returned uphill, checking at least
1.39 m sampled clearance throughout (allowing diagnostic rounding). Its
shoreline and hillside screenshots were inspected. The first route assertion
used an arbitrary absolute return height; the final test checks actual ground
elevation gain instead, and passed on a fresh run.

`park-turf.ts` supplies close-view grass with five bent blades per tuft,
4.5–11 cm tall on open lawn and slightly taller under canopy. Fifteen solid
triangles avoid transparent billboard overdraw. Coordinate-seeded eight-metre
tiles recycle at most 49 instance buffers around the eye; terrain/mask sampling
is spread over frames. Blades fade from 16 to 26 m, and the whole layer fades
out above 18 m eye clearance. It receives shadows, skips reflection/shadow
casting, and freezes its wind phase for reduced motion. Paths, structures,
water and steep rock are excluded. Turf detail/normal textures now repeat at
three metres with weaker relief, after the close render exposed coarse blobs.

The turf pass passed 85 park tests, product and graphics-fixture TypeScript
checks, the six-view 2× Metal render, the shoreline route and six repeated
Orbit/Meadow return cycles. After warmup, the same lawn view retained exactly
151 GPU geometries, 79 textures and 78 shader programs across four further
cycles. These are resource counts for that view, not byte-level memory figures.
Close hillside captures were inspected and the initially sparse blades were
shortened/densified. A separate 32/64-project hardware fixture ran with motion
enabled and no page errors or API writes. It exposed overly wide automatic
project placement: Fit reached radii of 435/872 m. That layout needs correction;
successful rendering alone does not make the large forest usable.

`park-project-layout.ts` now retains the familiar first five candidate slots
and expands into compact hexagonal rows at 13 m spacing. Park roots use the
rendered ground height and reject mapped walks/structures, wet margins and
steep crossfalls. Explicitly planted locations keep their existing override
and reserve space from automatic roots. A world-load invalidation recomputes
slots once the real masks arrive. Meadow and abstract layouts retain their
existing arrangement. Candidate order is independent of project count.

The layout passed 154 park/scene unit tests and product/fixture typechecks.
Real Metal captures of 32/64 projects reduced Fit's radii from 435/872 m to
169/256 m. The separate development fixture now labels itself accurately and
accepts `mature=1` for full-grown trees with six branch tips each; the original
fixture only stressed saplings. Both mature sizes rendered with motion at
2× resolution, opened the project list and selected the last project's tree
controls without page errors or API writes. At 64 mature trees, brief frame
samples were 18.4–19.1 ms (p95 26.2–27.6 ms); branch-tip chrome remains visually
crowded and expensive at this overview distance. This is an open optimization,
not a claim of universal smooth performance.

The final production build passed all 13 combined browser scenarios: park
camera presets, room/guest/dwell navigation, phone workspace focus, the full
hardware rendering pass, low-shore exploration and repeated GPU rebuilds.
Earlier turf commit `31d4ed2` also passed all CI jobs, including live flows.

### Readable project forests and explicit focus — 2026-09-06

`tree-tip-detail.ts` fades branch cards by projected CSS-pixel height (18–30 px),
with a separate, earlier fade for their small additive glows. Subpixel buds stop
rendering; wood and branch pick volumes remain intact. Reduced motion applies
the settled values immediately. The frame loop reuses its projection scratch
vector and avoids allocations per label.

Show in garden now frames the actual grown body, accounting for planted ground
height and screen aspect. A repeated request also works after moving away with
Fit. Locked projector pairs retain their camera. Explicit project focus clears
the idea tray and transcript until the tree menu closes. Measured header and
navigation bands constrain the chip layout; on phones, small four-chip project
menus place identity above and actions below the scene. Larger branch menus
retain the existing constellation layout and still need focused visual review.

Fresh Metal/M4 Max captures at 1280×900 CSS pixels, DPR 2, with motion enabled:

| Mature projects | Overview draw calls | Average frame sample | p95 sample |
| --- | --- | --- | --- |
| 32 | 789–800 | 8.3–9.0 ms | 9.1–10.3 ms |
| 64 | 1,004–1,014 | 8.7–8.8 ms | 11.9–12.5 ms |

Each range covers six one-second diagnostic samples. The preceding 64-project
baseline was 2,877–2,906 draws, 18.4–19.1 ms average and 26.2–27.6 ms p95.
These short local checks are not a cross-device performance guarantee.

Screenshots cover overview, Zen, selected tree and a 390×844 phone. Close-range
verification found all six branch targets with the actual scene raycaster and
opened each through mouse clicks; the dwell bridge opened the expected branch
too. The fixture performed no API writes and emitted no browser errors.
Local evidence is under `.context/tip-focus-compact-quality-2026-09-06/` and
`.context/tip-focus-picking-2026-09-06/`. The layout/detail tests pass 96 cases;
product and graphics-fixture TypeScript checks also pass.
The additional 188 projector/component rendering tests pass as well.

The production regression checks pass: 13 existing park, hardware, room/guest
navigation and workspace scenarios, plus three new desktop/phone/repeated-focus
and locked-camera scenarios. The new test fixture initially put planting
positions on the process instead of the snapshot's `plantedPositions` field and
sampled the projector before its import-fit settled; those test setup errors
were corrected, then all three new scenarios passed. The live local-AI room at
port 18994 remains healthy with the same server boot and no degraded providers.

### Sharper Pond reflections — 2026-09-06

The fixed 768×768 planar reflection visibly undersampled building windows and
tree silhouettes at DPR 2. `ParkReflectionQuality` now reuses that cached render
target with up to four MSAA samples and a resolution derived from the drawing
buffer. Its longest side is capped at 1536 pixels; the other side follows the
screen aspect. Resize requests must settle for 250 ms, and unchanged frames
allocate nothing. Adaptive drawing-buffer resolution changes use the same path.
This increases the bounded reflection-buffer memory cost; resource counts alone
do not measure those bytes.

The fresh Pond screenshot has cleaner reflected façades and silhouette edges.
Its brief local frame sample remains 8.3 ms at DPR 2 on this M4 Max, with the
same approximate draw count. All six presets, low-shore navigation and six
environment rebuilds pass the full hardware checks. This is local evidence,
not a performance promise for other GPUs. Captures and measurements are under
`.context/reflection-quality-gpu-results/`.

The dedicated orientation check also passes: five alternating landscape/phone
sizes preserve the canvas, keep the mirror within its resolution bound and emit
no browser/GPU errors. DPR 2 uses a 1536×1080 mirror at 1280×900 CSS pixels and
592×1280 at 390×844; both have four samples. After the six environment rebuilds,
the last four readings hold at 151 geometries, 79 textures and 77 programs.
Eight reflection/natural-detail unit tests and both TypeScript checks pass.

### Close walks, turf and furniture — 2026-09-06

Close eye-level captures exposed blurry path aggregate and uninterrupted edging
strips. The shared aggregate texture now uses 1024² pixels instead of 256² at
the same two-metre world scale, with smaller bump relief. This adds roughly
5 MiB including mipmaps to the cached texture. A separate edging material uses
distance along each route for 48 cm stone courses, narrow joints and subtle
stone-to-stone variation; derivative filtering fades the joints at distance.
Route coordinates survive terrain subdivision and shoreline clipping.

The denser close turf puts 64×64 candidates in each eight-metre tile, with a
25-tile pool and a 102,400-tuft ceiling. It fades from 10 to 16 m and populates
one tile per frame, preserving the old 4096-candidate sampling budget per frame.
Wrapped direct diffuse light softens thin blades without emissive light or a
new render pass. Four paired 1280×900, DPR 2 Metal captures retained 8.3 ms
average frames in brief samples; denser visible turf added about 55–114k
triangles while the smaller pool slightly reduced draw calls. These samples
precede the furniture/junction fixes and are not cross-device guarantees.
Evidence: `.context/ground-close-before-2026-09-06/` and
`.context/ground-close-dense-2026-09-06/`.

Furniture close-ups exposed three placement defects: posts/feet were lifted
above terrain, some lamps occupied another path at a junction, and a reversed
rotation sign turned benches across the path. Benches now run along the walk,
their full seat footprint checks nearby paths/water, and lamp bases check walk
clearance. Level seats and posts rest on footings sampled from the rendered
terrain; the footings share one additional metal draw and are disposed with the
furniture. The local placement diagnostic retains 219 lamps and 26 benches.
Slats and metalwork still have simple geometry and need a separate finish pass.

The same close-up caught coplanar core paving patches at intersections. Wider
routes, then explicitly tagged surfaces, own the crossing core. Neighbouring
ribbons clip to it while retaining a small overlap at the boundary; flat route
ends cannot cut holes past their actual coverage. The corrected junction was
inspected in `.context/furniture-clear-2026-09-06/`. Flat/sloped furniture
contact, resource disposal, single crossing coverage and end-cap coverage have
regression checks. The real-data diagnostic finds no buried upward-facing walk
triangles within 400 m of the stage; one existing vertical stair riser extends
2.2 cm into terrain. Both preceding commits (`af4a324`, `b675141`) have passed
all CI jobs, including live flows.

The complete pass passes 93 park unit tests, product and graphics-fixture
TypeScript checks, and 17 production browser scenarios. These cover room/guest
dwell controls, desktop/phone project focus, all six park presets, low-shore
navigation, six environment rebuilds, reduced-motion changes and five reflection
orientation changes. The GPU suite used real Metal at DPR 2 with motion enabled.
The six views sampled 8.3–9.1 ms average frames and 9.1–11.4 ms p95; after
warmup, rebuilds held at 151 geometries, 80 textures and 90 programs. Captures
and diagnostics are in `.context/ground-furniture-gpu-results/`; clear close
bench views are in `.context/furniture-final-2026-09-06/`. All six presets and
the close furniture/path images were visually inspected. The local-AI room on
18994 still reports the same boot and no degraded providers. This pass does
not modify or newly validate model inference behavior.

### Reference-based street furniture — 2026-09-06

The benches now follow the six-foot proportions, nine slats and curved ironwork
in [Kenneth Lynch's 6737-6 drawing](https://klynchandsons.com/content/updated%20documents%202024/6737-6-CU-2024.pdf).
Beveled, green-painted slats have restrained grain and individual carriage
bolts; circular armrests, arched legs, rosettes and back braces replace the old
rectangular frame. The lamp's fluted pedestal, molded capital, framed glazing
and crowned cap follow the [NYC DOT Type B reference](https://www.nycstreetdesign.info/lighting/type-b),
including its 3.81 m height to the luminaire base. These castings remain
interpretations, and do not represent every bench/luminaire family in the park.

Shared geometry lives in `park-furniture-geometry.ts`, with paint/glazing in
`park-furniture-materials.ts`. Five instanced material batches and one fitted
footing mesh serve all 219 lamps and 26 benches. Per-model triangle counts are
252/2292/2016 for bench slats/castings/hardware and 2500/240 for lamp
castings/glazing. A cached 1024×256 painted-grain texture adds about 1.33 MiB
with mipmaps. Thin transparent glazing uses no transmission target. All
instance buffers, owned geometry and materials are released on environment
changes; the shared grain texture persists for the page lifetime.

The first close capture exposed blocky bench risers and paint that lost detail
in shade. Individual ground plates, slimmer slope supports and slightly lighter
green paint corrected those issues. Fresh front/side bench and lamp views were
inspected in `.context/furniture-finish-final-2026-09-06/` and
`.context/furniture-lamp-final-2026-09-06/`. Footprint checks now share the
geometry's dimensions. The 94 park unit tests and product typecheck pass.

All four production GPU scenarios pass with motion enabled at DPR 2 on this
Mac's M4 Max Metal renderer. The six park views sampled 8.3–9.3 ms average
frames and 9.9–11.1 ms p95. Six rebuilds settle at 152 geometries, 81 textures
and 92 programs, one geometry/texture and two programs above the prior pass.
Evidence is in `.context/furniture-finish-gpu-results/`. These brief samples
are local measurements. The live local-AI room still reports the same boot and
no degraded providers; this graphics pass does not retest inference.

### Fair-weather sky detail — 2026-09-06

`park-clouds.ts` replaces the stock sky's barely visible cloud blend with
irregular cloud bodies, cool undersides and warm edge lighting tied to the sun
direction. It modifies the existing physical sky draw before the environment
map is baked, so the visible sky, Pond mirror and environment lighting share
the pattern. A world-anchored deck, periodic density field, mip filtering and
horizon fade avoid a panorama seam and grazing-angle noise. The clouds are
static and do not introduce decorative motion or cloud shadows.

The single cached 512² R8 density texture costs about 0.33 MiB with mipmaps;
three filtered samples replace the stock procedural noise. It adds no geometry,
material batch or render target. Ground-level captures in four directions were
inspected in `.context/cloud-final-2026-09-06/`. The five close samples retain
8.3 ms average frames at DPR 2 on this Mac and report no browser errors.

Product typechecking and all four production GPU scenarios pass. The six park
views sampled 8.3–10.2 ms average frames and 9.2–13.0 ms p95 with motion enabled;
after warmup, six rebuilds hold at 153 geometries, 82 textures and 92 programs.
Pond reflections, phone layouts and environment return were checked in
`.context/cloud-final-gpu-results/`. The preceding furniture commit `6045aae`
has also passed all CI jobs, including live flows.

### Restore missing foliage opacity — 2026-09-06

Close sky inspection exposed solid triangular surfaces in the jacaranda
canopy. The packed GLB's leaf material requested blending but its base-color
image was JPEG, so alpha testing could not reveal the gaps between leaves.
The same defect affected grass, dandelion, ursinia, periwinkle and both shrub
models. The current upstream glTF metadata also links JPEG color images.

`scripts/repair-garden-alpha.py` restores each model's original 1k Poly Haven
opacity mask into the packed color image as RGBA PNG. It verifies the source
mask hash, preserves image dimensions and records source URLs/hashes in glTF
extras. The asset fetch script now runs this repair, while `--check` validates
alpha without network access. A Bun regression check rejects opaque/JPEG
base-color images on the seven cutout materials and checks buffer bounds.

The repairs add 3.53 MiB to the committed download payload without adding mesh
detail or runtime texture maps. All 69 non-image buffer views across the ten
models are byte-identical to the previous commit; meshes, nodes and accessors
are unchanged. All seven repaired alpha channels pass validation, and the
95 targeted unit tests and product typecheck pass. Fresh close captures in
`.context/foliage-alpha-final-2026-09-06/` show leaf-shaped fronds and more open
shadows in place of solid cards. The live room's served jacaranda GLB matches
the repaired source SHA-256.

All 17 park, room/guest navigation, project focus and workspace browser
scenarios pass, including the four full GPU scenarios. The longer suite
sampled 8.3–13.9 ms average frames / 9.2–16.9 ms p95; its warm rebuild counts
remain fixed at 217 geometries, 82 textures and 92 programs. Because several
views were slower than the preceding run, a paired comparison used one browser,
the same build and camera route, and served the original GLBs only to the
baseline context. Both versions sampled 8.3–9.1 ms average frames, with
identical per-view geometry/texture counts. The repaired version sampled
9.1–10.8 ms p95. This brief comparison did not reproduce the longer run's
slowdown; it is not a cross-device guarantee. Evidence:
`.context/foliage-alpha-gpu-results/` and
`.context/foliage-alpha-performance-comparison.json`.

Fresh lawn/Pond captures from the actual two-project local room were inspected
in `.context/foliage-live-2026-09-06/`, with no browser errors. Its boot ID and
healthy local-provider status remain unchanged. Both preceding commits
(`6045aae`, `d684a05`) have passed all CI jobs, including live flows.

## Broadleaf landscape pass — 2026-09-06

The landscape grove now selects elm-like, oak-like or plane-like crowns from
mapped `Ulmus`, `Quercus` and `Platanus` genera. Other/inferred trees rotate
through the three illustrative forms. Both near and distant models preserve
the selected height through their actual geometry bounds. Project trees are
unchanged. The former close jacaranda scans remain available in the meadow.

Near trees add smoother tapered trunks, five main limbs, connected secondary
forks, small twigs and finer foliage cards. Root tips enter the ground. Bark
UVs run along limbs at local metre scale instead of stretching one tile over
the whole trunk. Plane trees use a Platanus scan; elm/oak use a furrowed willow
bark approximation. The leaf atlases distinguish toothed simple, pointed-lobed
and palmate shapes. References and pinned asset URLs are in the park asset
manifest; this is a genus-level interpretation, not a botanical survey.

The 97 targeted unit tests and product typecheck pass. New geometry checks
cover near-tree triangle/index budgets, finite positions/UVs and normalized
normals. The six source bark files pass pinned-hash validation. All four full
GPU browser scenarios pass, covering six presets, low-shore traversal, motion
preferences, six rebuilds and repeated reflection resizing. In the preset
run, average frames sampled 8.3–8.4 ms with p95 of 9.2–9.4 ms at 2× resolution
on the M4 Max. Warm resource counts remain 160 geometries, 91 textures and
89 programs. This short local run does not characterize other devices.

Evidence: `.context/broadleaf-gpu-results/`,
`.context/broadleaf-final-close-2026-09-06/` (final branch joins and roots),
`.context/broadleaf-units-final.log` and `.context/broadleaf-types-final.log`.
The running local room was also captured at the lawn and Pond with its two
real projects; both renders were inspected without browser errors, and the
local-provider health and server boot ID remain unchanged. Evidence is in
`.context/broadleaf-live-2026-09-06/`.
The previous opacity-repair commit `f6ee7a3` has passed all CI jobs.

Remaining vegetation work includes less repeated individual architecture,
root transitions on steep slopes and camera-adaptive near detail beyond the
fixed sixteen-tree lawn neighbourhood. The full visual audit remains open.

## Ground contact and lawn detail — 2026-09-06

Root bases now bend to the actual rendered ground while the upper trunk and
crown retain their placement and height. The small base portions contain
112 triangles per distant tree and 656–688 per detailed tree, taken from the
existing trunk mesh. The split preserves the total triangle count. Base
positions and normals blend back to the original upper boundary, avoiding a
new joint seam. Roots with the same bark share spatial batches across crown
variants. Their geometry is owned and released by the grove.

Two unchanged 1k Leafy Grass scans replace the generated ground color detail
and unrelated aerial-rock normal map. Both use the source's two-metre scale.
The shader divides the scan by its measured linear RGB mean, keeping the
continuous park palette, and blends offset samples to reduce repetition. The
pair is 2.54 MiB on disk; RGBA8 storage with mipmaps is roughly 10.7 MiB in
total, replacing about 6.7 MiB for the previous 512-pixel color/1k normal pair.
The terrain retains its existing draw/material. Sources, CC0 license and
checksums are recorded in `public/assets/park/ASSETS.md` and
`ground/sources.json`. `scripts/fetch-park-materials.py --check` validates both
grass and bark without network access.

Each short-grass tuft now has eleven blades with varied heights and spread,
up from five, for 33 solid triangles. The 25-tile/102,400-tuft allocation cap,
distance fade, reduced-motion behavior and update sampling budget remain.
This spends more vertex work on the nearby lawn without increasing terrain
queries or per-frame instance-buffer updates.

The looking-down capture also exposed a thin slit between asphalt and its
stone margin. Making the margin flush closes it without another surface or
render pass. A slope raycast checks the joined height; crossing tests still
check that edging stops at junctions and leaves no holes.

The 100 targeted tests and product typecheck pass, including new root fits on
rotated/scaled slopes and curved terrain, unchanged upper joins and source
geometry, compact split budgets, turf-pool lifetime and the walk seam. All
eight source material files pass hash validation. Final close evidence is
`.context/ground-base-final-close-2026-09-06/`; the root/scan iterations are in
`.context/tree-base-first-2026-09-06/`, `.context/grass-scan-first-2026-09-06/`
and `.context/grass-dense-eye-2026-09-06/`.

All four production GPU browser scenarios pass, including the six park
presets, ground-level shoreline route, motion preference changes, six
environment rebuilds, portrait views and repeated reflection resizing.
The preset run sampled 8.3–8.5 ms frame intervals and 9.2–10.0 ms p95 at
DPR 2 on this M4 Max. Warm GPU counts stay at 179 geometries, 91 textures
and 91 programs across rebuilds. The fitted bases add geometry batches,
while the grass adds vertex work; this brief local run is not a measurement
of performance on other hardware. Evidence: `.context/ground-base-gpu-results/`.
The preceding broadleaf commit `c183f26` has passed all CI jobs.

Fresh lawn/Pond captures of the running two-project local room show the new
surfaces without browser errors (`.context/ground-base-live-2026-09-06/`).
Its health and server boot ID remain unchanged. The first lawn sample was
slow (28.6 ms average), prompting an 18-second startup trace rather than
assuming steady performance. In the trace, the initial sample includes
loading/construction stalls (100.4 ms average, 544.9 ms p95), then every
two-second sample from +2 s through +18 s stays at 8.3 ms average and
9.0–9.3 ms p95 at DPR 2. These data separate startup from the settled view;
they do not prove that startup cost is unchanged versus the previous commit.
Trace: `.context/ground-base-live-timing.json`. Startup latency remains open.

## Startup construction and shader warmup — 2026-09-06

A production build with source maps and a Chromium CPU profile attributed a
roughly one-second startup task largely to path construction and procedural
paving textures. The paths now use the same geometry generator in synchronous
checks and an asynchronous browser runner. An eight-millisecond work budget
between station checkpoints gives rendering/input an opportunity to run; it
does not guarantee every construction task or frame completes in eight
milliseconds. The five paving textures are baked from their original seeded
painters, retaining dimensions, color, sampling and bump scales. Geometry
parity checks cover sloped junctions, water clipping, stairs and material groups.

Flora caching is now per model. The park requests its nine used scans; the
11 MB jacaranda loads only when entering the meadow. Successful model loads
remain shared across environments, while failed loads can retry. The full
GPU scenario checks both the deferred request and absence of duplicate model
downloads on mode switches. On renderers exposing parallel shader compilation,
the world warms against the room's current lighting/fog before attachment;
an environment-disposal guard prevents late attachment after navigation away.

Two fresh browser runs of the unchanged baseline and final build used the same
local two-project room, 1280×900 viewport, DPR 2, reduced motion and M4 Max
Metal renderer. Profiling was disabled for these timing comparisons:

| Measurement | Baseline | Updated |
| --- | --- | --- |
| Longest observed main-thread task | 992–995 ms | 360–368 ms |
| Longest animation-frame interval | 991 ms | 542–551 ms |
| Sum of long-task time beyond 50 ms | 2,006–2,059 ms | 1,040–1,066 ms |
| World-ready marker after navigation | 3.32–3.38 s | 3.16–3.21 s |
| Encoded resource payload observed | 54.64 MB | 46.67 MB |

The observation continued eight seconds after world-ready. That marker means
the terrain/world is attached, not that every asynchronous skyline model or
texture is loaded; these numbers are not Core Web Vitals or a cross-device
guarantee. Settled samples retained 8.3 ms average frame intervals and the
same 179 geometries / 79 textures / 86 programs in this two-project view.
Lawn renders before/after were inspected. Remaining 0.5-second frame gaps
mean startup is improved, not finished. Evidence: `.context/park-startup-baseline-{1,2}/`,
`.context/park-startup-warmed-{1,2}/`, and the CPU profiles under
`.context/park-startup-before/` and `.context/park-startup-after-profile/`.

All 101 targeted park/asset tests and product typechecking pass. The five baked
textures pass offline manifest validation. All four production GPU scenarios
pass with motion enabled at DPR 2: six presets, meadow/park switching with
lazy flora requests, the low shoreline route, six rebuild cycles, portrait
controls and repeated reflection resizing. Warm rebuild counts remain fixed
at 179 geometries / 91 textures / 92 programs; the six presets sample 8.2–8.4 ms
average frame intervals and 10.0–10.4 ms p95 on this Mac. Evidence:
`.context/startup-gpu-results/`. Preceding commit `194b297` passed all CI jobs.

## Individual tree forms and shoreline patches — 2026-09-06

The broadleaf grove now has three seeded variants for each of its three genera.
They vary leader lean, fork height, scaffold attachment heights/angles, crown
shoulders and four/five-root flares. Position-seeded selection, proportions,
tint and fallback genus keep an individual stable across batching or source
reordering. Mapped genera and heights still take precedence. Models are built
only when used, then shared by spatial instancing; bark/leaf maps remain shared.
Near leaf sprays follow connected terminal twigs instead of occupying an
independent ellipsoid. Leaf randomness no longer changes the next lobe's branch
layout when switching geometric detail.

All nine variants retain the previous per-tree budgets: fewer than 1,500
triangles at coarse detail and 18,000 near the lawn. Terrain-fitted base tests
now cover every variant. The scene still has 640 landscape trees, and detailed
geometry remains limited to the sixteen nearest the lawn. This adds template
geometry and draw batches, not a unique high-resolution mesh for every tree.

Understorey now forms multi-clump patches, with smaller companions around
larger shrubs and a 1,400-plant cap. Lower wooded banks can carry shrubs while
managed lawn, open water, mapped paths, buildings, the project clearing and
steep grades retain their exclusions. Each companion passes the same placement
checks. Emergent shore vegetation uses finer sampling with broad/fine noise
to soften patch boundaries. The current Pond places 686 sedge/cattail clumps;
abrupt banks are excluded, and nearby tall clumps cast shadows. The
[Conservancy's Pond guide](https://assets.centralparknyc.org/pdfs/discovery-programs/The_Pond_Exploration_Guide.pdf)
identifies cattails in this habitat; positions and patch densities remain
illustrative, not a planting survey.

Close tree renders before/after were inspected in
`.context/vegetation-close-before-2026-09-06/`,
`.context/vegetation-tree-first-2026-09-06/` and
`.context/vegetation-twig-2026-09-06/`. The Pond and overlook planting review is
in `.context/vegetation-review-first/`. All 103 targeted park/asset tests and
product typechecking pass. Individual tree accuracy, the fixed detailed-tree
neighbourhood and abrupt shore terrain still warrant further work.

The first full GPU run exposed higher draw-call cost in the wide views.
Increasing tree batch cells from 130 to 180 metres reduced Wollman from about
1,030 to 924 draws and Arsenal from 1,042 to 877 in the corresponding samples.
The broader cells can submit slightly more triangles at view edges, but share
more instances and retain spatial eye/reflection culling. The updated six
presets sampled 8.3–8.9 ms average frame intervals / 9.2–10.8 ms p95 at DPR 2
with decorative motion enabled on this M4 Max. These are local samples, not
cross-device guarantees. The original startup optimization commit `a0880c2`
has passed all CI jobs.

All four hardware scenarios pass after batching changes: six preset views,
environment returns and deferred meadow models, the low shoreline walk, six
rebuilds, portrait views, reduced-motion toggles and reflection resizing.
Warm resources stay fixed at 195 geometries / 91 textures / 94 programs,
compared with 179 / 91 / 92 before this vegetation pass. The additional shared
shapes and reed shadows have a bounded cost; no new texture assets were added.
Final evidence: `.context/vegetation-final-gpu-results/`.

A subsequent startup trace showed vegetation construction immediately adjacent
to the world's first heavy render. An existing paint-yield boundary now separates
those steps, with the disposal guard checked again before flora attachment.
Two fresh isolated production runs of this denser scene reduced the longest
main-thread task from 379–395 ms to 264–284 ms and the largest animation-frame
interval from 617–670 ms to 488–492 ms. World-ready time changed from
3.26–3.33 s to 3.02–3.09 s. The remaining longest gap occurs earlier in startup;
world-ready does not mean every model/texture has finished loading. Evidence:
`.context/vegetation-final-startup-{1,2}/` and
`.context/vegetation-yield-startup-{1,2}/`. Continue investigating that initial
gap and longer navigation runs rather than inferring smooth startup from
settled frame samples.

All four GPU scenarios pass again with the paint-yield change. The six presets
sample 8.3–8.4 ms average / 8.4–9.1 ms p95; warm rebuild counts remain fixed
at 195 geometries / 90 textures / 94 programs in this run. Evidence:
`.context/vegetation-yield-gpu-results/`. The real two-project room was also
captured at the lawn and Pond in `.context/vegetation-live-2026-09-06/`.

## Park butterfly scale and markings — 2026-09-06

The lawn review exposed enlarged decorative butterflies: their geometry spans
roughly 60–90 cm in the park's metre-based scene. Park instances now span about
8–10 cm, with two orange palettes, a tapered forewing, a rounded hindwing,
strong dark veins and pale marginal spots. The decorative eyespot is omitted.
The [Conservancy documents monarchs in the Park](https://www.centralparknyc.org/articles/the-great-monarch-butterfly-migration),
and [Smithsonian describes their 3–4-inch wingspan](https://www.si.edu/spotlight/buginfo/monarch).
This is a procedural monarch-inspired drawing, not a specimen scan. The
meadow retains its existing decorative palette and size.

Park wings use an opaque alpha cutout with alpha-to-coverage and much less
emissive light. That avoids the prior transparent front/back passes and
reduces the park's wing palette from five shared textures to two. Airborne
motes are also reduced to small specks at park scale. The eight insects,
flap/glide/flower-landing behavior and reduced-motion handling remain in place.
The wing drawings and a full lawn render were inspected in
`.context/butterfly-review-2026-09-06/`; typechecking passes.

The close pattern comparison also exposed linear color channels being written
directly into an sRGB canvas. The park pattern now encodes its orange correctly
before upload; the corrected wing drawing and lawn were rendered and inspected.
The first production run passed all six presets, the shoreline route and six
rebuilds (stable warm counts: 194 geometries / 88 textures / 92 programs).
Its final orientation test was interrupted by clamshell sleep: the macOS power
log records sleep at 15:55:05 and wake at 15:59:52 on September 6. Evidence:
`.context/butterfly-gpu-results/`. The earlier vegetation commit `ba1386b`
passed all CI jobs.

The interrupted orientation check and full six-view/material/environment
scenario both pass on the corrected-color build after wake. Final evidence:
`.context/butterfly-final-gpu-results/`. These complete the four-scenario
coverage alongside the preceding shoreline/rebuild checks; the final change
only alters canvas color encoding. Product typechecking passes again.

The final six-view samples are 8.3–8.7 ms average / 9.1–10.7 ms p95 on the
M4 Max at DPR 2. The real two-project room also loads without browser errors
at the lawn and Pond; final captures are in
`.context/butterfly-live-2026-09-06/`. Neither brief sampling nor these
graphics checks establishes exhaustive interaction coverage or performance
on other hardware.

## Independent viewing tilt — 2026-09-06

Arrow up/down now tilt the camera in place; Q/E lower/raise its eye separately.
Both the room and guest navigation pads expose those actions with the existing
hold, touch and dwell behavior. Shift+Q opens the QR overlay, leaving Q free
for navigation. The dwell checkbox no longer blocks navigation shortcuts while
it holds focus; text fields retain their keyboard input. Manual tilt is bounded
to 85 degrees above/below horizontal and eased with the camera. Fit, presets
and project focus restore their intended framing. Existing mouse/pinch orbit
continues around its target, augmented by the manual tilt.

The flat projector pair now carries pitch through pose publication, relay,
adoption and replay; older frames default to a level view. Corner projectors
retain their fixed eye and disabled navigation. A two-window reload check
exposed an existing initial-fit race: the refreshed window adopted its partner,
then loaded the standing projects and broadcast a canonical view over that
pose. Initial snapshot framing now yields to an adopted flat pose. Explicit
Fit and later imports still recenter the pair. The pure camera check compares
zero-tilt orientations with the original Three.js look-at direction over
several orbit positions and verifies the vertical limits/reversal behavior.

All 253 targeted unit checks and typechecking pass. Fourteen park, focus and
spatial-navigation browser scenarios pass, including guest touch/dwell release,
independent tilt/height, QR, fixed corners and refreshed flat partners. All five
hardware scenarios pass at DPR 2 with motion enabled. The six preset samples
are 8.3 ms average / 9.3–9.8 ms p95 on this M4 Max; six rebuilds hold at
195 geometries / 88 textures / 92 programs after warmup. Evidence:
`.context/camera-tilt-browser-final-results/` and
`.context/camera-tilt-gpu-results/`.

The first upward inspection shot reached the 85-degree limit and showed sky;
it verified the control but was not a useful canopy composition. A second
hardware run settles pitch as well as eye position and trims the upward shot
to roughly 20 degrees. That scenario passes again; ground and skyline views
were inspected in `.context/camera-tilt-ground-final-results/`. Both angles
retain exactly the same eye, with 1.4 m terrain clearance. Close vegetation,
label overlap and camera-adaptive tree detail remain in the visual audit.

The real local-AI room was restarted with its existing model overrides and
mute enabled. Its two projects, branch jobs, planting positions and source
metadata match the pre-restart snapshot; all providers remain real/local.
Live host and guest navigation then passed, including changing pitch from
-0.139 to +0.349 and back from the phone with unchanged x/y/z. Desktop,
portrait and guest controls were inspected without browser errors. Evidence:
`.context/camera-tilt-live-2026-09-06/` and
`.context/camera-tilt-restart/`. The app remains running at port 18994.
