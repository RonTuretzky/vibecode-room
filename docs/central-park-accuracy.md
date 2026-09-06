# Central Park geographic accuracy

The first accuracy pass concentrates on the Pond and the south end. The room
keeps a virtual project lawn near Gapstow; it is still an interactive workspace,
not a surveyed reconstruction or a live depiction of park operations.

## Reference data

`src/park3d/data/south-park-sites.json` stores eleven OpenStreetMap ways,
including their IDs, revisions, coordinate order and snapshot timestamp.
Refresh it with `python3 scripts/fetch-park-sites.py`. The small dataset is
bundled with the app: visiting the park requires no map API or network request.
The script validates every expected way before replacing the previous file.

Locations were checked against the Conservancy's
[general map](https://assets.centralparknyc.org/media/documents/CPCWeb_Downloadablemaps_202407_General.pdf),
[Pond guide](https://assets.centralparknyc.org/pdfs/discovery-programs/The_Pond_Exploration_Guide.pdf),
and descriptions of [Gapstow](https://www.centralparknyc.org/locations/gapstow-bridge),
[Hallett](https://www.centralparknyc.org/locations/hallett-nature-sanctuary),
[the Dairy](https://www.centralparknyc.org/locations/dairy-visitor-center),
[Chess & Checkers House](https://www.centralparknyc.org/locations/chess-checkers-house),
and [Wollman Rink](https://www.centralparknyc.org/locations/wollman-rink).
Reference photographs guide the procedural models; they are not copied into
application assets.

## Corrections

The previous hand-entered sites were displaced from the mapped footprints by
substantial distances. Rounded horizontal corrections, using the footprint's
bounding-box centre, are:

| Feature | Previous displacement |
| --- | ---: |
| Carousel | 346 m |
| Chess & Checkers House | 297 m |
| Dairy | 272 m |
| Inscope Arch | 173 m |
| Cop Cot | 100 m |
| Sherman Monument | 91 m |

Pulitzer Fountain also uses its mapped site. Umpire Rock and Rat Rock were
previously represented as different outcrops; the duplicate is removed.

Gapstow's length, width and horizontal alignment now derive from its mapped
outline. Its earlier 13.5 m body plus two 8.5 m ramps occupied 30.5 m. The
replacement stays within the approximately 23 m mapped footprint. The arch and
vertical profile remain interpretations of reference photographs. Its base
uses the same level water surface as the Pond, with narrow earthen approaches
that connect the rendered paths without filling the arch. The underlying 8 m
DEM is too coarse to represent the abutments unaided.

Wollman's previously missing footprint now has a level recreation surface,
subtle perimeter railing and paving. Access gaps in the railing follow mapped
walk approaches. A new camera view looks toward it. The
outline is mapped; apron width, railing detail and vertical grading are
interpretive. The surface is a neutral warm-season slab, not an assertion about
today's ice, pickleball layout, event equipment or opening status.

Hallett's mapped woodland boundary corrects gaps in the photo classifier,
which mistook sunlit woodland for lawn. Ground cover and tree candidates now
respect that boundary. Existing water masks still exclude trees from the Pond;
path and building exclusion masks keep vegetation clear of circulation and
structures. Illustrative streetlights are excluded from Hallett's rustic trails,
and crowded lamp placements near junctions are thinned.

The room no longer clears a 325 m circle of city footprints around the project
lawn. Fifth Avenue's nearby street wall is retained. Detailed skyline models
still suppress their corresponding extrusions to prevent overlapping buildings.

## Pond and vegetation detail

The next graphics pass replaces straight spoke-like branches with curved
forks and tapered roots, plus fuller vase-shaped, tiered and irregular crowns.
The Conservancy's [American elm](https://www.centralparknyc.org/plants/american-elm)
and [pin oak](https://www.centralparknyc.org/plants/pin-oak) references guide
the silhouettes. These are procedural visual forms, not species assignments
to particular tree locations.

The [Pond exploration guide](https://assets.centralparknyc.org/pdfs/discovery-programs/The_Pond_Exploration_Guide.pdf)
identifies cattails among its aquatic plants. New cattail and sedge-like
patches follow the rendered shoreline, avoiding mapped walks, structures
and bridge approaches. Patch positions and densities are interpretive.
Two-metre terrain sampling and an adjusted bank profile reduce the exposed
trench along the clipped water edge. Gentler ripples and an olive-to-green
shore gradient give the water a sheltered-pond appearance; that gradient
does not claim surveyed bathymetry.

## Remaining fidelity limits

- Trees are approximate broadleaf forms and a small photoscan library, not a
  surveyed inventory of native species, trunk positions and crown sizes.
- The 8 m bare-earth DEM, two-metre water mask and simplified paths cannot
  reproduce every rock ledge, shore wall, step, drain or underpass.
- The Zoo, Arsenal, rink support buildings and several other park structures
  still need individually placed models; generic interior extrusions remain
  suppressed. Facade and rooftop detail on the surrounding city is approximate.
- The stage flattening and project trees are deliberate workspace additions.
- Northern landmarks retain the previous approximate models and placement.

## City edge and perimeter restoration

The room now uses [the mapped park outline](https://www.openstreetmap.org/way/427818536)
for land membership, while keeping the original coordinate frame for the
baked DEM and camera positions. The former rectangle cut off parkland on the
east and south edges. Correcting the surface alone exposed gaps in the old
rectangle-clipped paths and photo-derived vegetation, so the same pass also
refreshes the south-end walking network and restores mapped perimeter trees.

`scripts/fetch-park-streets.py` writes the attributed local
`public/assets/park/streets.json` and `src/park3d/data/park-outline.json`.
The 2026-09-06 extract contains 1,547 streets/walls, 518 walks and 167 perimeter
tree locations. Street and path ways retain IDs and revision metadata; tree
nodes retain IDs, positions and available height/genus tags. All share the
extract timestamp. No map service is contacted while using the room.

Surrounding streets follow mapped centerlines. Tagged widths take precedence;
missing dimensions use lane-based defaults. Sidewalk widths, pavement colors,
curb profiles, lane dividers and untagged wall heights remain illustrative.
Walls keep tagged heights and stop at mapped walking routes. Road surfaces
share the terrain mesh, preventing lighter ground from clipping through them.
The [Conservancy's perimeter description](https://www.centralparknyc.org/restoration/park-perimeter)
and [NYC sidewalk material guidance](https://www.nycstreetdesign.info/material/sidewalks)
provide visual references; the exact hexagonal/granite paving pattern still
needs a separate material pass.

Mapped perimeter trees are placed before photo-derived candidates, avoiding
duplicate trunks and retaining the existing 640-tree budget. In the live
two-project room, 146 mapped trees passed the range, water, path and spacing
filters. Their silhouettes remain procedural; untagged heights are estimates.

The refreshed path network retains the northern walks and park drives. Walks
now grade the terrain across their width, with feathered shoulders. Steep
banks no longer cause valid footways to disappear; their triangles subdivide
where needed to follow the rendered terrain, and clip at the actual water
contour. Tagged stairs are modeled as treads and risers. Surface tags survive
clipping and choose asphalt, pavers, gravel/earth, mulch or wooden boards.
Natural paths have no artificial stone margin. Grade, step dimensions, paver
pattern and surface colors remain interpretations of the DEM and tags, not
surveyed construction details. Full-renderer captures of the southern scene were inspected; detailed low-angle
comparison against surveyed construction remains outside this model.

The next useful pass is a measured south-end building/terrain survey, followed
by better species-specific models and schist outcrops. More decoration alone
would not resolve those discrepancies.

## Verification

Geometry tests check geographic relationships, the bridge's agreement with the
baked footway, clear arch raycasts, water/land placement, approach continuity,
upward-facing rink triangles, grading, woodland boundaries and planting masks.
Browser checks cover the four camera presets, Fit, environment switches, narrow
screens, locked projectors, and the shared room/guest spatial controls. Heavy
park assets require a separate real-GPU inspection because browser automation
uses the software-renderer fallback.

Verified locally on 2026-09-06 after the city/perimeter pass: 309 relevant unit tests passed, TypeScript and
production build passed, and all nine park/navigation browser tests passed.
Live GPU inspection covered the Pond, connected Gapstow approaches, the
Wollman surface and access openings, the project lawn, the park overlook,
and Orbit/Meadow return trips. No browser rendering warnings or errors were
reported. The room retained its two projects and local AI profile. This is targeted
regression coverage, not a rerun of every AI workflow.

The subsequent walk pass passed 319 relevant unit tests, TypeScript and build
checks, nine navigation tests, and an opt-in full-graphics browser test. The
hardware test visits every park preset, captures normal/Zen portrait views,
and returns from Orbit and Meadow without rendering errors. Inspecting its
screenshots led to two further fixes: connected junction margins and grading
shore walks from the carved bank surface. This is an isolated demo-room test;
the locked desktop prevented directly revisiting the user's active browser tab.

Nearby generic city roofs now include inset parapets, coping, recessed roof
surfaces and restrained low housings. These are illustrative, bounded by the
source footprint and roof height; no equipment placement is claimed to be
surveyed. Source footprints with extra collinear vertices keep simple tower
setbacks, while concave lots stay unshrunk. Existing detailed skyline models
remain, and building bodies now cast alongside roof details to avoid hollow
shadow outlines. The rooftop pass passed 323 relevant unit tests, TypeScript,
production build and full-graphics checks at double pixel density.

Grove foliage now moves gently, with the same deformation in visible and
shadow passes. Reduced motion disables the breeze. This is an illustrative
animation, not live weather. The pass adds no per-frame geometry or instance
matrix rebuilds; it passed 324 relevant unit tests, type/build checks and the
full graphics regression with motion enabled on Metal at double pixel density.
