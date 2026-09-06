# Central Park visual improvement audit

Active objective: improve the scene across detail, graphical quality and all
other visible aspects until the full result has been inspected and no required
work remains. This audit records open work; a green regression suite does not
prove that the visual objective has been achieved.

## Evidence from the current pass — 2026-09-06

- The corrected outline restores parkland formerly replaced by city paving.
- The city now has mapped streets, pavement, curbs and perimeter walls. Broad
  road surfaces share the terrain, resolving visible white clipping patches.
- A refreshed walking network and 146 accepted mapped perimeter trees restore
  detail along the newly recovered park edge in the live two-project room.
- Distinct roughness and relief maps improve window/masonry separation;
  lighter haze makes nearby buildings easier to distinguish.
- The Pond, crowns and bank improvements from the preceding pass remain.
- Walks now grade their terrain corridors and clip at the shoreline instead
  of being dropped on steep banks. Source stair tags produce treads/risers;
  surface tags distinguish paved and natural routes. These changes pass
  geometry/source-data checks and full-renderer screenshot inspection.
- Adaptive path triangles and shared vertices reduce the initial dense pass
  from 518k triangles/1.55M vertices to 198k/201k. A real-data centroid check
  finds no buried walk/stair triangles in the 400 m southern neighbourhood.

## Observed work still to resolve

1. **Walk continuity and terrain grading.** Full-renderer captures now show
   connected shore walks and clean junctions. The first captures caught edging
   through intersections and abrupt DEM-based banks; both were corrected and
   rechecked. Continue low-angle inspection of stair transitions and modeled
   grades as camera exploration improves. Contour-based bank grades now remove
   grid-direction bias and fade into the surrounding DEM; the new render was
   inspected. The camera now keeps terrain/deck/water-relative eye clearance;
   a hardware route reached the low shore and climbed back over the hillside
   without dropping below it. Close captures exposed sparse turf detail, now
   supplemented by short, solid blades and finer ground texture scale.
   The user's existing tab still needs
   a direct visit once the Mac is unlocked.
2. **Architecture.** Nearby buildings now have recessed roofs, parapets,
   coping, roof grain and low rooftop housings within source height/footprint
   bounds. Extra collinear survey vertices no longer disable tower setbacks.
   Full-renderer review caught and resolved hollow parapet shadows; complete
   building bodies and landmark models now cast consistent shadows. The Arsenal
   now has its mapped footprint and height, eight octagonal towers, brick and
   granite materials, framed windows, crenellations and raised entrance. Its
   first GPU capture exposed a missing entrance/walk connection, now joined by
   a short inferred apron. Wollman now has its mapped curved clubhouse, roof
   terrace, slatted canopy, patio and service building. Full-renderer inspection
   caught a grassy patio gap and roof-edge approach issue; both were corrected.
   The Zoo now has its mapped exterior pavilions, open galleries, tropical-house
   glazing, central pool and an illustrative clock with three open arches.
   The first render exposed a crowded camera composition, dark small water
   bodies and courtyard grading; all were refined and checked in a fresh
   hardware capture. Fifth Avenue hotel
   crowns, Zoo enclosures/interiors, sculptural details and the rink's seasonal
   fit-out remain incomplete. Architectural details remain interpretive.
3. **Ground materials and transitions.** Perimeter hexagonal/granite paving,
   path margins, schist outcrops, contact shading and woodland floor detail
   need continued close-view inspection. The first slope/woodland layer adds mineral grain
   and small leaf fragments in the existing terrain draw, verified in a hardware
   render. Close walk captures now show finer aggregate, metre-scaled stone
   courses and denser near-eye turf. New junction views exposed coplanar paving
   patches and furniture in crossings: one route now owns each crossing's core,
   furniture checks nearby walk footprints, and the bench rotation sign is
   corrected. Terrain-fitted footings replace the old 5/12 cm bench/lamp lifts.
   A subsequent reference-based pass adds green beveled slats, curved bench
   castings, small fasteners and Type B-style framed lanterns. Close inspection
   corrected blocky slope supports and overly dark paint. Continue checking
   texture repetition and stair transitions.
