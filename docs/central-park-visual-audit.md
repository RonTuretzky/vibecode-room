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

## Observed work still to resolve

1. **Walk continuity and terrain grading.** Steep bank checks currently reject
   portions of valid mapped footways, leaving isolated ribbons near the Pond.
   Grade walk corridors against the terrain and handle actual stairs/bridges
   explicitly; hiding fragments alone would leave the underlying problem.
2. **Architecture.** Many city blocks still have generic silhouettes. Add
   appropriate cornices, parapets, roof detail and better mapped landmark
   coverage while retaining source footprints/heights and existing models.
   The Zoo, Arsenal and rink support structures remain incomplete.
3. **Ground materials and transitions.** Perimeter hexagonal/granite paving,
   path margins, schist outcrops, contact shading and woodland floor detail
   need close-view inspection. Avoid texture repetition and floating props.
4. **Vegetation and atmosphere.** Check tree species forms, foliage motion,
   crown density, grass scale, sky detail and water shading at both ground
   level and in wide views. The current tree library remains approximate.
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
