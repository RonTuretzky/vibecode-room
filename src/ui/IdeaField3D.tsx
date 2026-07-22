import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { IdeaTrayItem } from "./types";

// 3D idea constellation: every ledger candidate floats as a glowing orb in a
// slowly-turning ring — ready ideas bright and clickable (click = build),
// forming ideas as small translucent ghosts. Replaces the 2D idea bubble.
// Renders with an alpha canvas so the CSS Atmosphere (auroras/particles) stays
// visible behind the scene. All motion is time-based and honors
// prefers-reduced-motion (static constellation, no orbit/bob).

export interface IdeaOrbSpec {
  // null = the primary pending suggestion (accepted via /api/suggestion/accept).
  id: string | null;
  pitch: string;
  confidence: number;
  status: "ready" | "forming";
  maturity: IdeaTrayItem["maturity"];
  verified: boolean;
}

interface IdeaField3DProps {
  orbs: IdeaOrbSpec[];
  onAccept: (id: string | null) => void;
  // "band": the 2D process fleet owns centre stage (full view), so the
  // constellation shrinks into a band along the bottom of the field.
  layout?: "full" | "band";
}

// Maturity → orb hue, mirroring the tray badge ramp (--c-planning → --c-selected
// → --c-active). Ghost (forming-status) orbs sink to a dim slate regardless.
const MATURITY_COLOR: Record<IdeaTrayItem["maturity"], number> = {
  forming: 0x38bdf8,
  proposed: 0x38bdf8,
  elaborated: 0x00bcd4,
  actionable: 0x00ff88,
};
const GHOST_COLOR = 0x6b8296;
const VERIFIED_COLOR = 0x9affc9;

const FLASH_MS = 1500; // 3 decaying pulses, à la the visualizer's finish flash

interface OrbEntry {
  spec: IdeaOrbSpec;
  group: THREE.Group;
  sphere: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>;
  halo: THREE.Sprite;
  ring: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial> | null;
  label: THREE.Sprite | null;
  labelKey: string;
  radius: number;
  baseEmissive: number;
  targetPos: THREE.Vector3;
  targetScale: number;
  phase: number;
  flashStart: number | null;
  removing: boolean;
}

function orbKey(spec: IdeaOrbSpec): string {
  return spec.id ?? "__primary__";
}

function orbRadius(spec: IdeaOrbSpec): number {
  return spec.status === "ready" ? 0.85 + spec.confidence * 0.75 : 0.42 + spec.confidence * 0.3;
}

// Ring placement (visualizer-style): n orbs spread evenly, starting at the top;
// a single orb sits centre-stage. Depth is elliptical so the ring reads as a
// shallow orbit rather than a wall of spheres.
function orbPosition(index: number, count: number): THREE.Vector3 {
  if (count <= 1) {
    return new THREE.Vector3(0, 0.2, 0);
  }
  const angle = (index / count) * Math.PI * 2 - Math.PI / 2;
  const radius = Math.min(5.6, 2.8 + count * 0.5);
  return new THREE.Vector3(
    Math.cos(angle) * radius,
    (index % 2 === 0 ? 0.55 : -0.45),
    Math.sin(angle) * radius * 0.55,
  );
}

// Band placement (full view, fleet on stage): a flat line of orbs hugging the
// bottom of the field — the tray right beneath carries the pitches.
function bandPosition(index: number, count: number): THREE.Vector3 {
  const spacing = Math.min(3.2, 19 / Math.max(count, 1));
  return new THREE.Vector3((index - (count - 1) / 2) * spacing, index % 2 === 0 ? 0.25 : -0.25, 0);
}

