# Central Park rendering

The browser renderer uses locally stored park data and models, with generated
material textures. It needs no cloud rendering or external asset service.

## Visual systems

- `park-atmosphere.ts`: physical sky, ACES exposure, environment lighting,
  and one sun shadow map. Shadow coverage follows the camera. Elevated
  project overviews ease the haze and widen shadow coverage. Renderer
  settings are restored when leaving the park.
- `park-materials.ts`: deterministic, page-cached turf, broadleaf sprays,
  weathered stone, and path textures. Leaf materials soften direct diffuse
  lighting using the existing shadowed light; no extra transmission pass.
- `park-grove-geometry.ts` / `park-grove.ts`: three distinct crown/trunk
  forms, each below 1,000 triangles, with spatial instancing and rounded
  crown normals. The nearest 16 trees within 120 m retain photoscans.
- `park-ground.ts` / `park-terrain-grid.ts`: continuous, linear grass/soil
  albedo and a graded terrain grid. Three-metre sampling around the lawn
  and Pond gradually becomes 18 m near the distant city. Paths and project
  placement interpolate those exact rendered triangles.
- `park-reflection.ts`: planar reflections update at full rate during
  camera movement, and at up to 30 Hz at rest. Ripple animation continues
  each frame. Projection changes invalidate the cached reflection.
- `park-cameras.ts`: lawn, Pond, and overlook views, plus a content fit that
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
and clipped shoreline. Water geometry is independent of terrain detail.

Gapstow has an open arch, approach ramps, metre-scale masonry UVs,
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

- Full unit suite: 2,622 passed, 20 credential-dependent tests skipped.
- Park suite: 28 passed. Coverage includes terrain/ray agreement on the
  nonuniform grid, crown geometry budgets, building/bridge winding and
  openings, shoreline clipping, reflection invalidation, and fitting
  2/32/64 projects at multiple camera angles and viewport proportions.
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
