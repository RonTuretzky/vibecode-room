import { useEffect, useRef } from "react";
import * as THREE from "three";
import type { IdeaTrayItem, ProjectorProcess } from "./types";

// The 3D room garden (after conductor-github-visualizer's garden mode): the
// whole stage is one night-garden scene — no 2D bubbles.
//   process = a TREE   (foliage colored by state, size grows with progress)
//   idea    = a FLOWER (ready = 5-petal bloom colored by maturity, sized by
//             confidence, clickable → build; forming = a closed dim bud)
// Environment: gradient sky dome (shader), starfield, grass disc, seeded
// ground decorations, fog. Motion honors prefers-reduced-motion.

export interface IdeaOrbSpec {
  // null = the primary pending suggestion (accepted via /api/suggestion/accept).
  id: string | null;
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
  task: string;
}

interface Garden3DProps {
  ideas: IdeaOrbSpec[];
  trees: TreeSpec[];
  onAcceptIdea: (id: string | null) => void;
  onSelectProcess: (callsign: string) => void;
  view: "ideas" | "builds" | "full";
}

// Maturity → bloom hue (mirrors the tray badge ramp).
const MATURITY_COLOR: Record<IdeaTrayItem["maturity"], number> = {
  forming: 0x38bdf8,
  proposed: 0x38bdf8,
  elaborated: 0x00bcd4,
  actionable: 0x00ff88,
};
// Process state → foliage hue (mirrors the 2D status tokens).
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
const TRUNK_COLOR = 0x4a3527;
const FLASH_MS = 1500;

// Deterministic PRNG for the decoration field (same trick as Atmosphere.tsx).
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

// ── label sprites (canvas texture, always on top) ────────────────────────────
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