4. **Vegetation and atmosphere.** Grove foliage now has gentle, phased crown
   motion with matching shadow deformation and a live reduced-motion stop. The
   hardware test compiled both shaders and recorded all presets with motion
   enabled. A new low shrub layer supplies clustered undergrowth on wooded
   ground, with tapered branches, human-scale leaf sprays, a 900-plant cap and
   camera-distance culling. It avoids paths, water, steep grades and the stage;
   full-renderer Pond and overview captures were inspected. Crown density,
   woodland floor materials, grass scale and water shading still warrant further
   work. A fair-weather cloud layer now adds shaded bodies and sunlit edges to
   the existing sky, environment lighting and Pond reflection. Four ground-level
   directions were inspected, and all four GPU scenarios pass. These close
   views also exposed triangular surfaces in the near photoscan canopy. The
   asset audit found JPEG base-color textures on seven alpha foliage materials.
   Original Poly Haven opacity masks now restore their cutouts, and fresh
   close renders show leaf-shaped fronds and more open shadows. The repair
   preserves every mesh/UV buffer and adds an asset regression check. Continue
   judging crown density with the corrected textures. Near photoscan trees
   still reuse a jacaranda model; matching them to mapped park genera remains.
   The close turf now has four times
   the cell density in a smaller 25-tile neighbourhood, fading by 16 m; wrapped
   diffuse light gives thin blades a softer response without another pass.
   Small-basin ripples now use an
   irregular seamless spectrum with softer highlights and reduced-motion
   support; the change was checked in the Zoo render. A fresh Pond capture
   exposed blocky reflected silhouettes at DPR 2. Its mirror now uses bounded,
   screen-shaped resolution and antialiasing; the sharper façades and tree
   edges were inspected in a new hardware capture. Species forms remain approximate.
5. **Composition and UI.** Inspect camera routes and readable project content
   in normal and Zen modes, portrait and landscape. Preserve shared spatial
   controls and planting/branch interaction. The fresh 32/64-project fixture
   exposed an automatic single-row layout that forced Fit too far away. Compact
   terrain-aware slots now reduce its radius from 435/872 m to 169/256 m;
   chosen planting positions retain their override. Distant branch-tip cards
   now fade with their projected size, leaving the crowns visible. Explicit
   Show in garden fits the grown tree at its actual terrain elevation, clears
   the foreground tray/feed, and can be repeated after navigating away. The
   first phone capture exposed oversized chips across the crown; compact
   identity/action placement now leaves the tree visible between them. Desktop
   and phone captures were inspected. Six real branch raycasts, mouse picks
   and the dwell activation path still open the expected branch. Larger adopted
   branch menus and the remaining ground-level compositions need further review.
   Lamp inspection also exposed a camera limitation: manual orbit changes eye
   height while retaining the preset's look-at height. Independent upward/downward
   viewing at ground level needs attention; currently changing presets affects it.
6. **Cost and lifecycle.** Re-measure a large project forest, transitions and
   repeated rebuilds. Audit cached world/atlas lifetimes, reflection/shadow
   cadence, resolution adaptation and long-frame behavior. Six environment
   rebuild cycles now show stable GPU resource counts after warmup, including
   recreating the close turf. The 64-mature-tree fixture has six branch tips per
   tree. Fading unreadable distant chrome reduces its overview from roughly
   2,900 draw calls / 18–19 ms average frames to 1,004–1,014 draws / 8.7–8.8 ms
   at 2× resolution on this M4 Max; p95 is 11.9–12.5 ms in the fresh six-sample
   check. Close detail returns and branch picking remains available. Continue
   auditing long-frame behavior. The sharper Pond reflection retains the same
   30 Hz idle/full-rate navigation schedule, with bounded buffer resolution and
   delayed resizing. Full hardware rebuild checks still pass. Brief local frame
   samples are not a cross-device performance guarantee. The denser turf and
   fitted furniture pass also passed six rebuilds with motion enabled: after
   warmup, counts stayed at 151 geometries, 80 textures and 90 programs. All 17
   current park/navigation/focus browser scenarios passed. The newer furniture
   pass passes all four GPU scenarios, with stable warm counts of 152 geometries,
   81 textures and 92 programs. Its six views sampled 8.3–9.3 ms average frames.
   After cloud/opacity repair, all 17 browser scenarios pass again and warm
   rebuild counts stay fixed at 217 geometries, 82 textures and 92 programs.
   A paired original/repaired-foliage comparison measured 8.3–9.1 ms average
   frames for both, with matching geometry/texture counts per view. The longer
   suite had slower samples, so retain long-frame behavior in this audit.

## Completion remains unproven

Continue actual rendering work and visual inspection. Verification must cover
the completed scene and its user interactions, including local-AI project
flows where changes affect them. Do not treat this inventory, partial source
coverage or unit/browser checks as proof that the full objective is complete.