// Soft radial halo texture, tinted per-orb via the sprite material color.
function makeHaloTexture(): THREE.CanvasTexture {
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

// Canvas-texture label sprite (the visualizer's technique): word-wrapped pitch
// over a rounded glass card, always-on-top (depthTest off), scaled to the true
// canvas aspect so text stays crisp and undistorted.
function makeLabelSprite(pitch: string, statusLine: string, accentCss: string): THREE.Sprite {
  const dpr = 2;
  const maxWidth = 236;
  const padX = 14;
  const padY = 10;
  const pitchFont = "500 13px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  const statusFont = "600 10px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

  const measure = document.createElement("canvas").getContext("2d")!;
  measure.font = pitchFont;
  const words = pitch.split(/\s+/).filter(Boolean);
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
    lines[2] = `${lines[2].slice(0, 28)}…`;
  }

  const lineHeight = 17;
  const statusHeight = statusLine.length > 0 ? 16 : 0;
  const height = padY * 2 + lines.length * lineHeight + statusHeight;
  const width = maxWidth;

  const canvas = document.createElement("canvas");
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);

  ctx.beginPath();
  ctx.roundRect(0.5, 0.5, width - 1, height - 1, 10);
  ctx.fillStyle = "rgba(8, 18, 26, 0.74)";
  ctx.fill();
  ctx.strokeStyle = "rgba(158, 226, 255, 0.18)";
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.font = pitchFont;
  ctx.fillStyle = "#eaf6ff";
  ctx.textBaseline = "top";
  lines.forEach((line, i) => {
    ctx.fillText(line, padX, padY + i * lineHeight);
  });
  if (statusLine.length > 0) {
    ctx.font = statusFont;
    ctx.fillStyle = accentCss;
    ctx.fillText(statusLine.toUpperCase(), padX, padY + lines.length * lineHeight + 3);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true });
  const sprite = new THREE.Sprite(material);
  const worldScale = 1 / 52;
  sprite.scale.set(width * worldScale, height * worldScale, 1);
  sprite.center.set(0.5, 1);
  sprite.renderOrder = 10;
  return sprite;
}

