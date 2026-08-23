// The real skyline behind the Pond: CC-BY Sketchfab models (fetched by
// scripts/fetch-park-models.py, attribution in public/assets/park/ASSETS.md)
// stood on their true footprints at their true heights. Everywhere else the
// city stays extruded footprints; these six are the buildings the postcard
// is actually made of.
//
// Normalisation happens at load: some sources are z-up, none are metric —
// each model is rotated up, scaled so its bounding height equals the real
// roof height, re-based to y = 0 and centred on its footprint.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DEG, localFromLatLon } from "./park-frame";

export interface SkylineModelSpec {
  file: string;
  title: string;
  author: string;
  lat: number;
  lon: number;
  // Real roof/architectural height the model is scaled to (metres).
  heightM: number;
  // Yaw of the model's +Z, degrees clockwise from north. Manhattan's grid
  // runs 29°; each spec is tuned so the face the model authors as "front"
  // looks down its real street.
  bearing: number;
  // Source up-axis (glTF is y-up, but not every upload respects it).
  up?: "z";
  // Extruded footprints within this radius of the site are dropped so the
  // box city never doubles a real model.
  clearRadius: number;
}

export const SKYLINE_MODELS: SkylineModelSpec[] = [
  // Grand Army Plaza, 5th Ave & 59th — the château at the Pond's corner.
  { file: "plaza_hotel", title: "Plaza Hotel", author: "mshukla", lat: 40.76441, lon: -73.97441, heightM: 76, bearing: 119, clearRadius: 70 },
  // Billionaires' Row, west to east along 57th St.
  { file: "central_park_tower", title: "Central Park Tower", author: "NanoRay", lat: 40.76632, lon: -73.98107, heightM: 472, bearing: 29, clearRadius: 55 },
  { file: "220_cps", title: "220 Central Park South", author: "NanoRay", lat: 40.76688, lon: -73.98072, heightM: 290, bearing: 29, clearRadius: 40 },
  { file: "one57", title: "One57", author: "NanoRay", lat: 40.76552, lon: -73.97909, heightM: 306, bearing: 29, clearRadius: 45 },
  { file: "steinway_tower", title: "111 W 57th (Steinway Tower)", author: "NanoRay", lat: 40.76465, lon: -73.97753, heightM: 435, bearing: 29, up: "z", clearRadius: 40 },
  { file: "432_park", title: "432 Park Avenue", author: "NanoRay", lat: 40.76158, lon: -73.97175, heightM: 426, bearing: 29, clearRadius: 45 },
];

// Local sites (x, z, clearRadius) for the footprint-exclusion pass.
export function skylineSites(): { x: number; z: number; r: number }[] {
  return SKYLINE_MODELS.map((spec) => {
    const p = localFromLatLon(spec.lat, spec.lon);
    return { x: p.x, z: p.z, r: spec.clearRadius };
  });
}

export async function loadSkylineModels(groundAt: (x: number, z: number) => number, base = "/assets/park/models"): Promise<THREE.Group> {
  const loader = new GLTFLoader();
  const group = new THREE.Group();
  group.name = "park-skyline";
  await Promise.all(
    SKYLINE_MODELS.map(async (spec) => {
      const gltf = await loader.loadAsync(`${base}/${spec.file}.glb`);
      const model = gltf.scene;
      if (spec.up === "z") {
        model.rotation.x = -Math.PI / 2;
      }
      model.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const centre = box.getCenter(new THREE.Vector3());
      const scale = spec.heightM / size.y;
      // Wrap: scale + re-base inside a holder so the site transform stays
      // clean (position at the footprint, yaw down the street).
      const holder = new THREE.Group();
      holder.name = spec.file;
      model.position.sub(new THREE.Vector3(centre.x, box.min.y, centre.z));
      holder.scale.setScalar(scale);
      holder.add(model);
      const site = new THREE.Group();
      const p = localFromLatLon(spec.lat, spec.lon);
      site.position.set(p.x, groundAt(p.x, p.z), p.z);
      site.rotation.y = Math.PI - spec.bearing * DEG;
      site.add(holder);
      group.add(site);
    }),
  );
  return group;
}
