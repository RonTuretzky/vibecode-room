// Photorealistic 3D Tiles evaluation page (park3d.html): streams Google's
// photogrammetry of the REAL Central Park — the 110th→90th St segment (North
// Woods, Harlem Meer, the Reservoir's north end) — at true 1:1 scale (1 unit
// = 1 meter), cropped to the segment slab by clipping planes. Altitude presets
// (keys 1–6) exist to answer ONE question: at which camera heights does the
// photogrammetry look acceptable for the room?
//
// Standalone dev-mode page (vite serves any root .html in dev; the production
// build ignores it) — deliberately not wired into RoomScene until the
// evaluation says which altitudes/looks are worth integrating.
//
// Key comes from ?key=… or VITE_MAPTILES_KEY in .env (never committed).
// Google ToS: tiles stream at runtime and may not be persisted offline; one
// root-tile session covers 3+ hours, so a projector day is a handful of the
// free tier's ~1k monthly sessions.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { TilesRenderer } from "3d-tiles-renderer";
import {
  GLTFExtensionsPlugin,
  GoogleCloudAuthPlugin,
  ReorientationPlugin,
  TilesFadePlugin,
} from "3d-tiles-renderer/plugins";

const params = new URLSearchParams(location.search);
const apiKey = params.get("key") ?? (import.meta.env.VITE_MAPTILES_KEY as string | undefined) ?? "";
if (apiKey === "") {
  const err = document.getElementById("err")!;
  err.style.display = "block";
  err.textContent = "No Map Tiles API key — pass ?key=… or set VITE_MAPTILES_KEY in .env";
  throw new Error("missing api key");
}

const DEG = Math.PI / 180;
// Center of the 110th→90th St segment (20 blocks ≈ 1610 m of the park's north
// end), on the park's center line.
const CENTER_LAT = 40.7922;
const CENTER_LON = -73.9584;
// Manhattan grid bearing: the park's long axis runs ~29° east of true north.
const AXIS_BEARING = 29 * DEG;
const HALF_LEN = 805; // 10 blocks either side of center
const HALF_WIDTH = 465; // park half-width + a sidewalk margin

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xbfd9ee);
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 2, 60_000);

// Local frame after reorientation: +X east, +Y up, -Z north. The slab crop is
// two plane pairs: across the axis (110th and 90th St cuts) and along it
// (just outside the park's east/west walls).
const axis = new THREE.Vector3(Math.sin(AXIS_BEARING), 0, -Math.cos(AXIS_BEARING));
const perp = new THREE.Vector3(Math.cos(AXIS_BEARING), 0, Math.sin(AXIS_BEARING));
const cropPlanes = [
  new THREE.Plane(axis.clone().negate(), HALF_LEN),
  new THREE.Plane(axis.clone(), HALF_LEN),
  new THREE.Plane(perp.clone().negate(), HALF_WIDTH),
  new THREE.Plane(perp.clone(), HALF_WIDTH),
];
let cropped = true;
renderer.clippingPlanes = cropPlanes;

// Photogrammetry ships baked lighting (unlit materials) — lights are only a
// fallback for any non-unlit tile content.
scene.add(new THREE.AmbientLight(0xffffff, 2.2));

const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.7/");

const tiles = new TilesRenderer();
tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: apiKey }));
tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader }));
tiles.registerPlugin(new TilesFadePlugin());
tiles.registerPlugin(new ReorientationPlugin({ lat: CENTER_LAT * DEG, lon: CENTER_LON * DEG }));
tiles.setCamera(camera);
tiles.setResolutionFromRenderer(camera, renderer);
scene.add(tiles.group);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxDistance = 20_000;
controls.minDistance = 10;

// Altitude presets: eye stands south of center looking north up the segment.
const PRESETS: { alt: number; pitch: number }[] = [
  { alt: 2500, pitch: 72 },
  { alt: 1200, pitch: 60 },
  { alt: 600, pitch: 55 },
  { alt: 250, pitch: 45 },
  { alt: 100, pitch: 30 },
  { alt: 40, pitch: 15 },
];
const applyPreset = (i: number) => {
  const { alt, pitch } = PRESETS[i];
  const horiz = alt / Math.tan(pitch * DEG);
  camera.position.copy(axis).multiplyScalar(-horiz).setY(alt);
  controls.target.set(0, 0, 0);
  controls.update();
};
applyPreset(2);

const presetsEl = document.getElementById("presets")!;
PRESETS.forEach(({ alt }, i) => {
  const btn = document.createElement("button");
  btn.textContent = `${i + 1}: ${alt}m`;
  btn.addEventListener("click", () => applyPreset(i));
  presetsEl.appendChild(btn);
});
window.addEventListener("keydown", (event) => {
  const i = Number.parseInt(event.key, 10) - 1;
  if (i >= 0 && i < PRESETS.length) {
    applyPreset(i);
  }
  if (event.key === "c" || event.key === "C") {
    cropped = !cropped;
    renderer.clippingPlanes = cropped ? cropPlanes : [];
  }
});

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  tiles.setResolutionFromRenderer(camera, renderer);
});

const altEl = document.getElementById("alt")!;
renderer.setAnimationLoop(() => {
  controls.update();
  camera.updateMatrixWorld();
  tiles.update();
  renderer.render(scene, camera);
  altEl.textContent = `${Math.round(camera.position.y)} m · ${Math.round(camera.position.distanceTo(controls.target))} m from target`;
});
