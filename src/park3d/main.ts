// Central Park evaluation page (park3d.html): the WHOLE park — 59th→110th
// St, 5th Ave→Central Park West — plus the city that frames it, at true 1:1
// scale (1 unit = 1 metre), from either of two sources:
//
//   ?src=tiles (default)  Google's Photorealistic 3D Tiles, streamed at
//                         runtime (needs a Map Tiles API key; Google ToS
//                         forbids persisting the tiles).
//   ?src=open             the baked public-domain world (park-world.ts):
//                         NAIP leaf-on orthophoto on USGS terrain, canopy
//                         relief, NYC building footprints — storable,
//                         offline, and the same module the room mounts.
//
// The crop (key C) cycles park → segment → city: "park" is the iconic
// rectangle with its margin of streets, "segment" the original 110th→90th St
// evaluation slab, "city" everything the source covers. Presets 1–6 are the
// original segment altitude ladder, unchanged; 7–9 are the whole-park
// pictures (postcard aerial, satellite, Sheep Meadow at eye level).
//
// Standalone dev-mode page (vite serves any root .html in dev; the
// production build ignores it). Key via ?key=… or VITE_MAPTILES_KEY in .env.

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
import {
  type CropMode,
  DEG,
  type GroundAt,
  PARK_CENTER,
  PRESETS,
  TILES_SURFACE_Y,
  cropPlanes,
  defaultGroundAt,
  localFromLatLon,
  nextCrop,
  presetEye,
  presetTarget,
} from "./park-frame";
import { PARK_ATTRIBUTION, loadParkWorld } from "./park-world";

const params = new URLSearchParams(location.search);
const src = params.get("src") === "open" ? "open" : "tiles";
const apiKey = params.get("key") ?? (import.meta.env.VITE_MAPTILES_KEY as string | undefined) ?? "";
const showError = (message: string) => {
  const err = document.getElementById("err")!;
  err.style.display = "block";
  err.textContent = message;
};
if (src === "tiles" && apiKey === "") {
  showError("No Map Tiles API key — pass ?key=… or set VITE_MAPTILES_KEY in .env (or try ?src=open, which needs no key)");
  throw new Error("missing api key");
}

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 2, 80_000);

