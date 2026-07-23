import { useEffect, useRef } from "react";
import * as THREE from "three";
import type { IdeaTrayItem, ProjectorProcess } from "./types";
import { registerSceneDwellSource, type SceneDwellRect } from "./gesture/scene-source";
import { registerSceneCameraControl } from "./gesture/camera-source";
import { cornerEye, cornerVerticalFovDeg, cornerYaw } from "./corner-lock";

// The full-viewport 3D stage (after conductor-github-visualizer): the scene IS
// the app background and every panel floats over it. Two render modes share
// the same data:
//   garden — processes are trees, ideas are flowers on a sunlit pasture
//   orbit  — processes and ideas are glowing orbs adrift in a nebula
// Navigation matches the visualizer: drag = orbit, shift+drag = pan,
// wheel = zoom, fit-to-content on demand. Clicks still build/steer (a drag
// longer than a few px suppresses the click, like the original).
//
// TWO-WALL CONTRACT: every window renders the COMPLETE scene (all ideas AND
// all builds). The scene never assumes it is a singleton per machine — each
// window owns its renderer, camera rig, and animation loop, and only the data
// (via the shared SSE stream upstream) is common. A `wall` identity may seed a
// different DEFAULT camera yaw per window so two projections of the same room
// don't boot pixel-identical, but it never filters content.
//
// In gesture mode (`cornerLock`) the two windows instead form a RIGID camera
// pair rendering ONE continuous world around the physical 90° corner: one
// shared eye point, yaws exactly 90° apart, 90° horizontal FOV per window —
// wall A's right edge continues onto wall B's left edge (see corner-lock.ts).

export interface IdeaOrbSpec {
  id: string | null; // null = the primary pending suggestion
  pitch: string;
  confidence: number;
  status: "ready" | "forming";
  maturity: IdeaTrayItem["maturity"];
  verified: boolean;
}

export interface TreeSpec {
  upid: string;
  callsign: string;
  state: ProjectorProcess["state"];
  progress: number;
  // The INFERRED project title (LLM-named); labels prefer it over the callsign.
  task: string;
  // True when this process is the live steering target — the node gets a
  // steering ring so the room can see where spoken transcript is routing.
  steering: boolean;
  // TWO-STAGE language, legible at projector distance: a "concept" (kickoff:
  // mock lanes + pitch deck) renders as a SAPLING; a "commissioned" project
  // (real subscription execution) grows into the FULL tree with a gold
  // commission ring. Absent = concept (legacy callers).
  stage?: "concept" | "commissioned";
}

export type SceneMode = "garden" | "orbit";
// Spatial layout strategies (visualizer parity: standard radial, H3 Poincaré
// ball after Munzner 1997, and the Lamping/Rao/Pirolli Poincaré disk).
export type SceneLayout = "radial" | "ball" | "disk";

interface RoomSceneProps {
  ideas: IdeaOrbSpec[];
  trees: TreeSpec[];
  mode: SceneMode;
  layout: SceneLayout;
  // Wall identity ("A" | "B" | …) or null. Seeds the default camera yaw (desk
  // mode) or selects this window's side of the corner-locked pair (gesture
  // mode) — it NEVER filters content.
  wall?: string | null;
  // CORNER LOCK (gesture mode with an explicit wall): this window is one half
  // of a rigid two-window pair rendering a single continuous world around the
  // physical 90° corner — fixed shared eye point, per-wall yaws exactly 90°
  // apart, exactly 90° horizontal FOV, and NO drift/orbit/fit/focus so the
  // seam edge stays coherent. Fixed per window (URL-derived).
  cornerLock?: boolean;
  // Increment to request a one-shot fit-to-content camera move.
  fitSignal: number;
  // GUIDED-DEMO FOCUS: when set, the camera glides to frame this process's
  // node (retrying until the node exists, since a fresh spawn's tree appears a
  // beat after the snapshot). Null = no focus request; the user's own
  // drag/zoom/fit always takes over afterwards.
  focusUpid?: string | null;
  // When false (pure gesture mode: hands point, nobody drags), the pointer
  // never binds to the scene — no drag-orbit/pan/zoom/click, so pointing at a
  // node can never fight the camera. Keyboard camera controls (G/L/F) and the
  // dwell layer's raycast targeting still work. Fixed per window (URL-derived).
  pointerNav?: boolean;
  onAcceptIdea: (id: string | null) => void;
  onSelectProcess: (callsign: string) => void;
}

const MATURITY_COLOR: Record<IdeaTrayItem["maturity"], number> = {
  forming: 0x38bdf8,
  proposed: 0x38bdf8,
  elaborated: 0x00bcd4,
  actionable: 0x00ff88,
};
const STATE_COLOR: Record<TreeSpec["state"], number> = {
  planning: 0x38bdf8,
  active: 0x00ff88,
  paused: 0xf5a623,
  halted: 0xff3b30,
  blocked: 0xff5544,
  completed: 0x9affc9,
};
const BUD_COLOR = 0x6b8296;
const VERIFIED_COLOR = 0x9affc9;
const STEERING_COLOR = 0x9ee2ff;
// Gold ground ring marking a COMMISSIONED project (real execution running).
const COMMISSION_COLOR = 0xffd166;
const TRUNK_COLOR = 0x4a3527;
const FLASH_MS = 1500;

// Node label title: the inferred project title when the server has named the
// build, else the callsign so a freshly spawned process is never label-less.
function treeTitle(spec: TreeSpec): string {
  return spec.task.length > 0 ? spec.task : spec.callsign;
}

// Node label status: stage · state · progress, with the live steering marker
// appended so the steering target reads from across the room. The stage word
// carries the two-stage language onto every node in every render style.
function treeStatus(spec: TreeSpec): string {
  const stage = spec.stage === "commissioned" ? "commissioned" : "concept";
  return `${stage} · ${spec.state} · ${Math.round(spec.progress)}%${spec.steering ? " · ⟵ steering" : ""}`;
}

// ── hyperbolic layout constants (after the visualizer's H3/disk modes) ───────
// Poincaré radial coordinates r ∈ (0,1): shells picked via tanh(d/2) for a
// hyperbolic edge length d; display scale is the conformal factor 1 - r².
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const BALL_RADIUS = 5.8;
const BALL_CENTER_Y = 3.6;
const BALL_SHELL_PROC = 0.5; // tanh(1.1/2)
const BALL_SHELL_READY = 0.74; // tanh(1.9/2)
const BALL_SHELL_FORMING = 0.87; // tanh(2.65/2)
const DISK_RADIUS = 7.2;
const DISK_R_PROC = 0.45;
const DISK_R_READY = 0.7;
const DISK_R_FORMING = 0.87;

// Evenly spread point i of n over the unit sphere (Fibonacci sphere).
function fibSphereDir(i: number, n: number): THREE.Vector3 {
  const z = 1 - (2 * (i + 0.5)) / Math.max(n, 1);
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  const phi = i * GOLDEN_ANGLE;
  return new THREE.Vector3(r * Math.cos(phi), z, r * Math.sin(phi));
}

// Conformal Poincaré scale: nodes shrink toward the boundary (focus+context).
function poincareScale(r: number): number {
  return Math.max(1 - r * r, 0.22);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function ideaKey(spec: IdeaOrbSpec): string {
  return spec.id ?? "__primary__";
}

// Per-wall DEFAULT camera yaw: wall A (or no wall) faces the scene head-on and
// each subsequent wall letter starts ~32° further around the orbit, so two
// projections of the same full room don't boot pixel-identical. This is purely
// the boot framing — every window's drag/zoom/fit owns its camera afterwards,
// and the seed NEVER filters what the scene contains.
function wallYawSeed(wall: string | null | undefined): number {
  if (wall === null || wall === undefined || wall.length === 0) {
    return 0;
  }
  const step = wall.trim().toUpperCase().charCodeAt(0) - 65; // "A" → 0, "B" → 1, …
  if (!Number.isFinite(step) || step <= 0) {
    return 0;
  }
  return (step % 8) * 0.55;
}

function cssHex(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

// Canvas-texture label sprite: word-wrapped title over a rounded glass card,
// always on top, scaled to the true canvas aspect.
function makeLabelSprite(title: string, statusLine: string, accentCss: string): THREE.Sprite {
  const dpr = 2;
  const maxWidth = 220;
  const padX = 13;
  const padY = 9;
  const titleFont = "600 13px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  const statusFont = "600 10px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

  const measure = document.createElement("canvas").getContext("2d")!;
  measure.font = titleFont;
  const words = title.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const attempt = current.length > 0 ? `${current} ${word}` : word;
    if (measure.measureText(attempt).width > maxWidth - padX * 2 && current.length > 0) {
      lines.push(current);
      current = word;
      if (lines.length === 3) {
        break;
      }
    } else {
      current = attempt;
    }
  }
  if (lines.length < 3 && current.length > 0) {
    lines.push(current);
  } else if (current.length > 0) {
    lines[2] = `${lines[2].slice(0, 26)}…`;
  }
  const widest = Math.max(...lines.map((line) => measure.measureText(line).width), measure.measureText(statusLine).width * 0.8);
  const width = Math.min(maxWidth, Math.ceil(widest) + padX * 2);
  const lineHeight = 17;
  const statusHeight = statusLine.length > 0 ? 15 : 0;
  const height = padY * 2 + lines.length * lineHeight + statusHeight;

  const canvas = document.createElement("canvas");
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);
  ctx.beginPath();
  ctx.roundRect(0.5, 0.5, width - 1, height - 1, 9);
  ctx.fillStyle = "rgba(6, 16, 24, 0.78)";
  ctx.fill();
  ctx.strokeStyle = "rgba(158, 226, 255, 0.2)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.font = titleFont;
  ctx.fillStyle = "#eaf6ff";
  ctx.textBaseline = "top";
  lines.forEach((line, i) => ctx.fillText(line, padX, padY + i * lineHeight));
  if (statusLine.length > 0) {
    ctx.font = statusFont;
    ctx.fillStyle = accentCss;
    ctx.fillText(statusLine.toUpperCase(), padX, padY + lines.length * lineHeight + 2);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }));
  const worldScale = 1 / 56;
  sprite.scale.set(width * worldScale, height * worldScale, 1);
  sprite.center.set(0.5, 0);
  sprite.renderOrder = 12;
  return sprite;
}