function cssHex(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

interface FlowerEntry {
  spec: IdeaOrbSpec;
  group: THREE.Group;
  head: THREE.Group;
  bloomMats: THREE.MeshPhongMaterial[];
  baseEmissive: number;
  color: number;
  label: THREE.Sprite | null;
  labelKey: string;
  targetPos: THREE.Vector3;
  targetScale: number;
  headY: number;
  phase: number;
  flashStart: number | null;
  removing: boolean;
}

interface TreeEntry {
  spec: TreeSpec;
  group: THREE.Group;
  foliageMat: THREE.MeshPhongMaterial;
  label: THREE.Sprite | null;
  labelKey: string;
  targetPos: THREE.Vector3;
  targetScale: number;
  phase: number;
  removing: boolean;
}

export function Garden3D({ ideas, trees, onAcceptIdea, onSelectProcess, view }: Garden3DProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const ideasRef = useRef(ideas);
  ideasRef.current = ideas;
  const treesRef = useRef(trees);
  treesRef.current = trees;
  const viewRef = useRef(view);
  viewRef.current = view;
  const onAcceptRef = useRef(onAcceptIdea);
  onAcceptRef.current = onAcceptIdea;
  const onSelectRef = useRef(onSelectProcess);
  onSelectRef.current = onSelectProcess;
  const reconcileTick = useRef(0);

  useEffect(() => {
    reconcileTick.current += 1;
  }, [ideas, trees, view]);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null || typeof window === "undefined") {
      return;
    }
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 300);
    camera.position.set(0, 3.4, 13.8);
    camera.lookAt(0, 2.0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    // ── environment: night sky dome, stars, grass, fog, decorations ──────────
    const skyGeom = new THREE.SphereGeometry(140, 32, 32);
    skyGeom.scale(-1, 1, 1);
    const skyMat = new THREE.ShaderMaterial({
      uniforms: {
        topColor: { value: new THREE.Color(0x14304a) },
        bottomColor: { value: new THREE.Color(0x040f16) },
        offset: { value: 20 },
        exponent: { value: 0.6 },
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
        uniform vec3 topColor;
        uniform vec3 bottomColor;
        uniform float offset;
        uniform float exponent;
        varying vec3 vWorldPosition;
        void main() {
          float h = normalize(vWorldPosition + offset).y;
          gl_FragColor = vec4(mix(bottomColor, topColor, max(pow(max(h, 0.0), exponent), 0.0)), 1.0);
        }
      `,
      side: THREE.BackSide,
      depthWrite: false,
    });
    scene.add(new THREE.Mesh(skyGeom, skyMat));
    scene.fog = new THREE.Fog(0x061420, 26, 110);

    const rng = mulberry32(0x47415244); // "GARD"
    const starPositions: number[] = [];
    for (let i = 0; i < 320; i++) {
      const theta = rng() * Math.PI * 2;
      const phi = rng() * Math.PI * 0.42 + 0.08;
      const r = 120;
      starPositions.push(r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta));
    }
    const starsGeom = new THREE.BufferGeometry();
    starsGeom.setAttribute("position", new THREE.Float32BufferAttribute(starPositions, 3));
    const stars = new THREE.Points(
      starsGeom,
      new THREE.PointsMaterial({ color: 0xcfe9ff, size: 0.5, transparent: true, opacity: 0.75, fog: false }),
    );
    scene.add(stars);

    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(90, 64),
      new THREE.MeshPhongMaterial({ color: 0x0a271f, side: THREE.DoubleSide }),
    );
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);

    scene.add(new THREE.AmbientLight(0x9fb8cc, 0.55));
    const moon = new THREE.DirectionalLight(0xdfeaff, 0.85);
    moon.position.set(8, 14, 6);
    scene.add(moon);
    const fill = new THREE.DirectionalLight(0x3377ff, 0.3);
    fill.position.set(-8, 4, -6);
    scene.add(fill);

    // Ground decorations: grass tufts, dim wildflowers, small bushes (seeded).
    const decorations = new THREE.Group();
    const grassMat = new THREE.MeshPhongMaterial({ color: 0x14513c, side: THREE.DoubleSide });
    const bushMat = new THREE.MeshPhongMaterial({ color: 0x0f3d2f, emissive: 0x0f3d2f, emissiveIntensity: 0.06 });
    const wildColors = [0x38bdf8, 0x00bcd4, 0x9affc9, 0xf5a0c1, 0xf0e68c];
    for (let i = 0; i < 240; i++) {
      const angle = rng() * Math.PI * 2;
      const radius = 5 + rng() * 55;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      const kind = rng();
      if (kind < 0.45) {
        const tuft = new THREE.Group();
        const blades = 3 + Math.floor(rng() * 3);
        for (let b = 0; b < blades; b++) {
          const blade = new THREE.Mesh(new THREE.PlaneGeometry(0.08, 0.35 + rng() * 0.3), grassMat);
          blade.position.set((rng() - 0.5) * 0.2, 0.2 + rng() * 0.12, (rng() - 0.5) * 0.2);
          blade.rotation.y = rng() * Math.PI;
          blade.rotation.x = -0.15 + rng() * 0.3;
          tuft.add(blade);
        }
        tuft.position.set(x, 0, z);
        decorations.add(tuft);
      } else if (kind < 0.75) {
        const color = wildColors[Math.floor(rng() * wildColors.length)];
        const mat = new THREE.MeshPhongMaterial({ color, emissive: color, emissiveIntensity: 0.12 });
        const flower = new THREE.Group();
        const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.04, 0.4, 4), grassMat);
        stem.position.y = 0.2;
        flower.add(stem);
        const head = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 8), mat);
        head.position.y = 0.44;
        flower.add(head);
        flower.position.set(x, 0, z);
        decorations.add(flower);
      } else {
        const bush = new THREE.Group();
        const puffs = 2 + Math.floor(rng() * 2);
        for (let p = 0; p < puffs; p++) {
          const size = 0.18 + rng() * 0.2;
          const puff = new THREE.Mesh(new THREE.IcosahedronGeometry(size, 1), bushMat);
          puff.position.set((rng() - 0.5) * 0.35, size * 0.8, (rng() - 0.5) * 0.35);
          bush.add(puff);
        }
        bush.position.set(x, 0, z);
        decorations.add(bush);
      }
    }
    scene.add(decorations);

    // ── shared geometries (visualizer-style) ────────────────────────────────
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
    };
    const trunkMat = new THREE.MeshPhongMaterial({ color: TRUNK_COLOR, emissive: TRUNK_COLOR, emissiveIntensity: 0.08 });
    const stemMat = new THREE.MeshPhongMaterial({ color: 0x1c6b4a, emissive: 0x1c6b4a, emissiveIntensity: 0.08 });

    const flowers = new Map<string, FlowerEntry>();
    const treeEntries = new Map<string, TreeEntry>();

    // ── flower / bud builders ───────────────────────────────────────────────
    const buildFlower = (spec: IdeaOrbSpec): Omit<FlowerEntry, "targetPos" | "phase"> => {
      const ready = spec.status === "ready";
      const color = ready ? MATURITY_COLOR[spec.maturity] : BUD_COLOR;
      const size = ready ? 0.9 + spec.confidence * 1.0 : 0.55 + spec.confidence * 0.45;
      const stemH = ready ? 1.0 + spec.confidence * 0.9 : 0.5 + spec.confidence * 0.3;
      const baseEmissive = ready ? 0.4 + spec.confidence * 0.3 : 0.12;

      const group = new THREE.Group();
      const bloomMats: THREE.MeshPhongMaterial[] = [];

      const stem = new THREE.Mesh(GEO.stem, stemMat);
      stem.scale.set(size, stemH, size);
      stem.position.y = stemH / 2;
      group.add(stem);

      const head = new THREE.Group();
      head.position.y = stemH;
      group.add(head);

      if (ready) {
        const centerMat = new THREE.MeshPhongMaterial({ color: 0xffe08a, emissive: 0xffe08a, emissiveIntensity: 0.45 });
        bloomMats.push(centerMat);
        const center = new THREE.Mesh(GEO.flowerCenter, centerMat);
        center.scale.setScalar(size);
        head.add(center);
        const petalMat = new THREE.MeshPhongMaterial({ color, emissive: color, emissiveIntensity: baseEmissive });
        bloomMats.push(petalMat);
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
        const budMat = new THREE.MeshPhongMaterial({
          color,
          emissive: color,
          emissiveIntensity: baseEmissive,
          transparent: true,
          opacity: 0.6,
        });
        bloomMats.push(budMat);
        const bud = new THREE.Mesh(GEO.bud, budMat);
        bud.scale.set(size, size * 1.3, size);
        head.add(bud);
      }

      // Hit target: an invisible sphere over the head so small petals are easy
      // to click at wall distance.
      const hit = new THREE.Mesh(
        new THREE.SphereGeometry(Math.max(0.5, 0.45 * size), 8, 8),
        new THREE.MeshBasicMaterial({ visible: false }),
      );
      hit.userData.pick = { kind: "idea", key: ideaKey(spec) };
      head.add(hit);

      let label: THREE.Sprite | null = null;
      let labelKey = "";
      if (ready && spec.pitch.length > 0) {
        const statusLine = `${Math.round(spec.confidence * 100)}% · ${spec.maturity}${spec.verified ? " ✓" : ""}`;
        labelKey = `${spec.pitch}|${statusLine}`;
        label = makeLabelSprite(spec.pitch, statusLine, cssHex(color));
        label.position.y = stemH + 0.32 * size + 0.1;
        group.add(label);
      }

      return { spec, group, head, bloomMats, baseEmissive, color, label, labelKey, targetScale: 1, headY: stemH, flashStart: null, removing: false };
    };

    // ── tree builder ────────────────────────────────────────────────────────
    const buildTree = (spec: TreeSpec): Omit<TreeEntry, "targetPos" | "phase"> => {
      const color = STATE_COLOR[spec.state];
      const group = new THREE.Group();
      const foliageMat = new THREE.MeshPhongMaterial({
        color,
        emissive: color,
        emissiveIntensity: spec.state === "halted" || spec.state === "blocked" ? 0.1 : 0.2,
      });

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

      const statusLine = `${spec.state} · ${Math.round(spec.progress)}%`;
      const labelKey = `${spec.callsign}|${statusLine}`;
      const label = makeLabelSprite(spec.callsign, statusLine, cssHex(color));
      label.position.y = 6.6;
      group.add(label);

      return { spec, group, foliageMat, label, labelKey, targetScale: 1, removing: false };
    };

    // ── layout ──────────────────────────────────────────────────────────────
    // Centre-out slots (0, -1, +1, -2, +2, …) so the first entries — ready
    // flowers, active trees — hold the middle of the frame instead of piling
    // left in server order.
    const centeredSlot = (index: number): number => {
      const ring = (index + 1) >> 1;
      return index % 2 === 1 ? -ring : ring;
    };
    const treePosition = (index: number): THREE.Vector3 => {
      const slot = centeredSlot(index);
      return new THREE.Vector3(slot * 4.6, 0, -3.2 - (Math.abs(slot) % 2) * 1.6);
    };
    const flowerPosition = (index: number, ideasOnly: boolean): THREE.Vector3 => {
      const spacing = ideasOnly ? 3.6 : 2.9;
      const slot = centeredSlot(index);
      const z = ideasOnly ? 2.2 + (Math.abs(slot) % 2) * 1.6 : 3.6 + (Math.abs(slot) % 2) * 1.2;
      return new THREE.Vector3(slot * spacing, 0, z);
    };

    const disposeSprite = (sprite: THREE.Sprite | null) => {
      if (sprite !== null) {
        sprite.material.map?.dispose();
        sprite.material.dispose();
      }
    };
    const disposeFlower = (entry: FlowerEntry) => {
      scene.remove(entry.group);
      entry.bloomMats.forEach((mat) => mat.dispose());
      disposeSprite(entry.label);
    };
    const disposeTree = (entry: TreeEntry) => {
      scene.remove(entry.group);
      entry.foliageMat.dispose();
      disposeSprite(entry.label);
    };

    const specChanged = (a: IdeaOrbSpec, b: IdeaOrbSpec) =>
      a.status !== b.status || a.maturity !== b.maturity || a.verified !== b.verified ||
      a.pitch !== b.pitch || Math.abs(a.confidence - b.confidence) > 0.005;

    const reconcile = () => {
      const ideasOnly = viewRef.current === "ideas";
      const ideaSpecs: IdeaOrbSpec[] =
        viewRef.current === "builds"
          ? []
          : ideasRef.current.length > 0
            ? ideasRef.current
            : [{ id: "__idle__", pitch: "", confidence: 0.25, status: "forming", maturity: "forming", verified: false }];
      const treeSpecs = viewRef.current === "ideas" ? [] : treesRef.current;

      const seenFlowers = new Set<string>();
      ideaSpecs.forEach((spec, index) => {
        const key = ideaKey(spec);
        seenFlowers.add(key);
        const existing = flowers.get(key);
        const targetPos = flowerPosition(index, ideasOnly);
        // Alternate label heights by slot so neighbouring pitches never stack.
        const labelLift = (Math.abs(centeredSlot(index)) % 2) * 0.55;
        if (existing === undefined) {
          const built = buildFlower(spec);
          built.label?.position.setY(built.label.position.y + labelLift);
          const entry: FlowerEntry = { ...built, targetPos, phase: index * 1.9 };
          entry.group.position.copy(targetPos);
          entry.group.scale.setScalar(0.01);
          if (spec.status === "ready") {
            entry.flashStart = performance.now();
          }
          flowers.set(key, entry);
          scene.add(entry.group);
        } else {
          const promoted = existing.spec.status === "forming" && spec.status === "ready";
          const nowVerified = !existing.spec.verified && spec.verified;
          if (specChanged(existing.spec, spec)) {
            // Rebuild in place (geometry differs between bud and bloom).
            const keepPos = existing.group.position.clone();
            const keepScale = existing.group.scale.x;
            disposeFlower(existing);
            const built = buildFlower(spec);
            built.label?.position.setY(built.label.position.y + labelLift);
            const entry: FlowerEntry = { ...built, targetPos, phase: existing.phase };
            entry.group.position.copy(keepPos);
            entry.group.scale.setScalar(Math.max(keepScale, 0.01));
            if (promoted || nowVerified) {
              entry.flashStart = performance.now();
            }
            flowers.set(key, entry);
            scene.add(entry.group);
          } else {
            existing.targetPos = targetPos;
            existing.removing = false;
            existing.targetScale = 1;
          }
        }
      });
      for (const [key, entry] of flowers) {
        if (!seenFlowers.has(key)) {
          entry.removing = true;
          entry.targetScale = 0;
        }
      }

      const seenTrees = new Set<string>();
      treeSpecs.forEach((spec, index) => {
        seenTrees.add(spec.upid);
        const existing = treeEntries.get(spec.upid);
        const targetPos = treePosition(index);
        const scale = 0.62 + Math.min(Math.max(spec.progress, 0), 100) / 100 * 0.33;
        if (existing === undefined) {
          const built = buildTree(spec);
          const entry: TreeEntry = { ...built, targetPos, phase: index * 1.3 };
          entry.targetScale = scale;
          entry.group.position.copy(targetPos);
          entry.group.scale.setScalar(0.01);
          treeEntries.set(spec.upid, entry);
          scene.add(entry.group);
        } else if (
          existing.spec.state !== spec.state ||
          existing.spec.callsign !== spec.callsign ||
          Math.round(existing.spec.progress) !== Math.round(spec.progress)
        ) {
          const keepPos = existing.group.position.clone();
          const keepScale = existing.group.scale.x;
          disposeTree(existing);
          const built = buildTree(spec);
          const entry: TreeEntry = { ...built, targetPos, phase: existing.phase };
          entry.targetScale = scale;
          entry.group.position.copy(keepPos);
          entry.group.scale.setScalar(Math.max(keepScale, 0.01));
          treeEntries.set(spec.upid, entry);
          scene.add(entry.group);
        } else {
          existing.targetPos = targetPos;
          existing.targetScale = scale;
          existing.removing = false;
        }
      });
      for (const [key, entry] of treeEntries) {
        if (!seenTrees.has(key)) {
          entry.removing = true;
          entry.targetScale = 0;
        }
      }
    };

    // ── picking ─────────────────────────────────────────────────────────────
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let hoveredIdea: string | null = null;
    let hoveredTree: string | null = null;

    const pick = (clientX: number, clientY: number): { kind: string; key?: string; callsign?: string } | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        return null;
      }
      pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const targets: THREE.Object3D[] = [];
      for (const entry of flowers.values()) {
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

    const onPointerMove = (event: PointerEvent) => {
      const picked = pick(event.clientX, event.clientY);
      hoveredIdea = null;
      hoveredTree = null;
      if (picked?.kind === "idea" && picked.key !== undefined && picked.key !== "__idle__") {
        const entry = flowers.get(picked.key);
        if (entry !== undefined && entry.spec.status === "ready") {
          hoveredIdea = picked.key;
        }
      } else if (picked?.kind === "process" && picked.callsign !== undefined) {
        hoveredTree = picked.callsign;
      }
      renderer.domElement.style.cursor = hoveredIdea !== null || hoveredTree !== null ? "pointer" : "default";
    };
    const onPointerLeave = () => {
      hoveredIdea = null;
      hoveredTree = null;
      renderer.domElement.style.cursor = "default";
    };
    const onClick = (event: MouseEvent) => {
      const picked = pick(event.clientX, event.clientY);
      if (picked?.kind === "idea" && picked.key !== undefined && picked.key !== "__idle__") {
        const entry = flowers.get(picked.key);
        if (entry !== undefined && entry.spec.status === "ready") {
          onAcceptRef.current(entry.spec.id);
        }
      } else if (picked?.kind === "process" && picked.callsign !== undefined) {
        onSelectRef.current(picked.callsign);
      }
    };
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("pointerleave", onPointerLeave);
    renderer.domElement.addEventListener("click", onClick);

    const resize = () => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (width === 0 || height === 0) {
        return;
      }
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();

    reconcile();
    let lastTick = reconcileTick.current;

    const clock = new THREE.Clock();
    let rafId = 0;
    const frame = () => {
      rafId = requestAnimationFrame(frame);
      const dt = Math.min(clock.getDelta(), 0.1);
      const t = clock.elapsedTime;
      const now = performance.now();
      if (reconcileTick.current !== lastTick) {
        lastTick = reconcileTick.current;
        reconcile();
      }
      const smoothing = 1 - Math.exp(-dt * 7);

      // The flower bed alone (ideas wall) frames lower and closer than the
      // full garden with trees; glide between the two on view/mock switches.
      const ideasOnly = viewRef.current === "ideas";
      const camY = ideasOnly ? 2.5 : 3.4;
      const camZ = ideasOnly ? 9.6 : 13.8;
      const lookY = ideasOnly ? 1.55 : 2.0;
      const breathe = reducedMotion ? 0 : Math.sin(t * 0.11) * 0.15;
      camera.position.x = reducedMotion ? 0 : Math.sin(t * 0.07) * 1.3;
      camera.position.y = THREE.MathUtils.lerp(camera.position.y, camY + breathe, smoothing);
      camera.position.z = THREE.MathUtils.lerp(camera.position.z, camZ, smoothing);
      camera.lookAt(0, lookY, 0);

      for (const [key, entry] of flowers) {
        entry.group.position.lerp(entry.targetPos, smoothing);
        const hovered = hoveredIdea === key;
        const target = entry.targetScale * (hovered ? 1.12 : 1);
        const next = THREE.MathUtils.lerp(entry.group.scale.x, target, smoothing);
        entry.group.scale.setScalar(Math.max(next, 0.0001));
        if (entry.removing && entry.group.scale.x < 0.02) {
          disposeFlower(entry);
          flowers.delete(key);
          continue;
        }
        if (!reducedMotion) {
          entry.group.rotation.z = Math.sin(t * 0.6 + entry.phase) * 0.04; // sway
          entry.head.position.y = entry.headY + Math.sin(t * 0.9 + entry.phase) * 0.05;
        }
        let boost = hovered ? 0.3 : 0;
        if (entry.flashStart !== null && !reducedMotion) {
          const progress = (now - entry.flashStart) / FLASH_MS;
          if (progress >= 1) {
            entry.flashStart = null;
            entry.bloomMats.forEach((mat) => mat.emissive.set(mat.color));
          } else {
            const pulse = Math.abs(Math.sin(progress * Math.PI * 3)) * (1 - progress);
            boost += pulse * 1.8;
            entry.bloomMats.forEach((mat) =>
              mat.emissive.copy(mat.color).lerp(new THREE.Color(0xffffff), pulse * 0.8),
            );
          }
        }
        entry.bloomMats.forEach((mat) => {
          mat.emissiveIntensity = entry.baseEmissive + boost;
        });
      }

      for (const [key, entry] of treeEntries) {
        entry.group.position.lerp(entry.targetPos, smoothing);
        const hovered = hoveredTree === entry.spec.callsign;
        const target = entry.targetScale * (hovered ? 1.06 : 1);
        const next = THREE.MathUtils.lerp(entry.group.scale.x, target, smoothing);
        entry.group.scale.setScalar(Math.max(next, 0.0001));
        if (entry.removing && entry.group.scale.x < 0.02) {
          disposeTree(entry);
          treeEntries.delete(key);
          continue;
        }
        if (!reducedMotion) {
          entry.group.rotation.z = Math.sin(t * 0.4 + entry.phase) * 0.015; // breeze
          if (entry.spec.state === "active") {
            entry.foliageMat.emissiveIntensity = 0.2 + Math.sin(t * 1.6 + entry.phase) * 0.06;
          }
        }
      }

      renderer.render(scene, camera);
    };
    frame();

    return () => {
      cancelAnimationFrame(rafId);
      observer.disconnect();
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerleave", onPointerLeave);
      renderer.domElement.removeEventListener("click", onClick);
      for (const entry of flowers.values()) {
        disposeFlower(entry);
      }
      flowers.clear();
      for (const entry of treeEntries.values()) {
        disposeTree(entry);
      }
      treeEntries.clear();
      Object.values(GEO).forEach((geometry) => geometry.dispose());
      trunkMat.dispose();
      stemMat.dispose();
      grassMat.dispose();
      bushMat.dispose();
      skyGeom.dispose();
      skyMat.dispose();
      starsGeom.dispose();
      scene.traverse((node) => {
        if (node instanceof THREE.Mesh && node.geometry !== undefined) {
          node.geometry.dispose();
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
    // Mount-once scene; updates flow through refs + reconcileTick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={containerRef}
      className="garden-3d"
      data-testid="garden-3d"
      data-idea-count={ideas.length}
      data-tree-count={trees.length}
      aria-label={`Room garden: ${ideas.length} idea${ideas.length === 1 ? "" : "s"}, ${trees.length} build${trees.length === 1 ? "" : "s"}`}
    />
  );
}