// ── crop ───────────────────────────────────────────────────────────────────
// Clipping is LOCAL (per material) rather than renderer-global so the sky
// dome stays whole: every park material registers here and picks up the
// current crop; Google tiles register as they stream in.
renderer.localClippingEnabled = true;
const cropParam = params.get("crop");
let crop: CropMode = cropParam === "segment" || cropParam === "city" ? cropParam : "park";
// Once the crop has been chosen by hand (?crop= or the C key) the presets
// stop re-cropping — C stays the independent toggle it always was.
let cropPinned = cropParam === "park" || cropParam === "segment" || cropParam === "city";
let planes: THREE.Plane[] = [];
const clipped = new Set<THREE.Material>();
const registerClipped = (root: THREE.Object3D) => {
  root.traverse((node) => {
    const material = (node as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (material === undefined) {
      return;
    }
    for (const m of Array.isArray(material) ? material : [material]) {
      m.clippingPlanes = planes;
      clipped.add(m);
    }
  });
};
const unregisterClipped = (root: THREE.Object3D) => {
  root.traverse((node) => {
    const material = (node as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (material === undefined) {
      return;
    }
    for (const m of Array.isArray(material) ? material : [material]) {
      clipped.delete(m);
    }
  });
};
const cropEl = document.getElementById("crop")!;
const applyCrop = (mode: CropMode) => {
  crop = mode;
  planes = cropPlanes(mode);
  for (const m of clipped) {
    m.clippingPlanes = planes;
  }
  cropEl.textContent = mode;
  // The hazy table below a cropped slab; with Google's globe uncropped it
  // would slice through the curving tiles ~10 km out, so it leaves with the
  // crop there (the baked world never reaches that far).
  groundPlane.visible = src === "open" || mode !== "city";
};

// ── sky + haze ─────────────────────────────────────────────────────────────
// The garden's CC0 Poly Haven panorama on a full dome (no squash here — the
// aerial presets look well below the horizon) and a long linear haze so the
// far end of the park and the Midtown wall melt into the sky the way they do
// in every aerial photo. Haze stops short of the sky dome (fog: false).
const HORIZON = 0xd3e1ec;
scene.background = new THREE.Color(HORIZON);
scene.fog = new THREE.Fog(HORIZON, 2000, 13_000);
const skyTexture = new THREE.TextureLoader().load("/assets/garden/sky/sunflowers_puresky_4k.jpg");
skyTexture.colorSpace = THREE.SRGBColorSpace;
const skyDome = new THREE.Mesh(
  new THREE.SphereGeometry(40_000, 48, 32),
  new THREE.MeshBasicMaterial({ map: skyTexture, side: THREE.BackSide, fog: false, depthWrite: false }),
);
skyDome.renderOrder = -1;
scene.add(skyDome);
// Under a crop the world is a slab floating over nothing; a hazy ground
// plane (never clipped) reads as the rest of the city lost in haze instead
// of the panorama's field showing through from below.
const groundPlane = new THREE.Mesh(
  new THREE.CircleGeometry(39_000, 64),
  new THREE.MeshBasicMaterial({ color: 0xb8b6ae }),
);
groundPlane.rotation.x = -Math.PI / 2;
// Heights are relative to the park centre (on a rise ~35 m above the rivers),
// so the plane sits at river level.
groundPlane.position.y = -40;
scene.add(groundPlane);
applyCrop(crop);

// Light rig for the extruded city (the terrain and the Google tiles are
// unlit): warm afternoon sun from the south-west + sky/ground bounce.
scene.add(new THREE.HemisphereLight(0xc9dcf0, 0x8d9478, 1.1));
const sunLight = new THREE.DirectionalLight(0xfff1dc, 1.7);
sunLight.position.set(-0.45, 0.75, 0.45).multiplyScalar(1000);
scene.add(sunLight);
// Photogrammetry ships baked lighting (unlit materials) — a fallback for any
// non-unlit tile content.
scene.add(new THREE.AmbientLight(0xffffff, 0.6));

// ── source ─────────────────────────────────────────────────────────────────
// Ground under ground-relative presets: the baked DEM once the open world is
// in; before that (and for the Google stream, which has no DEM) the one
// anchor the presets stand on, lifted to the tiles frame's surface level.
let groundAt: GroundAt = src === "tiles" ? (x, z) => defaultGroundAt(x, z) + TILES_SURFACE_Y : defaultGroundAt;
let tiles: TilesRenderer | null = null;
if (src === "tiles") {
  const dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.7/");

  tiles = new TilesRenderer();
  tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: apiKey }));
  tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader }));
  tiles.registerPlugin(new TilesFadePlugin());
  // Local frame after reorientation: origin at the park centre on the WGS84
  // ellipsoid (the ground is ~2 m up), +Y up. The plugin's own frame is
  // X-WEST / Z-NORTH; the half-turn azimuth yields the +X east / −Z north
  // frame park-frame.ts, the crop planes and the presets are written in.
  tiles.registerPlugin(
    new ReorientationPlugin({ lat: PARK_CENTER.lat * DEG, lon: PARK_CENTER.lon * DEG, azimuth: Math.PI }),
  );
  tiles.setCamera(camera);
  tiles.setResolutionFromRenderer(camera, renderer);
  scene.add(tiles.group);
  tiles.addEventListener("load-model", (event) => registerClipped((event as unknown as { scene: THREE.Object3D }).scene));
  tiles.addEventListener("dispose-model", (event) => unregisterClipped((event as unknown as { scene: THREE.Object3D }).scene));

  // ?detail= overrides the screen-space error target (the auth plugin's
  // recommended setting is a bandwidth-friendly 20; ~2 forces Google's finest
  // available LOD at the cost of many more tile fetches).
  const detailParam = Number.parseFloat(params.get("detail") ?? "");
  if (Number.isFinite(detailParam) && detailParam > 0) {
    const t = tiles;
    t.addEventListener("load-tile-set", () => {
      t.errorTarget = detailParam;
    });
    t.errorTarget = detailParam;
  }
} else {
  document.getElementById("attrib")!.textContent = PARK_ATTRIBUTION;
  document.getElementById("source")!.textContent = "baked open data";
  const stepParam = Number.parseFloat(params.get("step") ?? "");
  // ?ortho=2048 downscales the photo on decode (what the room does).
  const orthoParam = Number.parseInt(params.get("ortho") ?? "", 10);
  loadParkWorld({
    stepM: Number.isFinite(stepParam) && stepParam > 0 ? stepParam : 6,
    models: params.get("models") !== "0",
    orthoMaxWidth: Number.isFinite(orthoParam) && orthoParam > 0 ? orthoParam : undefined,
    relief: params.get("relief") !== "0",
    buildings: params.get("buildings") !== "0",
  })
    .then((world) => {
      registerClipped(world.group);
      scene.add(world.group);
      groundAt = world.groundAt;
      if (PRESETS[currentPreset].groundRelative === true) {
        applyPreset(currentPreset);
      }
      applyFreeCamera();
    })
    .catch((error: unknown) => {
      showError(`open world failed: ${String(error)}`);
    });
}

