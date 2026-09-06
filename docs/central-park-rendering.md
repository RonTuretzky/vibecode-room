# Central Park rendering

The browser renderer uses the existing locally stored park data and models.
No cloud rendering, new asset service, or engine installation is required.

## Visual systems

- `park-atmosphere.ts`: physical sky, ACES exposure, environment lighting,
  and one sun shadow map. Shadow coverage follows the camera and widens for
  the overlook. Renderer settings are restored when leaving the park.
- `park-materials.ts`: deterministic, locally generated turf, foliage,
  stone, and path textures, cached for the page.
- `park-grove.ts`: inexpensive broadleaf trees in spatial batches. Nearby
  trees retain the existing photoscans; distant trees use compound foliage
  cards with rounded crown lighting.
- `park-furniture.ts`: instanced slatted benches and acorn lamps, with
  explicit geometry/material cleanup on environment changes.
- `park-cameras.ts`: project lawn, Pond, and overlook camera positions.
  Fixed projector rigs cannot use these navigation controls.

The room limits terrain and building geometry to a 1,250 m neighbourhood of
the project lawn. Terrain is sampled every 3 m. Each connected water body
gets one level, a carved bed, graded banks, and a clipped shoreline contour.
Paths sample the actual terrain triangles, rather than a second height
surface that could leave them floating. The separate aerial page retains
its full extent and optional canopy displacement.

Gapstow includes an open stone arch, individual arch stones, parapets, ivy,
and approach ramps. Building materials distinguish masonry from glass.
Project trees retain their branch and selection semantics with denser,
smaller foliage and cast shadows in the park.

## Verification

- `bun run typecheck` and `bun run build`.
- Full unit suite: 2,614 passed, 20 credential-dependent tests skipped.
- Final park geometry suite: 21 passed, including the subsequently added
  shoreline contour test, translated water bounds, sloped paths, and the
  bridge opening.
- Browser suite: 64 passed. New checks cover the camera cycle, narrow
  viewport, environment switches, Zen, and locked projector cameras.
- Real GPU inspection covered the lawn, Pond, overlook, and return trips
  through Orbit and Meadow. Software-rendered browser tests deliberately
  skip the heavy park assets, so they are not a visual quality gate.

The scene element exposes `data-triangles`, `data-draw-calls`,
`data-pixel-ratio`, and a recent average `data-frame-ms` for inspection.
Measurements depend on the camera, viewport, project count, and other GPU
work; they are not a fixed performance guarantee.