// Soft radial glow texture (halos, moon, auroras) tinted via material color.
function makeGlowTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, "rgba(255,255,255,0.85)");
  gradient.addColorStop(0.35, "rgba(255,255,255,0.28)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

// Gradient sky dome (visualizer technique) with a 3-stop ramp for extra depth.
// NOTE: BackSide alone makes the sphere visible from inside — flipping the
// geometry with scale(-1,1,1) on top of it double-inverts the winding and the
// dome vanishes (the sky rendered as the black clear color for months).
function makeSkyDome(bottom: number, mid: number, top: number): THREE.Mesh {
  const geom = new THREE.SphereGeometry(160, 32, 32);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      bottomColor: { value: new THREE.Color(bottom) },
      midColor: { value: new THREE.Color(mid) },
      topColor: { value: new THREE.Color(top) },
      offset: { value: 20 },
    },
    vertexShader: `
      varying vec3 vWorldPosition;
      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 bottomColor;
      uniform vec3 midColor;
      uniform vec3 topColor;
      uniform float offset;
      varying vec3 vWorldPosition;
      void main() {
        float h = clamp(normalize(vWorldPosition + offset).y, 0.0, 1.0);
        vec3 color = h < 0.35
          ? mix(bottomColor, midColor, smoothstep(0.0, 0.35, h))
          : mix(midColor, topColor, smoothstep(0.35, 1.0, h));
        gl_FragColor = vec4(color, 1.0);
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
  });
  return new THREE.Mesh(geom, mat);
}

function makeStars(rng: () => number, count: number, size: number, opacity: number, fullDome: boolean): THREE.Points {
  const positions: number[] = [];
  for (let i = 0; i < count; i++) {
    const theta = rng() * Math.PI * 2;
    const phi = rng() * Math.PI * (fullDome ? 0.62 : 0.42) + 0.06;
    const r = 130;
    positions.push(r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta));
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  return new THREE.Points(geom, new THREE.PointsMaterial({ color: 0xdcecff, size, transparent: true, opacity, fog: false }));
}

interface SceneEnv {
  update: (t: number) => void;
  dispose: () => void;
}

type EntryKind = "tree" | "flower" | "orb-proc" | "orb-idea";

interface Entry {
  kind: EntryKind;
  ideaSpec?: IdeaOrbSpec;
  treeSpec?: TreeSpec;
  group: THREE.Group;
  mats: (THREE.MeshPhongMaterial | THREE.MeshStandardMaterial)[];
  baseEmissive: number;
  head: THREE.Group | null;
  headY: number;
  label: THREE.Sprite | null;
  targetPos: THREE.Vector3;
  targetScale: number;
  // Conformal Poincaré factor (1 near the centre, small near the boundary).
  scaleMult: number;
  phase: number;
  flashStart: number | null;
  removing: boolean;
}

export function RoomScene({ ideas, trees, mode, layout, wall = null, fitSignal, focusUpid = null, pointerNav = true, cornerLock = false, onAcceptIdea, onSelectProcess }: RoomSceneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const ideasRef = useRef(ideas);
  ideasRef.current = ideas;
  const treesRef = useRef(trees);
  treesRef.current = trees;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  // Wall identity is fixed per window (parsed from the URL once); a ref keeps
  // the mount-once scene effect honest about never re-running for it.
  const wallRef = useRef(wall);
  wallRef.current = wall;
  // Same deal: gesture windows never rebind pointer navigation mid-session.
  const pointerNavRef = useRef(pointerNav);
  pointerNavRef.current = pointerNav;
  // Same deal: the corner lock is URL-derived and fixed for the window's life.
  const cornerLockRef = useRef(cornerLock);
  cornerLockRef.current = cornerLock;
  const fitRef = useRef(fitSignal);
  fitRef.current = fitSignal;
  const focusRef = useRef<string | null>(focusUpid);
  focusRef.current = focusUpid;
  const onAcceptRef = useRef(onAcceptIdea);
  onAcceptRef.current = onAcceptIdea;
  const onSelectRef = useRef(onSelectProcess);
  onSelectRef.current = onSelectProcess;
  const tick = useRef(0);

  useEffect(() => {
    tick.current += 1;
  }, [ideas, trees, mode, layout]);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null || typeof window === "undefined") {
      return;
    }
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 400);
    // Two-wall default mode runs TWO simultaneous fullscreen WebGL contexts on
    // one machine, so keep the renderer settings sane: prefer the discrete GPU,
    // cap the pixel ratio, and (below) pause the frame loop while hidden.
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    // Lighting is per-environment (added to each env's group): the garden is a
    // sunny pastoral day, orbit keeps the cool night rig — one global rig can't
    // serve both.

    const glowTexture = makeGlowTexture();

    // ── camera rig (visualizer-style spherical orbit around a pannable target)
    const rig = {
      angle: 0,
      radius: 15,
      height: 4.6,
      targetX: 0,
      targetZ: 0,
      lookY: 1.7,
      // desired* lerp targets so mode/view/fit changes glide
      dAngle: 0,
      dRadius: 15,
      dHeight: 4.6,
      dTargetX: 0,
      dTargetZ: 0,
    };
    const rigDefaults = () => {
      if (layoutRef.current === "ball") {
        return { radius: 12.5, height: 5.4, lookY: BALL_CENTER_Y };
      }
      if (layoutRef.current === "disk") {
        const diskY = modeRef.current === "garden" ? 0.05 : 2.6;
        // Look down onto the disk so the hyperbolic compression reads.
        return { radius: 10.5, height: diskY + 9.5, lookY: diskY };
      }
      if (modeRef.current === "garden") {
        return { radius: 15.5, height: 4.6, lookY: 1.7 };
      }
      return { radius: 14.5, height: 5.2, lookY: 1.7 };
    };
    const resetRig = () => {
      const d = rigDefaults();
      rig.dRadius = d.radius;
      rig.dHeight = d.height;
      rig.lookY = d.lookY;
      rig.dTargetX = 0;
      rig.dTargetZ = 0;
    };
    const applyRig = () => {
      camera.position.set(
        rig.targetX + Math.sin(rig.angle) * rig.radius,
        rig.height,
        rig.targetZ + Math.cos(rig.angle) * rig.radius,
      );
      camera.lookAt(rig.targetX, rig.lookY, rig.targetZ);
    };
    // ── corner lock (gesture mode with an explicit wall) ────────────────────
    // The rigid two-window pair: ONE shared eye point, a horizontal view
    // direction whose yaw is exactly 90° apart per wall, and (in resize) a
    // fov pinned to exactly 90° HORIZONTAL — so the two windows tile one
    // continuous world around the physical corner: wall A's right edge
    // continues onto wall B's left edge. NOTHING may move this camera: drag/
    // wheel are unbound in gesture mode, and fit/focus/inertia/lerp are all
    // gated off below. The orbit rig is bypassed entirely.
    const cornerLocked = cornerLockRef.current;
    const cornerLockedYaw = cornerYaw(wallRef.current);
    const applyCornerRig = () => {
      const eye = cornerEye();
      camera.position.set(eye.x, eye.y, eye.z);
      camera.lookAt(eye.x - Math.sin(cornerLockedYaw), eye.y, eye.z - Math.cos(cornerLockedYaw));
    };

    resetRig();
    if (cornerLocked) {
      applyCornerRig();
    } else {
      // Per-window boot framing: the wall identity only seeds the default yaw
      // (resetRig never touches the angle, so mode/layout switches keep it).
      rig.dAngle = wallYawSeed(wallRef.current);
      rig.angle = rig.dAngle;
      rig.radius = rig.dRadius;
      rig.height = rig.dHeight;
      applyRig();
    }

    // ── environments ────────────────────────────────────────────────────────
    // Pastoral daylight garden: blue sky, drifting cumulus, a warm sun,
    // rolling haze-tinted hills, and a fresh green meadow with natural
    // wildflowers, butterflies and drifting seed motes. Node/label data colors
    // are unchanged — the dark glass label cards pop against the bright sky.
    const buildGardenEnv = (): SceneEnv => {
      const rng = mulberry32(0x47415244);
      const group = new THREE.Group();
      scene.add(group);
      // Aerial perspective: haze tinted to the sky horizon so meadow and hills
      // melt into the sky instead of ending at a hard disc edge.
      scene.fog = new THREE.Fog(0xdcedf8, 80, 210);

      // Daylight rig (env-local): warm sun key, blue-sky/grass hemisphere
      // bounce, and a soft cool fill so shaded sides stay readable.
      group.add(new THREE.HemisphereLight(0xbdd9f2, 0x7fae62, 0.7));
      const sunLight = new THREE.DirectionalLight(0xfff2d9, 0.95);
      sunLight.position.set(-24, 42, -30);
      group.add(sunLight);
      const fillLight = new THREE.DirectionalLight(0xcfe4ff, 0.25);
      fillLight.position.set(18, 12, 16);
      group.add(fillLight);

      const sky = makeSkyDome(0xeaf6fc, 0x9fd0f0, 0x3e8ed8);
      group.add(sky);

      // Sun + bloom, upper-left of the default framing (clear of the HUD).
      const sun = new THREE.Mesh(
        new THREE.SphereGeometry(2.8, 24, 24),
        new THREE.MeshBasicMaterial({ color: 0xfff8e6, fog: false }),
      );
      // Low morning sun: the default rig only frames ~12° above the horizon,
      // so the sun (and the clouds below) must hug the horizon band to be
      // seen without panning up.
      sun.position.set(-34, 17, -70);
      group.add(sun);
      const sunHalo = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: glowTexture, color: 0xfff2c8, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }),
      );
      sunHalo.position.copy(sun.position);
      sunHalo.scale.setScalar(26);
      group.add(sunHalo);
      const sunBloom = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: glowTexture, color: 0xfff6da, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }),
      );
      sunBloom.position.copy(sun.position);
      sunBloom.scale.setScalar(46);
      group.add(sunBloom);

      // Cumulus: soft canvas-blob sprites drifting slowly around the dome.
      const makeCloudTexture = (seed: number): THREE.CanvasTexture => {
        const cloudRng = mulberry32(seed);
        const canvas = document.createElement("canvas");
        canvas.width = 256;
        canvas.height = 128;
        const ctx = canvas.getContext("2d")!;
        // Clustered blobs with bright cores so the sprite reads as one
        // defined cumulus, not a smear of haze.
        for (let i = 0; i < 16; i++) {
          const cx = 128 + (cloudRng() - 0.5) * 150;
          const cy = 68 + (cloudRng() - 0.5) * 44;
          const cr = 20 + cloudRng() * 30;
          const blob = ctx.createRadialGradient(cx, cy, 0, cx, cy, cr);
          blob.addColorStop(0, "rgba(255,255,255,0.9)");
          blob.addColorStop(0.55, "rgba(255,255,255,0.45)");
          blob.addColorStop(1, "rgba(255,255,255,0)");
          ctx.fillStyle = blob;
          ctx.fillRect(cx - cr, cy - cr, cr * 2, cr * 2);
        }
        return new THREE.CanvasTexture(canvas);
      };
      const cloudTextures = [makeCloudTexture(0x434c31), makeCloudTexture(0x434c32)];
      const clouds: { sprite: THREE.Sprite; angle: number; dist: number; height: number; speed: number; phase: number }[] = [];
      for (let i = 0; i < 9; i++) {
        const sprite = new THREE.Sprite(
          new THREE.SpriteMaterial({ map: cloudTextures[i % cloudTextures.length], transparent: true, opacity: 0.75 + rng() * 0.2, depthWrite: false, fog: false }),
        );
        const width = 30 + rng() * 25;
        sprite.scale.set(width, width * (0.34 + rng() * 0.1), 1);
        const cloud = {
          sprite,
          angle: (i / 9) * Math.PI * 2 + rng(),
          dist: 85 + rng() * 40,
          height: 8 + rng() * 14,
          speed: 0.004 + rng() * 0.006,
          phase: rng() * Math.PI * 2,
        };
        sprite.position.set(Math.cos(cloud.angle) * cloud.dist, cloud.height, Math.sin(cloud.angle) * cloud.dist);
        group.add(sprite);
        clouds.push(cloud);
      }

      // Ground: mottled pasture disc — a fresh-to-deep green radial gradient
      // with soft patch blobs so the meadow reads grown, not painted.
      const gCanvas = document.createElement("canvas");
      gCanvas.width = 512;
      gCanvas.height = 512;
      const gCtx = gCanvas.getContext("2d")!;
      const gGrad = gCtx.createRadialGradient(256, 256, 20, 256, 256, 256);
      gGrad.addColorStop(0, "#7fbf62");
      gGrad.addColorStop(0.55, "#5da84b");
      gGrad.addColorStop(1, "#4f9a52");
      gCtx.fillStyle = gGrad;
      gCtx.fillRect(0, 0, 512, 512);
      for (let i = 0; i < 70; i++) {
        const px = rng() * 512;
        const py = rng() * 512;
        const pr = 12 + rng() * 40;
        const patch = gCtx.createRadialGradient(px, py, 0, px, py, pr);
        const tone = rng() < 0.5 ? "58, 132, 64" : "152, 208, 116";
        patch.addColorStop(0, `rgba(${tone}, 0.22)`);
        patch.addColorStop(1, `rgba(${tone}, 0)`);
        gCtx.fillStyle = patch;
        gCtx.fillRect(px - pr, py - pr, pr * 2, pr * 2);
      }
      const groundTexture = new THREE.CanvasTexture(gCanvas);
      const ground = new THREE.Mesh(
        new THREE.CircleGeometry(110, 64),
        new THREE.MeshPhongMaterial({ map: groundTexture, shininess: 6, side: THREE.DoubleSide }),
      );
      ground.rotation.x = -Math.PI / 2;
      group.add(ground);

      // Rolling hills ring the horizon (haze-tinted by the fog) so the meadow
      // ends in pasture, not at a disc edge; some carry distant tree clumps.
      // Haze-baked tones: the fog only part-covers the hills, so their base
      // color already leans toward the horizon pale for aerial perspective.
      const hillTones = [0x93bb8a, 0x9fc497, 0x8ab188];
      const clumpMat = new THREE.MeshPhongMaterial({ color: 0x6f9d6a });
      for (let i = 0; i < 7; i++) {
        const angle = (i / 7) * Math.PI * 2 + rng() * 0.5;
        const dist = 96 + rng() * 14;
        const rx = 26 + rng() * 20;
        const ry = 3 + rng() * 3;
        const hill = new THREE.Mesh(
          new THREE.SphereGeometry(1, 24, 16),
          new THREE.MeshPhongMaterial({ color: hillTones[i % hillTones.length] }),
        );
        hill.scale.set(rx, ry, 14 + rng() * 8);
        hill.position.set(Math.cos(angle) * dist, -ry * 0.35, Math.sin(angle) * dist);
        group.add(hill);
        if (rng() < 0.6) {
          const clumps = 2 + Math.floor(rng() * 3);
          for (let c = 0; c < clumps; c++) {
            const clump = new THREE.Mesh(new THREE.IcosahedronGeometry(0.9 + rng() * 1.1, 1), clumpMat);
            clump.position.set(
              hill.position.x + (rng() - 0.5) * rx * 0.7,
              ry * 0.4,
              hill.position.z + (rng() - 0.5) * 10,
            );
            group.add(clump);
          }
        }
      }

      // Decorations: grass tufts, natural wildflowers (daisy / buttercup /
      // poppy / cornflower / lavender), leafy bushes.
      const grassMats = [0x6db457, 0x7cc266, 0x61aa4d].map(
        (color) => new THREE.MeshPhongMaterial({ color, side: THREE.DoubleSide }),
      );
      const bushMat = new THREE.MeshPhongMaterial({ color: 0x58a046 });
      const daisyEyeMat = new THREE.MeshPhongMaterial({ color: 0xf7c948, emissive: 0xf7c948, emissiveIntensity: 0.1 });
      const DAISY_WHITE = 0xfdf6e3;
      const wildColors = [DAISY_WHITE, 0xffd75e, 0xe8654f, 0x7fa8e0, 0xb590dd];
      for (let i = 0; i < 240; i++) {
        const angle = rng() * Math.PI * 2;
        const radius = 5 + rng() * 62;
        const x = Math.cos(angle) * radius;
        const z = Math.sin(angle) * radius;
        const kind = rng();
        if (kind < 0.45) {
          const tuft = new THREE.Group();
          const mat = grassMats[Math.floor(rng() * grassMats.length)];
          const blades = 3 + Math.floor(rng() * 3);
          for (let b = 0; b < blades; b++) {
            const blade = new THREE.Mesh(new THREE.PlaneGeometry(0.08, 0.4 + rng() * 0.35), mat);
            blade.position.set((rng() - 0.5) * 0.2, 0.22 + rng() * 0.14, (rng() - 0.5) * 0.2);
            blade.rotation.y = rng() * Math.PI;
            blade.rotation.x = -0.15 + rng() * 0.3;
            tuft.add(blade);
          }
          tuft.position.set(x, 0, z);
          group.add(tuft);
        } else if (kind < 0.75) {
          const color = wildColors[Math.floor(rng() * wildColors.length)];
          const mat = new THREE.MeshPhongMaterial({ color, emissive: color, emissiveIntensity: 0.05 });
          const flower = new THREE.Group();
          const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.04, 0.42, 4), grassMats[0]);
          stem.position.y = 0.21;
          flower.add(stem);
          const head = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 8), mat);
          head.position.y = 0.46;
          flower.add(head);
          if (color === DAISY_WHITE) {
            const eye = new THREE.Mesh(new THREE.SphereGeometry(0.045, 6, 6), daisyEyeMat);
            eye.position.y = 0.55;
            flower.add(eye);
          }
          flower.position.set(x, 0, z);
          group.add(flower);
        } else {
          const bush = new THREE.Group();
          const puffs = 2 + Math.floor(rng() * 2);
          for (let p = 0; p < puffs; p++) {
            const size = 0.18 + rng() * 0.22;
            const puff = new THREE.Mesh(new THREE.IcosahedronGeometry(size, 1), bushMat);
            puff.position.set((rng() - 0.5) * 0.35, size * 0.8, (rng() - 0.5) * 0.35);
            bush.add(puff);
          }
          bush.position.set(x, 0, z);
          group.add(bush);
        }
      }

      // Butterflies: two wings hinged on the body line, flapping while they
      // wander a slow Lissajous over the meadow (the day shift's fireflies).
      const wingLeftGeo = new THREE.PlaneGeometry(0.2, 0.28);
      wingLeftGeo.translate(0.11, 0, 0);
      wingLeftGeo.rotateX(-Math.PI / 2);
      const wingRightGeo = new THREE.PlaneGeometry(0.2, 0.28);
      wingRightGeo.translate(-0.11, 0, 0);
      wingRightGeo.rotateX(-Math.PI / 2);
      const butterflyBodyGeo = new THREE.CylinderGeometry(0.015, 0.022, 0.24, 5);
      butterflyBodyGeo.rotateX(Math.PI / 2);
      const butterflyBodyMat = new THREE.MeshPhongMaterial({ color: 0x4a3527 });
      const butterflyColors = [0xfff6e8, 0xffd166, 0xf5a0c1, 0x9ad7f0, 0xffa94d];
      const butterflies: { group: THREE.Group; left: THREE.Mesh; right: THREE.Mesh; base: THREE.Vector3; phase: number; speed: number }[] = [];
      for (let i = 0; i < 10; i++) {
        const color = butterflyColors[i % butterflyColors.length];
        const mat = new THREE.MeshPhongMaterial({ color, emissive: color, emissiveIntensity: 0.18, side: THREE.DoubleSide });
        const fly = new THREE.Group();
        const left = new THREE.Mesh(wingLeftGeo, mat);
        const right = new THREE.Mesh(wingRightGeo, mat);
        fly.add(left);
        fly.add(right);
        fly.add(new THREE.Mesh(butterflyBodyGeo, butterflyBodyMat));
        const base = new THREE.Vector3((rng() - 0.5) * 34, 1.8 + rng() * 2.6, (rng() - 0.5) * 26);
        fly.position.copy(base);
        group.add(fly);
        butterflies.push({ group: fly, left, right, base, phase: rng() * Math.PI * 2, speed: 0.22 + rng() * 0.18 });
      }

      // Drifting seeds/pollen: tiny bright motes low over the grass.
      const motes: { sprite: THREE.Sprite; base: THREE.Vector3; phase: number }[] = [];
      for (let i = 0; i < 16; i++) {
        const sprite = new THREE.Sprite(
          new THREE.SpriteMaterial({ map: glowTexture, color: 0xffffff, transparent: true, opacity: 0.4, depthWrite: false }),
        );
        const base = new THREE.Vector3((rng() - 0.5) * 30, 0.7 + rng() * 1.8, (rng() - 0.5) * 24);
        sprite.position.copy(base);
        sprite.scale.setScalar(0.14 + rng() * 0.1);
        group.add(sprite);
        motes.push({ sprite, base, phase: rng() * Math.PI * 2 });
      }

      return {
        update: (t) => {
          if (reducedMotion) {
            return;
          }
          for (const cloud of clouds) {
            const a = cloud.angle + t * cloud.speed;
            cloud.sprite.position.set(
              Math.cos(a) * cloud.dist,
              cloud.height + Math.sin(t * 0.12 + cloud.phase) * 0.8,
              Math.sin(a) * cloud.dist,
            );
          }
          for (const fly of butterflies) {
            fly.group.position.set(
              fly.base.x + Math.sin(t * fly.speed + fly.phase) * 2.6,
              fly.base.y + Math.sin(t * 0.9 + fly.phase * 2) * 0.5,
              fly.base.z + Math.cos(t * fly.speed * 0.85 + fly.phase) * 2.6,
            );
            // Face the direction of travel (velocity of the Lissajous above).
            const vx = Math.cos(t * fly.speed + fly.phase) * fly.speed;
            const vz = -Math.sin(t * fly.speed * 0.85 + fly.phase) * fly.speed * 0.85;
            fly.group.rotation.y = Math.atan2(vx, vz);
            // Bias toward raised wings so a frozen frame never reads as a
            // flat paper card lying on the meadow.
            const flap = 0.3 + Math.abs(Math.sin(t * 9 + fly.phase)) * 0.9;
            fly.left.rotation.z = flap;
            fly.right.rotation.z = -flap;
          }
          for (const mote of motes) {
            mote.sprite.position.set(
              mote.base.x + Math.sin(t * 0.22 + mote.phase) * 1.8,
              mote.base.y + Math.sin(t * 0.35 + mote.phase * 2) * 0.6,
              mote.base.z + Math.cos(t * 0.18 + mote.phase) * 1.8,
            );
            mote.sprite.material.opacity = 0.22 + Math.abs(Math.sin(t * 0.7 + mote.phase)) * 0.3;
          }
        },
        dispose: () => {
          scene.remove(group);
          scene.fog = null;
          groundTexture.dispose();
          cloudTextures.forEach((texture) => texture.dispose());
          group.traverse((node) => {
            if (node instanceof THREE.Mesh || node instanceof THREE.Points) {
              node.geometry.dispose();
              (Array.isArray(node.material) ? node.material : [node.material]).forEach((m) => m.dispose());
            }
            if (node instanceof THREE.Sprite) {
              node.material.dispose();
            }
          });
        },
      };
    };

    const buildOrbitEnv = (): SceneEnv => {
      const rng = mulberry32(0x4f524249);
      const group = new THREE.Group();
      scene.add(group);
      scene.fog = null;

      // Cool night rig (env-local; the garden runs warm daylight instead).
      group.add(new THREE.AmbientLight(0x9fb8cc, 0.55));
      const key = new THREE.DirectionalLight(0xdfeaff, 0.9);
      key.position.set(8, 14, 6);
      group.add(key);
      const fill = new THREE.DirectionalLight(0x3377ff, 0.3);
      fill.position.set(-8, 4, -6);
      group.add(fill);

      const sky = makeSkyDome(0x0a1a30, 0x0a2a38, 0x04060e);
      group.add(sky);

      const stars = makeStars(rng, 550, 0.45, 0.8, true);
      const brightStars = makeStars(rng, 90, 1.0, 0.95, true);
      group.add(stars);
      group.add(brightStars);

      // Nebula auroras: huge soft additive glows drifting slowly.
      const auroras: { sprite: THREE.Sprite; phase: number }[] = [];
      const auroraSpecs = [
        { color: 0x0fd6c0, x: -34, y: 18, z: -58, scale: 70, opacity: 0.16 },
        { color: 0x3450c8, x: 40, y: 26, z: -66, scale: 84, opacity: 0.13 },
        { color: 0x00bcd4, x: 6, y: -12, z: -72, scale: 60, opacity: 0.1 },
      ];
      for (const spec of auroraSpecs) {
        const sprite = new THREE.Sprite(
          new THREE.SpriteMaterial({ map: glowTexture, color: spec.color, transparent: true, opacity: spec.opacity, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }),
        );
        sprite.position.set(spec.x, spec.y, spec.z);
        sprite.scale.setScalar(spec.scale);
        group.add(sprite);
        auroras.push({ sprite, phase: rng() * Math.PI * 2 });
      }

      // A faint glass floor disc grounds the orbs without a meadow.
      const floor = new THREE.Mesh(
        new THREE.CircleGeometry(60, 64),
        new THREE.MeshBasicMaterial({ color: 0x07202c, transparent: true, opacity: 0.35 }),
      );
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = -0.6;
      group.add(floor);

      const starsMat = stars.material as THREE.PointsMaterial;
      return {
        update: (t) => {
          if (reducedMotion) {
            return;
          }
          starsMat.opacity = 0.68 + Math.sin(t * 0.5) * 0.14;
          auroras.forEach((aurora, i) => {
            aurora.sprite.position.x += Math.sin(t * 0.05 + aurora.phase) * 0.02;
            aurora.sprite.material.opacity =
              (i === 0 ? 0.16 : i === 1 ? 0.13 : 0.1) + Math.sin(t * 0.18 + aurora.phase) * 0.03;
          });
        },
        dispose: () => {
          scene.remove(group);
          group.traverse((node) => {
            if (node instanceof THREE.Mesh || node instanceof THREE.Points) {
              node.geometry.dispose();
              (Array.isArray(node.material) ? node.material : [node.material]).forEach((m) => m.dispose());
            }
            if (node instanceof THREE.Sprite) {
              node.material.dispose();
            }
          });
        },
      };
    };

    // ── shared geometries ───────────────────────────────────────────────────
    const GEO = {
      trunkBase: new THREE.CylinderGeometry(0.3, 0.45, 1.2, 8),
      trunkMid: new THREE.CylinderGeometry(0.22, 0.3, 1.2, 8),
      trunkTop: new THREE.CylinderGeometry(0.15, 0.22, 0.8, 8),
      foliageMain: new THREE.IcosahedronGeometry(1.3, 1),
      foliageTop: new THREE.IcosahedronGeometry(0.85, 1),
      foliageSide: new THREE.IcosahedronGeometry(0.7, 1),
      petal: new THREE.SphereGeometry(0.13, 8, 8),
      flowerCenter: new THREE.SphereGeometry(0.14, 10, 10),
      bud: new THREE.SphereGeometry(0.16, 10, 10),
      stem: new THREE.CylinderGeometry(0.03, 0.05, 1, 5),
      ring: new THREE.TorusGeometry(0.34, 0.015, 8, 48),
      orb: new THREE.SphereGeometry(1, 48, 48),
    };
    const trunkMat = new THREE.MeshPhongMaterial({ color: TRUNK_COLOR, emissive: TRUNK_COLOR, emissiveIntensity: 0.08 });
    const stemMat = new THREE.MeshPhongMaterial({ color: 0x1c6b4a, emissive: 0x1c6b4a, emissiveIntensity: 0.08 });

    const ideaEntries = new Map<string, Entry>();
    const treeEntries = new Map<string, Entry>();

    const disposeEntry = (entry: Entry) => {
      scene.remove(entry.group);
      entry.mats.forEach((mat) => mat.dispose());
      if (entry.label !== null) {
        entry.label.material.map?.dispose();
        entry.label.material.dispose();
      }
      entry.group.traverse((node) => {
        if (node instanceof THREE.Sprite && node !== entry.label) {
          node.material.dispose();
        }
      });
    };

    // ── garden builders ─────────────────────────────────────────────────────
    const buildFlower = (spec: IdeaOrbSpec): Entry => {
      const ready = spec.status === "ready";
      const color = ready ? MATURITY_COLOR[spec.maturity] : BUD_COLOR;
      const size = ready ? 0.9 + spec.confidence * 1.0 : 0.55 + spec.confidence * 0.45;
      const stemH = ready ? 1.0 + spec.confidence * 0.9 : 0.5 + spec.confidence * 0.3;
      const baseEmissive = ready ? 0.4 + spec.confidence * 0.3 : 0.12;
      const group = new THREE.Group();
      const mats: THREE.MeshPhongMaterial[] = [];

      const stem = new THREE.Mesh(GEO.stem, stemMat);
      stem.scale.set(size, stemH, size);
      stem.position.y = stemH / 2;
      group.add(stem);
      const head = new THREE.Group();
      head.position.y = stemH;
      group.add(head);

      if (ready) {
        const centerMat = new THREE.MeshPhongMaterial({ color: 0xffe08a, emissive: 0xffe08a, emissiveIntensity: 0.45 });
        mats.push(centerMat);
        const center = new THREE.Mesh(GEO.flowerCenter, centerMat);
        center.scale.setScalar(size);
        head.add(center);
        const petalMat = new THREE.MeshPhongMaterial({ color, emissive: color, emissiveIntensity: baseEmissive });
        mats.push(petalMat);
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2;
          const petal = new THREE.Mesh(GEO.petal, petalMat);
          petal.position.set(Math.cos(a) * 0.2 * size, 0, Math.sin(a) * 0.2 * size);
          petal.scale.set(size, 0.45 * size, 1.5 * size);
          petal.rotation.y = -a;
          head.add(petal);
        }
        if (spec.verified) {
          const ring = new THREE.Mesh(
            GEO.ring,
            new THREE.MeshBasicMaterial({ color: VERIFIED_COLOR, transparent: true, opacity: 0.55 }),
          );
          ring.scale.setScalar(size);
          ring.rotation.x = Math.PI * 0.45;
          head.add(ring);
        }
      } else {
        const budMat = new THREE.MeshPhongMaterial({ color, emissive: color, emissiveIntensity: baseEmissive, transparent: true, opacity: 0.6 });
        mats.push(budMat);
        const bud = new THREE.Mesh(GEO.bud, budMat);
        bud.scale.set(size, size * 1.3, size);
        head.add(bud);
      }

      const hit = new THREE.Mesh(
        new THREE.SphereGeometry(Math.max(0.5, 0.45 * size), 8, 8),
        new THREE.MeshBasicMaterial({ visible: false }),
      );
      hit.userData.pick = { kind: "idea", key: ideaKey(spec) };
      head.add(hit);

      let label: THREE.Sprite | null = null;
      if (ready && spec.pitch.length > 0) {
        const statusLine = `${Math.round(spec.confidence * 100)}% · ${spec.maturity}${spec.verified ? " ✓" : ""}`;
        label = makeLabelSprite(spec.pitch, statusLine, cssHex(color));
        label.position.y = stemH + 0.32 * size + 0.1;
        group.add(label);
      }
      return { kind: "flower", ideaSpec: spec, group, mats, baseEmissive, head, headY: stemH, label, targetPos: new THREE.Vector3(), targetScale: 1, scaleMult: 1, phase: 0, flashStart: null, removing: false };
    };

    const buildTree = (spec: TreeSpec): Entry => {
      const color = STATE_COLOR[spec.state];
      const commissioned = spec.stage === "commissioned";
      const group = new THREE.Group();
      const foliageMat = new THREE.MeshPhongMaterial({
        color,
        emissive: color,
        emissiveIntensity: spec.state === "halted" || spec.state === "blocked" ? 0.1 : 0.2,
      });
      if (!commissioned) {
        // CONCEPT = SAPLING: a short single-stem seedling with one modest
        // crown — reads as "young / not yet real" from projector distance.
        const stem = new THREE.Mesh(GEO.trunkBase, trunkMat);
        stem.scale.set(0.55, 0.85, 0.55);
        stem.position.y = 0.5;
        group.add(stem);
        const crown = new THREE.Mesh(GEO.foliageSide, foliageMat);
        crown.scale.setScalar(1.5);
        crown.position.y = 1.75;
        crown.userData.pick = { kind: "process", callsign: spec.callsign };
        group.add(crown);
        const sprout = new THREE.Mesh(GEO.foliageTop, foliageMat);
        sprout.scale.setScalar(0.55);
        sprout.position.y = 2.6;
        sprout.userData.pick = { kind: "process", callsign: spec.callsign };
        group.add(sprout);
      } else {
        // COMMISSIONED = the full-grown tree.
        const base = new THREE.Mesh(GEO.trunkBase, trunkMat);
        base.position.y = 0.6;
        group.add(base);
        const mid = new THREE.Mesh(GEO.trunkMid, trunkMat);
        mid.position.y = 1.8;
        group.add(mid);
        const top = new THREE.Mesh(GEO.trunkTop, trunkMat);
        top.position.y = 2.8;
        group.add(top);
        const main = new THREE.Mesh(GEO.foliageMain, foliageMat);
        main.position.y = 4.2;
        main.userData.pick = { kind: "process", callsign: spec.callsign };
        group.add(main);
        const tuft = new THREE.Mesh(GEO.foliageTop, foliageMat);
        tuft.position.y = 5.6;
        tuft.userData.pick = { kind: "process", callsign: spec.callsign };
        group.add(tuft);
        for (const offset of [
          { dx: 1, dy: 3.6, dz: 0.4 },
          { dx: -0.9, dy: 3.8, dz: 0.6 },
          { dx: 0.4, dy: 3.5, dz: -1 },
          { dx: -0.6, dy: 4, dz: -0.7 },
        ]) {
          const side = new THREE.Mesh(GEO.foliageSide, foliageMat);
          side.position.set(offset.dx, offset.dy, offset.dz);
          side.userData.pick = { kind: "process", callsign: spec.callsign };
          group.add(side);
        }
        // Gold commission ring: the ground halo that says "this one is real".
        const commissionRing = new THREE.Mesh(
          new THREE.TorusGeometry(2.4, 0.06, 8, 64),
          new THREE.MeshBasicMaterial({ color: COMMISSION_COLOR, transparent: true, opacity: 0.55 }),
        );
        commissionRing.rotation.x = Math.PI / 2;
        commissionRing.position.y = 0.06;
        group.add(commissionRing);
      }
      if (spec.steering) {
        // Steering target ring: a glowing ground halo around the tree so the
        // room sees where live transcript is routing.
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(2.1, 0.05, 8, 64),
          new THREE.MeshBasicMaterial({ color: STEERING_COLOR, transparent: true, opacity: 0.65 }),
        );
        ring.rotation.x = Math.PI / 2;
        ring.position.y = 0.08;
        group.add(ring);
      }
      const label = makeLabelSprite(treeTitle(spec), treeStatus(spec), cssHex(color));
      label.position.y = commissioned ? 6.6 : 3.4;
      group.add(label);
      return { kind: "tree", treeSpec: spec, group, mats: [foliageMat], baseEmissive: foliageMat.emissiveIntensity, head: null, headY: 0, label, targetPos: new THREE.Vector3(), targetScale: 1, scaleMult: 1, phase: 0, flashStart: null, removing: false };
    };

    // ── orbit builders ──────────────────────────────────────────────────────
    const buildOrbIdea = (spec: IdeaOrbSpec): Entry => {
      const ready = spec.status === "ready";
      const color = ready ? MATURITY_COLOR[spec.maturity] : BUD_COLOR;
      const radius = ready ? 0.8 + spec.confidence * 0.7 : 0.4 + spec.confidence * 0.3;
      const baseEmissive = ready ? 0.55 + spec.confidence * 0.5 : 0.16;
      const group = new THREE.Group();
      const orbMat = new THREE.MeshStandardMaterial({ roughness: 0.32, metalness: 0.12, transparent: true, opacity: ready ? 0.96 : 0.38 });
      orbMat.color.set(color).multiplyScalar(0.55);
      orbMat.emissive.set(color);
      orbMat.emissiveIntensity = baseEmissive;
      const orb = new THREE.Mesh(GEO.orb, orbMat);
      orb.scale.setScalar(radius);
      orb.userData.pick = { kind: "idea", key: ideaKey(spec) };
      group.add(orb);
      const halo = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: glowTexture, color, transparent: true, opacity: ready ? 0.5 : 0.16, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      halo.scale.setScalar(radius * 3.4);
      group.add(halo);
      if (ready && spec.verified) {
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(radius * 1.35, 0.02, 8, 64),
          new THREE.MeshBasicMaterial({ color: VERIFIED_COLOR, transparent: true, opacity: 0.5 }),
        );
        ring.rotation.x = Math.PI * 0.42;
        group.add(ring);
      }
      let label: THREE.Sprite | null = null;
      if (ready && spec.pitch.length > 0) {
        const statusLine = `${Math.round(spec.confidence * 100)}% · ${spec.maturity}${spec.verified ? " ✓" : ""}`;
        label = makeLabelSprite(spec.pitch, statusLine, cssHex(color));
        label.position.y = radius + 0.25;
        group.add(label);
      }
      return { kind: "orb-idea", ideaSpec: spec, group, mats: [orbMat], baseEmissive, head: null, headY: 0, label, targetPos: new THREE.Vector3(), targetScale: 1, scaleMult: 1, phase: 0, flashStart: null, removing: false };
    };

    const buildOrbProcess = (spec: TreeSpec): Entry => {
      const color = STATE_COLOR[spec.state];
      const radius = 1.15 + Math.min(Math.max(spec.progress, 0), 100) / 100 * 0.65;
      const group = new THREE.Group();
      const orbMat = new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0.15, transparent: true, opacity: 0.94 });
      orbMat.color.set(color).multiplyScalar(0.5);
      orbMat.emissive.set(color);
      orbMat.emissiveIntensity = 0.5;
      const orb = new THREE.Mesh(GEO.orb, orbMat);
      orb.scale.setScalar(radius);
      orb.userData.pick = { kind: "process", callsign: spec.callsign };
      group.add(orb);
      const halo = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: glowTexture, color, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      halo.scale.setScalar(radius * 3.2);
      group.add(halo);
      if (spec.stage === "commissioned") {
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(radius * 1.7, 0.04, 8, 64),
          new THREE.MeshBasicMaterial({ color: COMMISSION_COLOR, transparent: true, opacity: 0.55 }),
        );
        ring.rotation.x = Math.PI * 0.42;
        group.add(ring);
      }
      if (spec.steering) {
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(radius * 1.5, 0.03, 8, 64),
          new THREE.MeshBasicMaterial({ color: STEERING_COLOR, transparent: true, opacity: 0.6 }),
        );
        ring.rotation.x = Math.PI * 0.42;
        group.add(ring);
      }
      const label = makeLabelSprite(treeTitle(spec), treeStatus(spec), cssHex(color));
      label.position.y = radius + 0.25;
      group.add(label);
      return { kind: "orb-proc", treeSpec: spec, group, mats: [orbMat], baseEmissive: 0.5, head: null, headY: 0, label, targetPos: new THREE.Vector3(), targetScale: 1, scaleMult: 1, phase: 0, flashStart: null, removing: false };
    };

    // ── layout ──────────────────────────────────────────────────────────────
    // Compact garden-styled nodes for the hyperbolic layouts (after the
    // visualizer's createH3GardenNode): a foliage cluster with a crowning
    // bloom for builds, a stemless 5-petal flower (or bud) for ideas.
    const buildFloraProcess = (spec: TreeSpec): Entry => {
      const color = STATE_COLOR[spec.state];
      const group = new THREE.Group();
      const folMat = new THREE.MeshPhongMaterial({ color, emissive: color, emissiveIntensity: 0.22 });
      const fol = new THREE.Mesh(GEO.foliageSide, folMat);
      fol.scale.setScalar(1.15);
      fol.userData.pick = { kind: "process", callsign: spec.callsign };
      group.add(fol);
      const bloom = new THREE.Mesh(
        GEO.flowerCenter,
        new THREE.MeshPhongMaterial({ color: 0xffe08a, emissive: 0xffe08a, emissiveIntensity: 0.4 }),
      );
      bloom.position.y = 0.95;
      // A commissioned build's crowning bloom is visibly larger + brighter.
      bloom.scale.setScalar(spec.stage === "commissioned" ? 2.1 : 1.5);
      bloom.userData.pick = { kind: "process", callsign: spec.callsign };
      group.add(bloom);
      if (spec.stage === "commissioned") {
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(1.7, 0.04, 8, 64),
          new THREE.MeshBasicMaterial({ color: COMMISSION_COLOR, transparent: true, opacity: 0.55 }),
        );
        ring.rotation.x = Math.PI * 0.42;
        group.add(ring);
      }
      if (spec.steering) {
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(1.5, 0.03, 8, 64),
          new THREE.MeshBasicMaterial({ color: STEERING_COLOR, transparent: true, opacity: 0.6 }),
        );
        ring.rotation.x = Math.PI * 0.42;
        group.add(ring);
      }
      const label = makeLabelSprite(treeTitle(spec), treeStatus(spec), cssHex(color));
      label.position.y = 1.35;
      group.add(label);
      return { kind: "tree", treeSpec: spec, group, mats: [folMat], baseEmissive: 0.22, head: null, headY: 0, label, targetPos: new THREE.Vector3(), targetScale: 1, scaleMult: 1, phase: 0, flashStart: null, removing: false };
    };

    const buildFloraIdea = (spec: IdeaOrbSpec): Entry => {
      const ready = spec.status === "ready";
      const color = ready ? MATURITY_COLOR[spec.maturity] : BUD_COLOR;
      const size = ready ? 0.95 + spec.confidence * 0.8 : 0.55 + spec.confidence * 0.4;
      const baseEmissive = ready ? 0.4 + spec.confidence * 0.3 : 0.12;
      const group = new THREE.Group();
      const head = new THREE.Group();
      group.add(head);
      const mats: THREE.MeshPhongMaterial[] = [];
      if (ready) {
        const centerMat = new THREE.MeshPhongMaterial({ color: 0xffe08a, emissive: 0xffe08a, emissiveIntensity: 0.45 });
        mats.push(centerMat);
        const center = new THREE.Mesh(GEO.flowerCenter, centerMat);
        center.scale.setScalar(size);
        head.add(center);
        const petalMat = new THREE.MeshPhongMaterial({ color, emissive: color, emissiveIntensity: baseEmissive });
        mats.push(petalMat);
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2;
          const petal = new THREE.Mesh(GEO.petal, petalMat);
          petal.position.set(Math.cos(a) * 0.2 * size, 0, Math.sin(a) * 0.2 * size);
          petal.scale.set(size, 0.45 * size, 1.5 * size);
          petal.rotation.y = -a;
          head.add(petal);
        }
        if (spec.verified) {
          const ring = new THREE.Mesh(
            GEO.ring,
            new THREE.MeshBasicMaterial({ color: VERIFIED_COLOR, transparent: true, opacity: 0.55 }),
          );
          ring.scale.setScalar(size);
          ring.rotation.x = Math.PI * 0.45;
          head.add(ring);
        }
      } else {
        const budMat = new THREE.MeshPhongMaterial({ color, emissive: color, emissiveIntensity: baseEmissive, transparent: true, opacity: 0.6 });
        mats.push(budMat);
        const bud = new THREE.Mesh(GEO.bud, budMat);
        bud.scale.set(size, size * 1.3, size);
        head.add(bud);
      }
      const hit = new THREE.Mesh(
        new THREE.SphereGeometry(Math.max(0.55, 0.5 * size), 8, 8),
        new THREE.MeshBasicMaterial({ visible: false }),
      );
      hit.userData.pick = { kind: "idea", key: ideaKey(spec) };
      head.add(hit);
      let label: THREE.Sprite | null = null;
      if (ready && spec.pitch.length > 0) {
        const statusLine = `${Math.round(spec.confidence * 100)}% · ${spec.maturity}${spec.verified ? " ✓" : ""}`;
        label = makeLabelSprite(spec.pitch, statusLine, cssHex(color));
        label.position.y = 0.42 * size + 0.15;
        group.add(label);
      }
      return { kind: "flower", ideaSpec: spec, group, mats, baseEmissive, head, headY: 0, label, targetPos: new THREE.Vector3(), targetScale: 1, scaleMult: 1, phase: 0, flashStart: null, removing: false };
    };

    // Boundary/context cues per layout: the Poincaré ball's wireframe horizon,
    // or the disk's rim + inner context circles.
    let layoutDecor: THREE.Object3D[] = [];
    const clearLayoutDecor = () => {
      for (const obj of layoutDecor) {
        scene.remove(obj);
        obj.traverse((node) => {
          if (node instanceof THREE.Mesh) {
            node.geometry.dispose();
            (Array.isArray(node.material) ? node.material : [node.material]).forEach((m) => m.dispose());
          }
        });
      }
      layoutDecor = [];
    };
    const diskY = () => (modeRef.current === "garden" ? 0.05 : 2.6);
    const buildLayoutDecor = () => {
      clearLayoutDecor();
      if (layoutRef.current === "ball") {
        const boundary = new THREE.Mesh(
          new THREE.SphereGeometry(BALL_RADIUS, 24, 16),
          new THREE.MeshBasicMaterial({ color: 0x335577, wireframe: true, transparent: true, opacity: 0.08 }),
        );
        boundary.position.set(0, BALL_CENTER_Y, 0);
        scene.add(boundary);
        layoutDecor.push(boundary);
      } else if (layoutRef.current === "disk") {
        const y = diskY();
        const rim = new THREE.Mesh(
          new THREE.TorusGeometry(DISK_RADIUS, 0.025, 8, 96),
          new THREE.MeshBasicMaterial({ color: 0x4d7ba6, transparent: true, opacity: 0.4 }),
        );
        rim.rotation.x = Math.PI / 2;
        rim.position.y = y;
        scene.add(rim);
        layoutDecor.push(rim);
        for (const rNorm of [DISK_R_PROC, DISK_R_READY]) {
          const circle = new THREE.Mesh(
            new THREE.TorusGeometry(DISK_RADIUS * rNorm, 0.012, 6, 72),
            new THREE.MeshBasicMaterial({ color: 0x4d7ba6, transparent: true, opacity: 0.12 }),
          );
          circle.rotation.x = Math.PI / 2;
          circle.position.y = y;
          scene.add(circle);
          layoutDecor.push(circle);
        }
      }
    };

    const centeredSlot = (index: number): number => {
      const ring = (index + 1) >> 1;
      return index % 2 === 1 ? -ring : ring;
    };
    const treePosition = (index: number, count: number, garden: boolean): { pos: THREE.Vector3; k: number } => {
      if (layoutRef.current === "ball") {
        const dir = fibSphereDir(index, count);
        return {
          pos: dir.clone().multiplyScalar(BALL_SHELL_PROC * BALL_RADIUS).add(new THREE.Vector3(0, BALL_CENTER_Y, 0)),
          k: poincareScale(BALL_SHELL_PROC),
        };
      }
      if (layoutRef.current === "disk") {
        const angle = (index / Math.max(count, 1)) * Math.PI * 2 - Math.PI / 2;
        const r = DISK_R_PROC * DISK_RADIUS;
        return { pos: new THREE.Vector3(Math.cos(angle) * r, diskY(), Math.sin(angle) * r), k: poincareScale(DISK_R_PROC) };
      }
      const slot = centeredSlot(index);
      const y = garden ? 0 : 3.1 + (Math.abs(slot) % 2) * 0.9;
      return { pos: new THREE.Vector3(slot * 4.6, y, -3.2 - (Math.abs(slot) % 2) * 1.6), k: 1 };
    };
    const flowerPosition = (
      index: number,
      count: number,
      ready: boolean,
      garden: boolean,
    ): { pos: THREE.Vector3; k: number } => {
      if (layoutRef.current === "ball") {
        const shell = ready ? BALL_SHELL_READY : BALL_SHELL_FORMING;
        // Rotate the idea shell off the process shell so nodes never eclipse.
        const dir = fibSphereDir(index, count).applyAxisAngle(new THREE.Vector3(0, 1, 0), 1.1);
        return {
          pos: dir.multiplyScalar(shell * BALL_RADIUS).add(new THREE.Vector3(0, BALL_CENTER_Y, 0)),
          k: poincareScale(shell),
        };
      }
      if (layoutRef.current === "disk") {
        const rNorm = ready ? DISK_R_READY : DISK_R_FORMING;
        const angle = index * GOLDEN_ANGLE + 0.7;
        const r = rNorm * DISK_RADIUS;
        return { pos: new THREE.Vector3(Math.cos(angle) * r, diskY(), Math.sin(angle) * r), k: poincareScale(rNorm) };
      }
      const slot = centeredSlot(index);
      const z = 3.6 + (Math.abs(slot) % 2) * 1.2;
      const y = garden ? 0 : 1.3 + (Math.abs(slot) % 2) * 0.8;
      return { pos: new THREE.Vector3(slot * 2.9, y, z), k: 1 };
    };

    const ideaSpecChanged = (a: IdeaOrbSpec, b: IdeaOrbSpec) =>
      a.status !== b.status || a.maturity !== b.maturity || a.verified !== b.verified ||
      a.pitch !== b.pitch || Math.abs(a.confidence - b.confidence) > 0.005;
    const treeSpecChanged = (a: TreeSpec, b: TreeSpec) =>
      a.state !== b.state || a.callsign !== b.callsign || a.task !== b.task ||
      a.steering !== b.steering || a.stage !== b.stage ||
      Math.round(a.progress) !== Math.round(b.progress);

    let env: SceneEnv | null = null;
    let builtMode: SceneMode | null = null;
    let builtKey: string | null = null;

    const reconcile = () => {
      const garden = modeRef.current === "garden";
      const hyper = layoutRef.current !== "radial";
      const key = `${modeRef.current}|${layoutRef.current}`;
      if (builtKey !== key) {
        // Style/layout switch: tear the world down and regrow it.
        env?.dispose();
        env = garden ? buildGardenEnv() : buildOrbitEnv();
        for (const entry of ideaEntries.values()) {
          disposeEntry(entry);
        }
        ideaEntries.clear();
        for (const entry of treeEntries.values()) {
          disposeEntry(entry);
        }
        treeEntries.clear();
        buildLayoutDecor();
        builtMode = modeRef.current;
        builtKey = key;
        resetRig();
      }

      // PER-WALL CONTRACT: the 3D scene reconciles the FULL data set — all
      // ideas AND all builds — on every window regardless of ?view=. Walls
      // differ by camera vantage (wallYawSeed), never by scene content; only
      // the 2D HUD surfaces are view-scoped (see App.tsx).
      const ideaSpecs: IdeaOrbSpec[] =
        ideasRef.current.length > 0
          ? ideasRef.current
          : [{ id: "__idle__", pitch: "", confidence: 0.25, status: "forming", maturity: "forming", verified: false }];
      const treeSpecs = treesRef.current;

      const seenIdeas = new Set<string>();
      ideaSpecs.forEach((spec, index) => {
        const specId = ideaKey(spec);
        seenIdeas.add(specId);
        const existing = ideaEntries.get(specId);
        const placed = flowerPosition(index, ideaSpecs.length, spec.status === "ready", garden);
        const labelLift = hyper ? 0 : (Math.abs(centeredSlot(index)) % 2) * 0.55;
        const create = () => {
          const entry = hyper
            ? garden
              ? buildFloraIdea(spec)
              : buildOrbIdea(spec)
            : garden
              ? buildFlower(spec)
              : buildOrbIdea(spec);
          entry.label?.position.setY(entry.label.position.y + labelLift);
          entry.targetPos = placed.pos;
          entry.scaleMult = placed.k;
          entry.phase = index * 1.9;
          entry.group.position.copy(placed.pos);
          entry.group.scale.setScalar(0.01);
          ideaEntries.set(specId, entry);
          scene.add(entry.group);
          return entry;
        };
        if (existing === undefined) {
          const entry = create();
          if (spec.status === "ready") {
            entry.flashStart = performance.now();
          }
        } else if (existing.ideaSpec !== undefined && ideaSpecChanged(existing.ideaSpec, spec)) {
          const promoted = existing.ideaSpec.status === "forming" && spec.status === "ready";
          const nowVerified = !existing.ideaSpec.verified && spec.verified;
          const keepPos = existing.group.position.clone();
          const keepScale = existing.group.scale.x;
          const keepPhase = existing.phase;
          disposeEntry(existing);
          const entry = create();
          entry.phase = keepPhase;
          entry.group.position.copy(keepPos);
          entry.group.scale.setScalar(Math.max(keepScale, 0.01));
          if (promoted || nowVerified) {
            entry.flashStart = performance.now();
          }
        } else {
          existing.targetPos = placed.pos;
          existing.scaleMult = placed.k;
          existing.removing = false;
          existing.targetScale = 1;
        }
      });
      for (const [specId, entry] of ideaEntries) {
        if (!seenIdeas.has(specId)) {
          entry.removing = true;
          entry.targetScale = 0;
        }
      }

      const seenTrees = new Set<string>();
      treeSpecs.forEach((spec, index) => {
        seenTrees.add(spec.upid);
        const existing = treeEntries.get(spec.upid);
        const placed = treePosition(index, treeSpecs.length, garden);
        const scale = !hyper && garden ? 0.62 + Math.min(Math.max(spec.progress, 0), 100) / 100 * 0.33 : 1;
        const create = () => {
          const entry = hyper
            ? garden
              ? buildFloraProcess(spec)
              : buildOrbProcess(spec)
            : garden
              ? buildTree(spec)
              : buildOrbProcess(spec);
          entry.targetPos = placed.pos;
          entry.targetScale = scale;
          entry.scaleMult = placed.k;
          entry.phase = index * 1.3;
          entry.group.position.copy(placed.pos);
          entry.group.scale.setScalar(0.01);
          treeEntries.set(spec.upid, entry);
          scene.add(entry.group);
          return entry;
        };
        if (existing === undefined) {
          create();
        } else if (existing.treeSpec !== undefined && treeSpecChanged(existing.treeSpec, spec)) {
          // Concept → commissioned is THE transformation moment: flash the
          // regrown (now full-size) tree so the room sees it happen.
          const promoted = existing.treeSpec.stage !== "commissioned" && spec.stage === "commissioned";
          const keepPos = existing.group.position.clone();
          const keepScale = existing.group.scale.x;
          const keepPhase = existing.phase;
          disposeEntry(existing);
          const entry = create();
          entry.phase = keepPhase;
          entry.group.position.copy(keepPos);
          entry.group.scale.setScalar(Math.max(keepScale, 0.01));
          if (promoted) {
            entry.flashStart = performance.now();
          }
        } else {
          existing.targetPos = placed.pos;
          existing.targetScale = scale;
          existing.scaleMult = placed.k;
          existing.removing = false;
        }
      });
      for (const [specId, entry] of treeEntries) {
        if (!seenTrees.has(specId)) {
          entry.removing = true;
          entry.targetScale = 0;
        }
      }
    };

    // ── fit to content (visualizer's fitToScreen, adapted to the orbit rig) ─
    const fitToContent = () => {
      const box = new THREE.Box3();
      let hasContent = false;
      const include = (entries: Map<string, Entry>) => {
        for (const entry of entries.values()) {
          if (!entry.removing) {
            box.expandByPoint(entry.targetPos);
            hasContent = true;
          }
        }
      };
      include(ideaEntries);
      include(treeEntries);
      if (!hasContent) {
        resetRig();
        return;
      }
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const spread = Math.max(size.x, size.z, 6);
      rig.dTargetX = center.x;
      rig.dTargetZ = center.z;
      rig.dRadius = Math.min(40, spread * 0.85 + 7);
      rig.dHeight = Math.min(26, rig.dRadius * 0.34 + 2);
    };

    // ── pointer: orbit / pan / zoom / click-with-drag-suppression ───────────
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let hoveredIdea: string | null = null;
    let hoveredProc: string | null = null;
    let dragging = false;
    let panning = false;
    let dragMoved = 0;
    let lastX = 0;
    let lastY = 0;
    // Flick inertia: velocities sampled during the drag keep the camera
    // gliding after release, decaying exponentially.
    let angVel = 0;
    let heightVel = 0;
    let lastMoveAt = 0;
    // True while the pinch-camera layer holds a live grab: the rig tracks
    // tightly (like a mouse drag) and flick inertia stays out of the way.
    let externalGrab = false;

    const pick = (clientX: number, clientY: number): { kind: string; key?: string; callsign?: string } | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        return null;
      }
      pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const targets: THREE.Object3D[] = [];
      for (const entry of ideaEntries.values()) {
        if (!entry.removing) {
          targets.push(entry.group);
        }
      }
      for (const entry of treeEntries.values()) {
        if (!entry.removing) {
          targets.push(entry.group);
        }
      }
      for (const hit of raycaster.intersectObjects(targets, true)) {
        let node: THREE.Object3D | null = hit.object;
        while (node !== null) {
          if (node.userData.pick !== undefined) {
            return node.userData.pick as { kind: string; key?: string; callsign?: string };
          }
          node = node.parent;
        }
      }
      return null;
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) {
        return;
      }
      dragging = true;
      panning = event.shiftKey;
      dragMoved = 0;
      lastX = event.clientX;
      lastY = event.clientY;
      angVel = 0;
      heightVel = 0;
      lastMoveAt = performance.now();
      // Keep the drag alive even when the pointer crosses a floating panel.
      renderer.domElement.setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (dragging) {
        const dx = event.clientX - lastX;
        const dy = event.clientY - lastY;
        dragMoved += Math.abs(dx) + Math.abs(dy);
        lastX = event.clientX;
        lastY = event.clientY;
        const nowMs = performance.now();
        const dtMove = Math.max((nowMs - lastMoveAt) / 1000, 0.001);
        lastMoveAt = nowMs;
        if (panning || event.shiftKey) {
          panning = true;
          const panSpeed = 0.0045 * rig.radius;
          rig.dTargetX -= Math.cos(rig.angle) * dx * panSpeed;
          rig.dTargetZ += Math.sin(rig.angle) * dx * panSpeed;
          rig.dTargetX -= Math.sin(rig.angle) * dy * panSpeed;
          rig.dTargetZ -= Math.cos(rig.angle) * dy * panSpeed;
        } else {
          const dAngle = -dx * 0.005;
          const dHeight = dy * 0.045;
          rig.dAngle += dAngle;
          rig.dHeight = Math.max(1.4, Math.min(30, rig.dHeight + dHeight));
          // Exponential moving average keeps the flick velocity stable.
          angVel = angVel * 0.75 + (dAngle / dtMove) * 0.25;
          heightVel = heightVel * 0.75 + (dHeight / dtMove) * 0.25;
        }
        return;
      }
      const picked = pick(event.clientX, event.clientY);
      hoveredIdea = null;
      hoveredProc = null;
      if (picked?.kind === "idea" && picked.key !== undefined && picked.key !== "__idle__") {
        const entry = ideaEntries.get(picked.key);
        if (entry?.ideaSpec?.status === "ready") {
          hoveredIdea = picked.key;
        }
      } else if (picked?.kind === "process" && picked.callsign !== undefined) {
        hoveredProc = picked.callsign;
      }
      renderer.domElement.style.cursor =
        hoveredIdea !== null || hoveredProc !== null ? "pointer" : dragging ? "grabbing" : "grab";
    };
    const onPointerUp = (event: PointerEvent) => {
      const wasDrag = dragMoved > 6;
      dragging = false;
      panning = false;
      if (wasDrag || event.button !== 0) {
        return;
      }
      const picked = pick(event.clientX, event.clientY);
      if (picked?.kind === "idea" && picked.key !== undefined && picked.key !== "__idle__") {
        const entry = ideaEntries.get(picked.key);
        if (entry?.ideaSpec?.status === "ready") {
          onAcceptRef.current(entry.ideaSpec.id);
        }
      } else if (picked?.kind === "process" && picked.callsign !== undefined) {
        onSelectRef.current(picked.callsign);
      }
    };
    const onPointerLeave = () => {
      dragging = false;
      panning = false;
      hoveredIdea = null;
      hoveredProc = null;
      renderer.domElement.style.cursor = "grab";
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      rig.dRadius = Math.max(4, Math.min(45, rig.dRadius + event.deltaY * 0.02));
    };
    // GESTURE-DWELL SEAM: expose real raycast picking + projected node rects +
    // click-equivalent activation to the gesture layer, so pointing a hand at a
    // node highlights it and a completed dwell fires the exact click semantics
    // (ready idea → build, process → steer/deck) — without any pointer events.
    const SCENE_IDEA_PREFIX = "scene:idea:";
    const SCENE_PROC_PREFIX = "scene:proc:";
    let dwellHighlights: ReadonlySet<string> = new Set();
    const sceneTargetIdOf = (picked: { kind: string; key?: string; callsign?: string } | null): string | null => {
      if (picked?.kind === "idea" && picked.key !== undefined && picked.key !== "__idle__") {
        const entry = ideaEntries.get(picked.key);
        if (entry?.ideaSpec?.status === "ready" && !entry.removing) {
          return `${SCENE_IDEA_PREFIX}${picked.key}`;
        }
      } else if (picked?.kind === "process" && picked.callsign !== undefined) {
        return `${SCENE_PROC_PREFIX}${picked.callsign}`;
      }
      return null;
    };
    const entryForTargetId = (id: string): Entry | null => {
      if (id.startsWith(SCENE_IDEA_PREFIX)) {
        return ideaEntries.get(id.slice(SCENE_IDEA_PREFIX.length)) ?? null;
      }
      if (id.startsWith(SCENE_PROC_PREFIX)) {
        const callsign = id.slice(SCENE_PROC_PREFIX.length);
        for (const entry of treeEntries.values()) {
          if (entry.treeSpec?.callsign === callsign) {
            return entry;
          }
        }
      }
      return null;
    };
    const dwellBox = new THREE.Box3();
    const dwellCorner = new THREE.Vector3();
    const dwellRectFor = (id: string): SceneDwellRect | null => {
      const entry = entryForTargetId(id);
      if (entry === null || entry.removing) {
        return null;
      }
      const domRect = renderer.domElement.getBoundingClientRect();
      if (domRect.width === 0 || domRect.height === 0) {
        return null;
      }
      dwellBox.setFromObject(entry.group);
      if (dwellBox.isEmpty()) {
        return null;
      }
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < 8; i += 1) {
        dwellCorner.set(
          (i & 1) === 0 ? dwellBox.min.x : dwellBox.max.x,
          (i & 2) === 0 ? dwellBox.min.y : dwellBox.max.y,
          (i & 4) === 0 ? dwellBox.min.z : dwellBox.max.z,
        );
        dwellCorner.project(camera);
        if (dwellCorner.z > 1) {
          continue; // behind the camera
        }
        const sx = domRect.left + ((dwellCorner.x + 1) / 2) * domRect.width;
        const sy = domRect.top + ((1 - dwellCorner.y) / 2) * domRect.height;
        minX = Math.min(minX, sx);
        minY = Math.min(minY, sy);
        maxX = Math.max(maxX, sx);
        maxY = Math.max(maxY, sy);
      }
      if (!Number.isFinite(minX) || maxX <= minX || maxY <= minY) {
        return null;
      }
      return { left: minX, top: minY, width: maxX - minX, height: maxY - minY };
    };
    const unregisterDwellSource = registerSceneDwellSource({
      pick: (clientX, clientY) => sceneTargetIdOf(pick(clientX, clientY)),
      rectFor: dwellRectFor,
      activate: (id) => {
        const entry = entryForTargetId(id);
        if (entry === null || entry.removing) {
          return;
        }
        if (id.startsWith(SCENE_IDEA_PREFIX) && entry.ideaSpec !== undefined && entry.ideaSpec.status === "ready") {
          onAcceptRef.current(entry.ideaSpec.id);
        } else if (id.startsWith(SCENE_PROC_PREFIX) && entry.treeSpec !== undefined) {
          onSelectRef.current(entry.treeSpec.callsign);
        }
      },
      setHighlights: (ids) => {
        dwellHighlights = ids;
      },
    });
    // PINCH-CAMERA SEAM: the hand-pinch layer drives the SAME desired-rig d*
    // fields as the mouse, so writers interleave latest-writer-wins (fit /
    // focus / resetRig may also write d*; external input keeps writing and
    // wins). The scene owns the rig and ALL clamps — the layer never touches
    // three.js and cannot push the rig outside the mouse's envelope.
    const unregisterCameraControl = registerSceneCameraControl({
      orbitBy: (dYaw, dHeight) => {
        // Exact mirror of the onPointerMove orbit path (incl. height clamp).
        rig.dAngle += dYaw;
        rig.dHeight = Math.max(1.4, Math.min(30, rig.dHeight + dHeight));
      },
      panBy: (dxPx, dyPx) => {
        // Exact mirror of the onPointerMove shift-pan path.
        const panSpeed = 0.0045 * rig.radius;
        rig.dTargetX -= Math.cos(rig.angle) * dxPx * panSpeed;
        rig.dTargetZ += Math.sin(rig.angle) * dxPx * panSpeed;
        rig.dTargetX -= Math.sin(rig.angle) * dyPx * panSpeed;
        rig.dTargetZ -= Math.cos(rig.angle) * dyPx * panSpeed;
      },
      zoomBy: (scale) => {
        if (!Number.isFinite(scale) || scale <= 0) {
          return; // defensive: a bad ratio must never NaN the rig
        }
        // Multiplicative dolly, re-clamped to the onWheel envelope [4,45].
        rig.dRadius = Math.max(4, Math.min(45, rig.dRadius * scale));
      },
      // Params deliberately NOT named angVel/heightVel — they must not shadow
      // the inertia vars this feeds.
      flick: (yawVel, hVel) => {
        // Defensive re-clamp (the interpreter caps too): a rogue velocity must
        // never launch the camera.
        angVel = Math.max(-4, Math.min(4, yawVel));
        heightVel = Math.max(-30, Math.min(30, hVel));
      },
      setTracking: (on) => {
        externalGrab = on;
        if (on) {
          // Same takeover onPointerDown does: a fresh grab kills residual coast.
          angVel = 0;
          heightVel = 0;
        }
      },
    });

    // Pure gesture mode: pointing must not fight drag-orbit, so the pointer
    // never binds at all (see Help overlay). Desk/mouse-dwell modes keep the
    // full drag-orbit / pan / zoom / click surface.
    if (pointerNavRef.current) {
      renderer.domElement.style.cursor = "grab";
      renderer.domElement.addEventListener("pointerdown", onPointerDown);
      renderer.domElement.addEventListener("pointermove", onPointerMove);
      renderer.domElement.addEventListener("pointerup", onPointerUp);
      renderer.domElement.addEventListener("pointerleave", onPointerLeave);
      renderer.domElement.addEventListener("wheel", onWheel, { passive: false });
    }

    const resize = () => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (width === 0 || height === 0) {
        return;
      }
      renderer.setSize(width, height);
      camera.aspect = width / height;
      if (cornerLocked) {
        // camera.fov is VERTICAL in three.js: recompute it from the aspect so
        // the HORIZONTAL fov stays pinned at exactly 90° and the wall pair
        // keeps tiling the corner seamlessly at any window size.
        camera.fov = cornerVerticalFovDeg(camera.aspect);
      }
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();

    reconcile();
    let lastTick = tick.current;
    let lastFit = fitRef.current;
    // The focus upid whose camera move has already been applied. A pending
    // focus retries each frame until the node exists (fresh spawns land a beat
    // after the snapshot), then applies exactly once.
    let appliedFocus: string | null = null;

    const clock = new THREE.Clock();
    let rafId = 0;
    let running = false;
    const frame = () => {
      if (!running) {
        return;
      }
      rafId = requestAnimationFrame(frame);
      const dt = Math.min(clock.getDelta(), 0.1);
      const t = clock.elapsedTime;
      const now = performance.now();
      if (tick.current !== lastTick) {
        lastTick = tick.current;
        reconcile();
      }
      if (fitRef.current !== lastFit) {
        lastFit = fitRef.current;
        if (!cornerLocked) {
          fitToContent(); // corner lock: F is a camera no-op — the pair may not move
        }
      }
      // Guided-demo focus: glide the rig to the requested process node
      // (disabled under corner lock — the rigid pair never reframes).
      const wantFocus = cornerLocked ? null : focusRef.current;
      if (wantFocus !== appliedFocus) {
        if (wantFocus === null) {
          appliedFocus = null;
        } else {
          const focusEntry = treeEntries.get(wantFocus);
          if (focusEntry !== undefined && !focusEntry.removing) {
            rig.dTargetX = focusEntry.targetPos.x;
            rig.dTargetZ = focusEntry.targetPos.z;
            rig.dRadius = Math.max(7, Math.min(rig.dRadius, 11));
            appliedFocus = wantFocus;
          }
        }
      }
      const smoothing = 1 - Math.exp(-dt * 7);
      if (cornerLocked) {
        // Rigid corner pair: reassert the locked framing every frame so no
        // stray camera write can ever drift the seam between the walls. The
        // pinch-camera external grab is a no-op here (like F/focus) — the pair
        // never moves.
        applyCornerRig();
      } else {
        // Track the hand tightly while dragging OR while the pinch camera holds
        // an external grab; glide softly once released.
        const camSmoothing = 1 - Math.exp(-dt * (dragging || externalGrab ? 16 : 6));

        // Flick inertia: after release the last drag velocity keeps the orbit
        // drifting, decaying exponentially (~0.4s half-life). A live external
        // grab (pinch camera) suppresses inertia exactly like a mouse drag.
        if (!dragging && !externalGrab && !reducedMotion) {
          if (Math.abs(angVel) > 1e-4) {
            rig.dAngle += angVel * dt;
            angVel *= Math.exp(-dt * 2.2);
          }
          if (Math.abs(heightVel) > 1e-3) {
            rig.dHeight = Math.max(1.4, Math.min(30, rig.dHeight + heightVel * dt));
            heightVel *= Math.exp(-dt * 2.6);
          }
        }

        rig.angle = THREE.MathUtils.lerp(rig.angle, rig.dAngle, camSmoothing);
        rig.radius = THREE.MathUtils.lerp(rig.radius, rig.dRadius, camSmoothing);
        rig.height = THREE.MathUtils.lerp(rig.height, rig.dHeight, camSmoothing);
        rig.targetX = THREE.MathUtils.lerp(rig.targetX, rig.dTargetX, camSmoothing);
        rig.targetZ = THREE.MathUtils.lerp(rig.targetZ, rig.dTargetZ, camSmoothing);
        applyRig();
      }

      env?.update(t);

      const garden = builtMode === "garden";
      const radial = builtKey !== null && builtKey.endsWith("radial");
      for (const [specId, entry] of ideaEntries) {
        entry.group.position.lerp(entry.targetPos, smoothing);
        // Mouse hover and gesture-dwell targeting share the same grow/glow.
        const hovered = hoveredIdea === specId || dwellHighlights.has(`${SCENE_IDEA_PREFIX}${specId}`);
        const target = entry.targetScale * entry.scaleMult * (hovered ? 1.12 : 1);
        const next = THREE.MathUtils.lerp(entry.group.scale.x, target, smoothing);
        entry.group.scale.setScalar(Math.max(next, 0.0001));
        if (entry.removing && entry.group.scale.x < 0.02) {
          disposeEntry(entry);
          ideaEntries.delete(specId);
          continue;
        }
        if (!reducedMotion && radial) {
          if (garden) {
            entry.group.rotation.z = Math.sin(t * 0.6 + entry.phase) * 0.04;
            if (entry.head !== null) {
              entry.head.position.y = entry.headY + Math.sin(t * 0.9 + entry.phase) * 0.05;
            }
          } else {
            entry.group.position.y = entry.targetPos.y + Math.sin(t * 0.7 + entry.phase) * 0.22;
          }
        }
        let boost = hovered ? 0.3 : 0;
        if (entry.flashStart !== null && !reducedMotion) {
          const progress = (now - entry.flashStart) / FLASH_MS;
          if (progress >= 1) {
            entry.flashStart = null;
            entry.mats.forEach((mat) => mat.emissive.copy(mat.color));
          } else {
            const pulse = Math.abs(Math.sin(progress * Math.PI * 3)) * (1 - progress);
            boost += pulse * 1.8;
            entry.mats.forEach((mat) => mat.emissive.copy(mat.color).lerp(new THREE.Color(0xffffff), pulse * 0.8));
          }
        }
        entry.mats.forEach((mat) => {
          mat.emissiveIntensity = entry.baseEmissive + boost;
        });
      }

      for (const [specId, entry] of treeEntries) {
        entry.group.position.lerp(entry.targetPos, smoothing);
        const hovered =
          hoveredProc === entry.treeSpec?.callsign ||
          (entry.treeSpec !== undefined && dwellHighlights.has(`${SCENE_PROC_PREFIX}${entry.treeSpec.callsign}`));
        const target = entry.targetScale * entry.scaleMult * (hovered ? (garden ? 1.06 : 1.12) : 1);
        const next = THREE.MathUtils.lerp(entry.group.scale.x, target, smoothing);
        entry.group.scale.setScalar(Math.max(next, 0.0001));
        if (entry.removing && entry.group.scale.x < 0.02) {
          disposeEntry(entry);
          treeEntries.delete(specId);
          continue;
        }
        if (!reducedMotion) {
          if (garden && radial) {
            entry.group.rotation.z = Math.sin(t * 0.4 + entry.phase) * 0.015;
          } else if (!garden && radial) {
            entry.group.position.y = entry.targetPos.y + Math.sin(t * 0.55 + entry.phase) * 0.25;
          }
          if (entry.treeSpec?.state === "active") {
            entry.mats[0].emissiveIntensity = entry.baseEmissive + Math.sin(t * 1.6 + entry.phase) * 0.07;
          }
        }
      }

      renderer.render(scene, camera);
    };
    // TWO-WALL PERF: the default room runs two simultaneous fullscreen WebGL
    // windows on one GPU. Park this window's frame loop entirely while the
    // document is hidden (a backgrounded/occluded wall costs ~0 GPU) and
    // resume on visibility; the tick counter catches up any missed reconciles
    // on the first resumed frame, and the swallowed clock delta keeps the
    // animations from jumping.
    const startLoop = () => {
      if (running) {
        return;
      }
      running = true;
      clock.getDelta();
      frame();
    };
    const stopLoop = () => {
      running = false;
      cancelAnimationFrame(rafId);
    };
    const onSceneVisibility = () => {
      if (document.hidden) {
        stopLoop();
      } else {
        startLoop();
      }
    };
    document.addEventListener("visibilitychange", onSceneVisibility);
    onSceneVisibility();

    return () => {
      stopLoop();
      unregisterDwellSource();
      unregisterCameraControl();
      document.removeEventListener("visibilitychange", onSceneVisibility);
      observer.disconnect();
      if (pointerNavRef.current) {
        renderer.domElement.removeEventListener("pointerdown", onPointerDown);
        renderer.domElement.removeEventListener("pointermove", onPointerMove);
        renderer.domElement.removeEventListener("pointerup", onPointerUp);
        renderer.domElement.removeEventListener("pointerleave", onPointerLeave);
        renderer.domElement.removeEventListener("wheel", onWheel);
      }
      for (const entry of ideaEntries.values()) {
        disposeEntry(entry);
      }
      ideaEntries.clear();
      for (const entry of treeEntries.values()) {
        disposeEntry(entry);
      }
      treeEntries.clear();
      clearLayoutDecor();
      env?.dispose();
      Object.values(GEO).forEach((geometry) => geometry.dispose());
      trunkMat.dispose();
      stemMat.dispose();
      glowTexture.dispose();
      scene.traverse((node) => {
        if (node instanceof THREE.Mesh && node.geometry !== undefined) {
          node.geometry.dispose();
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
    // Mount-once scene; updates flow through refs + tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={containerRef}
      className="room-scene"
      data-testid="room-scene"
      data-region="fleet"
      data-mode={mode}
      data-layout={layout}
      data-corner-lock={cornerLock ? "true" : "false"}
      data-idea-count={ideas.length}
      data-tree-count={trees.length}
      aria-label={`Room ${mode}: ${ideas.length} idea${ideas.length === 1 ? "" : "s"}, ${trees.length} build${trees.length === 1 ? "" : "s"}`}
    />
  );
}
