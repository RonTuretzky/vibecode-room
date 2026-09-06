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
   grades as camera exploration improves. The user's existing tab still needs
   a direct visit once the Mac is unlocked.
2. **Architecture.** Nearby buildings now have recessed roofs, parapets,
   coping, roof grain and low rooftop housings within source height/footprint
   bounds. Extra collinear survey vertices no longer disable tower setbacks.
   Full-renderer review caught and resolved hollow parapet shadows; complete
   building bodies and landmark models now cast consistent shadows. The Zoo,
   Arsenal, rink support structures and distinctive Fifth Avenue hotel crowns
   remain incomplete. General architectural details are still illustrative.
3. **Ground materials and transitions.** Perimeter hexagonal/granite paving,
   path margins, schist outcrops, contact shading and woodland floor detail
   need close-view inspection. Avoid texture repetition and floating props.
4. **Vegetation and atmosphere.** Grove foliage now has gentle, phased crown
   motion with matching shadow deformation and a live reduced-motion stop. The
   hardware test compiled both shaders and recorded all presets with motion
   enabled. Crown density, woodland understorey, grass scale, sky detail and
   water shading still warrant further work. Species forms remain approximate.
5. **Composition and UI.** Inspect camera routes and readable project content
   in normal and Zen modes, portrait and landscape. Preserve shared spatial
   controls and planting/branch interaction.
6. **Cost and lifecycle.** Re-measure a large project forest, transitions and
   repeated rebuilds. Audit cached world/atlas lifetimes, reflection/shadow
   cadence, resolution adaptation and long-frame behavior. Brief local frame
   samples are not a cross-device performance guarantee.

## Completion remains unproven

Continue actual rendering work and visual inspection. Verification must cover
the completed scene and its user interactions, including local-AI project
flows where changes affect them. Do not treat this inventory, partial source
coverage or unit/browser checks as proof that the full objective is complete.