export function IdeaField3D({ orbs, onAccept, layout = "full" }: IdeaField3DProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const onAcceptRef = useRef(onAccept);
  onAcceptRef.current = onAccept;
  const orbsRef = useRef(orbs);
  orbsRef.current = orbs;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  // Bumps a ref the render loop watches, without re-running the setup effect.
  const reconcileTick = useRef(0);

  // The scene graph lives entirely in refs; React only supplies the container
  // div and the latest orb specs. Everything is built in an effect so the
  // component stays SSR/renderToStaticMarkup-safe (tests render markup only).
  const sceneState = useRef<{
    entries: Map<string, OrbEntry>;
    root: THREE.Group | null;
  }>({ entries: new Map(), root: null });

  useEffect(() => {
    reconcileTick.current += 1;
  }, [orbs, layout]);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null || typeof window === "undefined") {
      return;
    }

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 100);
    camera.position.set(0, 1.7, 11.8);
    camera.lookAt(0, 0.1, 0);

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight(0x8899aa, 0.6));
    const key = new THREE.DirectionalLight(0xffffff, 0.95);
    key.position.set(6, 8, 4);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x4488ff, 0.35); // cool rim fill
    fill.position.set(-6, -2, -4);
    scene.add(fill);

    const root = new THREE.Group();
    scene.add(root);
    sceneState.current.root = root;

    const sphereGeo = new THREE.SphereGeometry(1, 48, 48);
    const torusGeo = new THREE.TorusGeometry(1.35, 0.02, 8, 64);
    const haloTexture = makeHaloTexture();
    const entries = sceneState.current.entries;

    const disposeEntry = (entry: OrbEntry) => {
      root.remove(entry.group);
      entry.sphere.material.dispose();
      entry.halo.material.map?.dispose();
      entry.halo.material.dispose();
      entry.ring?.material.dispose();
      if (entry.label !== null) {
        entry.label.material.map?.dispose();
        entry.label.material.dispose();
      }
    };

    const buildLabel = (spec: IdeaOrbSpec): { sprite: THREE.Sprite | null; key: string } => {
      if (spec.pitch.length === 0) {
        return { sprite: null, key: "" };
      }
      const confidencePct = `${Math.round(spec.confidence * 100)}%`;
      const statusLine =
        spec.status === "ready"
          ? `${confidencePct} · ${spec.maturity}${spec.verified ? " ✓" : ""}`
          : `forming · ${confidencePct}`;
      const accent = spec.status === "ready" ? "#7ef0c4" : "#8fb6cf";
      const key = `${spec.pitch}|${statusLine}`;
      return { sprite: makeLabelSprite(spec.pitch, statusLine, accent), key };
    };

    // Alternate labels below/above their orbs so neighbouring pitches don't
    // stack when the turning ring projects two orbs close together; ready
    // labels draw over ghost labels.
    const placeLabel = (entry: OrbEntry, index: number) => {
      if (entry.label === null) {
        return;
      }
      const below = index % 2 === 0;
      entry.label.center.set(0.5, below ? 1 : 0);
      entry.label.position.set(0, below ? -(entry.radius + 0.34) : entry.radius + 0.34, 0);
      entry.label.renderOrder = entry.spec.status === "ready" ? 12 : 11;
    };

    const applySpec = (entry: OrbEntry, spec: IdeaOrbSpec) => {
      const ready = spec.status === "ready";
      const color = ready ? MATURITY_COLOR[spec.maturity] : GHOST_COLOR;
      entry.radius = orbRadius(spec);
      entry.baseEmissive = ready ? 0.55 + spec.confidence * 0.5 : 0.16;
      entry.sphere.material.color.set(color).multiplyScalar(0.55);
      entry.sphere.material.emissive.set(color);
      entry.sphere.material.emissiveIntensity = entry.baseEmissive;
      entry.sphere.material.opacity = ready ? 0.96 : 0.38;
      entry.sphere.scale.setScalar(entry.radius);
      entry.halo.material.color.set(color);
      entry.halo.material.opacity = ready ? 0.5 : 0.16;
      entry.halo.scale.setScalar(entry.radius * 3.4);

      if (spec.verified && entry.ring === null) {
        const ring = new THREE.Mesh(
          torusGeo,
          new THREE.MeshBasicMaterial({ color: VERIFIED_COLOR, transparent: true, opacity: 0.5 }),
        );
        ring.rotation.x = Math.PI * 0.42;
        entry.ring = ring;
        entry.group.add(ring);
      } else if (!spec.verified && entry.ring !== null) {
        entry.group.remove(entry.ring);
        entry.ring.material.dispose();
        entry.ring = null;
      }
      entry.ring?.scale.setScalar(entry.radius);

      const nextLabel = buildLabel(spec);
      if (nextLabel.key !== entry.labelKey) {
        if (entry.label !== null) {
          entry.group.remove(entry.label);
          entry.label.material.map?.dispose();
          entry.label.material.dispose();
        }
        if (nextLabel.sprite !== null) {
          entry.group.add(nextLabel.sprite);
        }
        entry.label = nextLabel.sprite;
        entry.labelKey = nextLabel.key;
      }
      entry.spec = spec;
    };

    const reconcile = () => {
      // No candidates → a single dormant "listening" core so the field never
      // reads as broken/empty.
      const specs: IdeaOrbSpec[] =
        orbsRef.current.length > 0
          ? orbsRef.current
          : [{ id: "__idle__", pitch: "", confidence: 0.2, status: "forming", maturity: "forming", verified: false }];
      const band = layoutRef.current === "band";
      const placeOrb = band ? bandPosition : orbPosition;
      const seen = new Set<string>();
      specs.forEach((spec, index) => {
        const specId = orbKey(spec);
        seen.add(specId);
        let entry = entries.get(specId);
        if (entry === undefined) {
          const group = new THREE.Group();
          const sphere = new THREE.Mesh(
            sphereGeo,
            new THREE.MeshStandardMaterial({
              roughness: 0.32,
              metalness: 0.12,
              transparent: true,
            }),
          );
          sphere.userData.orbKey = specId;
          const halo = new THREE.Sprite(
            new THREE.SpriteMaterial({
              map: haloTexture,
              blending: THREE.AdditiveBlending,
              transparent: true,
              depthWrite: false,
            }),
          );
          group.add(halo);
          group.add(sphere);
          group.scale.setScalar(0.01); // entrance: grow in
          entry = {
            spec,
            group,
            sphere,
            halo,
            ring: null,
            label: null,
            labelKey: "",
            radius: orbRadius(spec),
            baseEmissive: 0,
            targetPos: placeOrb(index, specs.length),
            targetScale: 1,
            phase: index * 1.7,
            flashStart: spec.status === "ready" ? performance.now() : null,
            removing: false,
          };
          group.position.copy(entry.targetPos);
          entries.set(specId, entry);
          root.add(group);
          applySpec(entry, spec);
          placeLabel(entry, index);
        } else {
          // Promotion (forming → ready) fires the finish-flash.
          if (entry.spec.status === "forming" && spec.status === "ready") {
            entry.flashStart = performance.now();
          }
          if (!entry.spec.verified && spec.verified) {
            entry.flashStart = performance.now();
          }
          entry.removing = false;
          entry.targetScale = 1;
          entry.targetPos = placeOrb(index, specs.length);
          applySpec(entry, spec);
          placeLabel(entry, index);
        }
      });
      for (const [specId, entry] of entries) {
        if (!seen.has(specId)) {
          entry.removing = true;
          entry.targetScale = 0;
        }
      }
    };

    let lastTick = -1;
    let hoveredKey: string | null = null;
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    const pickOrb = (clientX: number, clientY: number): OrbEntry | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        return null;
      }
      pointer.set(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      const spheres = [...entries.values()].filter((e) => !e.removing).map((e) => e.sphere);
      const hit = raycaster.intersectObjects(spheres, false)[0];
      if (hit === undefined) {
        return null;
      }
      const key = hit.object.userData.orbKey as string;
      return entries.get(key) ?? null;
    };

    const onPointerMove = (event: PointerEvent) => {
      const entry = pickOrb(event.clientX, event.clientY);
      const interactive = entry !== null && entry.spec.status === "ready" && entry.spec.id !== "__idle__";
      hoveredKey = interactive ? orbKey(entry.spec) : null;
      renderer.domElement.style.cursor = interactive ? "pointer" : "default";
    };
    const onPointerLeave = () => {
      hoveredKey = null;
      renderer.domElement.style.cursor = "default";
    };
    const onClick = (event: MouseEvent) => {
      const entry = pickOrb(event.clientX, event.clientY);
      if (entry !== null && entry.spec.status === "ready" && entry.spec.id !== "__idle__") {
        onAcceptRef.current(entry.spec.id);
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
    lastTick = reconcileTick.current;

    const clock = new THREE.Clock();
    let rafId = 0;
    let rotAngle = 0;
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
      const band = layoutRef.current === "band";

      // Ring mode orbits slowly; band mode is a still line (accumulator, so
      // toggling never snaps the angle).
      if (!reducedMotion && !band) {
        rotAngle += dt * 0.05;
      }
      root.rotation.y = rotAngle;

      // Band layout: slide the whole constellation down + shrink it so the 2D
      // process fleet keeps centre stage. Lerped so view switches glide.
      const rootScaleTarget = band ? 0.44 : 1;
      const rootYTarget = band ? -3.8 : 0;
      root.scale.setScalar(THREE.MathUtils.lerp(root.scale.x, rootScaleTarget, smoothing));
      root.position.y = THREE.MathUtils.lerp(root.position.y, rootYTarget, smoothing);

      for (const [specId, entry] of entries) {
        const bob = reducedMotion ? 0 : Math.sin(t * 0.7 + entry.phase) * 0.22;
        entry.group.position.lerp(entry.targetPos, smoothing);
        entry.sphere.position.y = bob;
        entry.halo.position.y = bob;

        const hovered = hoveredKey === specId;
        const scaleTarget = entry.targetScale * (hovered ? 1.14 : 1);
        const nextScale = THREE.MathUtils.lerp(entry.group.scale.x, scaleTarget, smoothing);
        entry.group.scale.setScalar(Math.max(nextScale, 0.0001));
        if (entry.removing && entry.group.scale.x < 0.02) {
          disposeEntry(entry);
          entries.delete(specId);
          continue;
        }

        // Counter-rotate labels so the pitch stays put while the ring turns
        // (sprites billboard themselves, but their anchor swings with the root).
        entry.group.rotation.y = -root.rotation.y;

        // Band mode drops the labels entirely — the idea tray right beneath
        // the band carries the pitches; tiny floating cards would be noise.
        if (entry.label !== null) {
          entry.label.visible = !band;
        }

        // Finish-flash: three decaying white pulses over 1.5s, then done.
        let emissive = entry.baseEmissive + (hovered ? 0.35 : 0);
        if (entry.flashStart !== null && !reducedMotion) {
          const progress = (now - entry.flashStart) / FLASH_MS;
          if (progress >= 1) {
            entry.flashStart = null;
            entry.sphere.material.emissive.set(
              entry.spec.status === "ready" ? MATURITY_COLOR[entry.spec.maturity] : GHOST_COLOR,
            );
          } else {
            const pulse = Math.abs(Math.sin(progress * Math.PI * 3)) * (1 - progress);
            emissive += pulse * 2.2;
            entry.sphere.material.emissive.lerpColors(
              new THREE.Color(entry.spec.status === "ready" ? MATURITY_COLOR[entry.spec.maturity] : GHOST_COLOR),
              new THREE.Color(0xffffff),
              pulse * 0.85,
            );
          }
        } else if (!reducedMotion && entry.spec.status === "ready") {
          emissive += Math.sin(t * 1.4 + entry.phase) * 0.08; // gentle alive shimmer
        }
        entry.sphere.material.emissiveIntensity = emissive;
        entry.ring?.rotation.set(Math.PI * 0.42, 0, reducedMotion ? 0 : t * 0.4);
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
      for (const entry of entries.values()) {
        disposeEntry(entry);
      }
      entries.clear();
      sphereGeo.dispose();
      torusGeo.dispose();
      haloTexture.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      sceneState.current.root = null;
    };
    // Mount-once scene; orb updates flow through orbsRef + reconcileTick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const orbCount = useMemo(() => orbs.length, [orbs]);

  return (
    <div
      ref={containerRef}
      className="idea-field-3d"
      data-testid="idea-field-3d"
      data-orb-count={orbCount}
      aria-label={
        orbCount > 0
          ? `Idea constellation: ${orbCount} candidate${orbCount === 1 ? "" : "s"}`
          : "Idea constellation: listening"
      }
    />
  );
}
