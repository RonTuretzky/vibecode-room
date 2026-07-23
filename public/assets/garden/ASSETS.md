# Garden scene assets

Everything in this directory comes from [Poly Haven](https://polyhaven.com)
and is licensed **CC0** (public domain — no attribution required, credited
here anyway). Fetched + packed by `scripts/fetch-garden-assets.py`; consumed
by `src/ui/garden-flora.ts` and the garden environment in
`src/ui/RoomScene.tsx`.

## Models (`models/*.glb`)

1k-texture glTF exports, repacked as quantized single-file GLBs with
`gltf-transform optimize` under per-model meshopt triangle budgets (see the
MODELS table in the fetch script). Sets keep their clumps as separate meshes
(`--join false`) — `garden-flora.ts` scatters each clump as a variant. The
jacaranda's raw LOD0 scan is a 199MB bin, simplified to ~85k tris.

| File | Poly Haven asset | Role in scene |
| --- | --- | --- |
| `grass_medium_01.glb` | grass_medium_01 | instanced grass tufts |
| `flower_gazania.glb` | flower_gazania | wildflowers + READY-idea data nodes |
| `flower_ursinia.glb` | flower_ursinia | yellow wildflowers |
| `dandelion_01.glb` | dandelion_01 | dandelions + FORMING-idea data nodes |
| `periwinkle_plant.glb` | periwinkle_plant | purple wildflowers |
| `shrub_02.glb` / `shrub_03.glb` | shrub_02 / shrub_03 | meadow shrubs |
| `rock_moss_set_01.glb` | rock_moss_set_01 | mossy rock clusters |
| `tree_stump_01.glb` | tree_stump_01 | stumps |
| `jacaranda_tree.glb` | jacaranda_tree | background tree band + BUILD data nodes (sapling = concept, full tree = commissioned) |

## Ground (`ground/`)

`aerial_grass_rock` diffuse + GL normal at 1k, tiled ~22× across the meadow
disc.

## Sky (`sky/`)

`sunflowers_puresky` tonemapped JPG, downscaled 8k→4k, mapped onto a
vertically squashed dome so the zenith blue reaches the camera's low
horizon band.