// ── camera ─────────────────────────────────────────────────────────────────
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxDistance = 30_000;
controls.minDistance = 3;

let currentPreset = 6;
const applyPreset = (i: number) => {
  const preset = PRESETS[i];
  currentPreset = i;
  camera.position.copy(presetEye(preset, groundAt));
  controls.target.copy(presetTarget(preset, groundAt));
  controls.update();
  if (!cropPinned) {
    applyCrop(preset.crop);
  }
};
const presetParam = Number.parseInt(params.get("preset") ?? "", 10);
applyPreset(presetParam >= 1 && presetParam <= PRESETS.length ? presetParam - 1 : 6);
// Free camera for inspection: ?eye=x,y,z&look=x,y,z in local metres, or
// ?at=lat,lon,height&see=lat,lon,height with heights above the ground.
const vec = (value: string | null, geo: boolean): THREE.Vector3 | null => {
  const parts = (value ?? "").split(",").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    return null;
  }
  if (geo) {
    const p = localFromLatLon(parts[0], parts[1]);
    return new THREE.Vector3(p.x, parts[2] + groundAt(p.x, p.z), p.z);
  }
  return new THREE.Vector3(parts[0], parts[1], parts[2]);
};
const applyFreeCamera = () => {
  const eye = vec(params.get("eye"), false) ?? vec(params.get("at"), true);
  const look = vec(params.get("look"), false) ?? vec(params.get("see"), true);
  if (eye !== null && look !== null) {
    camera.position.copy(eye);
    controls.target.copy(look);
    controls.update();
  }
};
applyFreeCamera();

const presetsEl = document.getElementById("presets")!;
PRESETS.forEach((preset, i) => {
  const btn = document.createElement("button");
  btn.textContent = `${i + 1}: ${preset.label}`;
  btn.title = `crop: ${preset.crop}`;
  btn.addEventListener("click", () => applyPreset(i));
  presetsEl.appendChild(btn);
});
window.addEventListener("keydown", (event) => {
  const i = Number.parseInt(event.key, 10) - 1;
  if (i >= 0 && i < PRESETS.length) {
    applyPreset(i);
  }
  if (event.key === "c" || event.key === "C") {
    cropPinned = true;
    applyCrop(nextCrop(crop));
  }
});

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  tiles?.setResolutionFromRenderer(camera, renderer);
});

const altEl = document.getElementById("alt")!;
renderer.setAnimationLoop(() => {
  controls.update();
  camera.updateMatrixWorld();
  tiles?.update();
  renderer.render(scene, camera);
  altEl.textContent = `${Math.round(camera.position.y)} m · ${Math.round(camera.position.distanceTo(controls.target))} m from target`;
});
