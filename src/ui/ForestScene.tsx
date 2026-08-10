import { useEffect, useRef } from "react";
import * as THREE from "three";
import { buildTreeLOD, treeSpecSignature, type BuiltTree } from "./tree";
import { forestPlacements, hasForest, type ForestCi, type ForestState } from "./forest-spec";

// ── ForestScene: the GitHub-forest window's three.js mount ──────────────────
// RoomScene's small-scale pattern, one job only: render the org grove. Mounts
// the renderer ONCE (updates flow through refs + a tick counter), simple
// garden-palette sky/ground (flat colors — no photoscan assets on this
// window), ambient + directional daylight, and a slow idle-drift camera
// orbiting the grove center. Each repo's TreeSpec3D goes through buildTreeLOD
// and is reconciled by treeSpecSignature — an unchanged payload tick rebuilds
// NOTHING. Interaction: small invisible pick spheres ride every PR branch tip
// (userData.pickId = "repo#number"); hovering one shows a floating label div
// (PR title, CI word, repo) and clicking calls onPick(pickId). SSR-safe: the
// effect bails without a window, so server renders emit just the container.

export interface ForestSceneProps {
  // The /api/forest state; null and {org:null} both render an empty meadow.
  forest: ForestState | null;
  issuesVisible: boolean;
  onPick?: (pickId: string) => void;
}

// Hover-card CI phrasing (also the contract test's hook).
export function forestCiWord(ci: ForestCi): string {
  switch (ci) {
    case "pass":
      return "CI passing";
    case "fail":
      return "CI failing";
    case "pending":
      return "CI pending";
    default:
      return "no CI";
  }
}

// Garden-palette flats (RoomScene's daylight family, no textures).
const SKY_COLOR = 0xbfd9ee;
const FOG_COLOR = 0xdcedf8;
const GROUND_COLOR = 0x79a35a;

const PICK_SPHERE_RADIUS = 0.55;
const IDLE_DRIFT_RAD_PER_S = 0.045;
const CLICK_SLOP_PX = 7;

interface TreeEntry {
  built: BuiltTree;
  signature: string;
  holder: THREE.Group;
}

interface TipInfo {
  title: string;
  ci: ForestCi;
  repo: string;
}

export function ForestScene({ forest, issuesVisible, onPick }: ForestSceneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const forestRef = useRef(forest);
  const issuesRef = useRef(issuesVisible);
  const onPickRef = useRef(onPick);
  const tick = useRef(0);

  useEffect(() => {
    forestRef.current = forest;
    issuesRef.current = issuesVisible;
    tick.current += 1;
  }, [forest, issuesVisible]);
  useEffect(() => {
    onPickRef.current = onPick;
  }, [onPick]);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null || typeof window === "undefined") {
      return;
    }
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(SKY_COLOR);
    scene.fog = new THREE.Fog(FOG_COLOR, 90, 260);
    const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 500);
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    // Daylight: soft ambient + one warm sun key (matches the garden's angle).
    scene.add(new THREE.AmbientLight(0xdce8f2, 0.75));
    const sun = new THREE.DirectionalLight(0xfff2d9, 1.35);
    sun.position.set(-24, 42, -30);
    scene.add(sun);

    // Simple meadow disc; the fog folds its rim into the sky.
    const groundGeometry = new THREE.CircleGeometry(160, 48);
    const groundMaterial = new THREE.MeshStandardMaterial({ color: GROUND_COLOR, roughness: 1, metalness: 0 });
    const ground = new THREE.Mesh(groundGeometry, groundMaterial);
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);

    // A little procedural cat that dances in the meadow — flat garden-palette
    // primitives (no textures, matching this window's aesthetic). Its body/head
    // sway and paws lift on the frame clock; nothing here reconciles with the
    // grove, so it lives for the scene and disposes with it.
    const cat = new THREE.Group();
    cat.position.set(0, 0, 8);
    const catMaterial = new THREE.MeshStandardMaterial({ color: 0x4a4a52, roughness: 0.9, metalness: 0 });
    const catBodyGeometry = new THREE.CapsuleGeometry(0.5, 0.9, 4, 8);
    const catHeadGeometry = new THREE.SphereGeometry(0.42, 12, 12);
    const catEarGeometry = new THREE.ConeGeometry(0.16, 0.32, 4);
    const catLegGeometry = new THREE.CapsuleGeometry(0.12, 0.5, 3, 6);
    const catTailGeometry = new THREE.CapsuleGeometry(0.09, 1.0, 3, 6);
    const catDisposables: THREE.BufferGeometry[] = [
      catBodyGeometry,
      catHeadGeometry,
      catEarGeometry,
      catLegGeometry,
      catTailGeometry,
    ];

    const catBody = new THREE.Mesh(catBodyGeometry, catMaterial);
    catBody.rotation.x = Math.PI / 2;
    catBody.position.y = 1.15;
    cat.add(catBody);

    const catHead = new THREE.Group();
    catHead.position.set(0, 1.75, 0.55);
    const catHeadMesh = new THREE.Mesh(catHeadGeometry, catMaterial);
    catHead.add(catHeadMesh);
    for (const side of [-1, 1]) {
      const ear = new THREE.Mesh(catEarGeometry, catMaterial);
      ear.position.set(0.2 * side, 0.34, 0);
      catHead.add(ear);
    }
    cat.add(catHead);

    const catPaws: THREE.Mesh[] = [];
    const pawSpots: [number, number][] = [
      [-0.28, 0.4],
      [0.28, 0.4],
      [-0.28, -0.4],
      [0.28, -0.4],
    ];
    for (const [x, z] of pawSpots) {
      const leg = new THREE.Mesh(catLegGeometry, catMaterial);
      leg.position.set(x, 0.4, z);
      cat.add(leg);
      catPaws.push(leg);
    }

    const catTail = new THREE.Mesh(catTailGeometry, catMaterial);
    catTail.position.set(0, 1.2, -0.7);
    catTail.rotation.x = -Math.PI / 4;
    cat.add(catTail);
    scene.add(cat);

    // Floating hover card (plain DOM over the canvas — crisp text at any zoom).
    const hoverLabel = document.createElement("div");
    hoverLabel.className = "forest-hover-label";
    hoverLabel.style.display = "none";
    container.appendChild(hoverLabel);

    // ── grove state ─────────────────────────────────────────────────────────
    const trees = new Map<string, TreeEntry>();
    // Invisible branch-tip hit volumes: shared geometry/material, rebuilt as
    // plain children of one group on every reconcile (nothing per-mesh owned).
    const pickGroup = new THREE.Group();
    scene.add(pickGroup);
    const pickGeometry = new THREE.SphereGeometry(PICK_SPHERE_RADIUS, 8, 8);
    const pickMaterial = new THREE.MeshBasicMaterial({ visible: false });
    const tipInfo = new Map<string, TipInfo>();

    // Camera rig: eased spherical orbit around the grove center with a slow
    // idle drift (the forest window has no pointer nav — it is a display).
    const rig = { angle: 0.6, radius: 34, height: 12, targetX: 0, targetZ: 0, dRadius: 34, dTargetX: 0, dTargetZ: 0 };
    const applyRig = () => {
      rig.height = rig.radius * 0.36 + 2.5;
      camera.position.set(
        rig.targetX + Math.sin(rig.angle) * rig.radius,
        rig.height,
        rig.targetZ + Math.cos(rig.angle) * rig.radius,
      );
      camera.lookAt(rig.targetX, 3.2, rig.targetZ);
    };
    applyRig();

    const disposeTree = (entry: TreeEntry) => {
      entry.built.dispose();
      entry.holder.removeFromParent();
    };

    const reconcile = () => {
      const state = forestRef.current;
      const payload = hasForest(state) ? state : null;
      const placements = payload === null ? [] : forestPlacements(payload, { issuesVisible: issuesRef.current });

      const seen = new Set<string>();
      for (const placement of placements) {
        seen.add(placement.repo);
        const signature = treeSpecSignature(placement.spec);
        const existing = trees.get(placement.repo);
        if (existing !== undefined && existing.signature === signature) {
          existing.holder.position.set(placement.position[0], 0, placement.position[1]);
          continue;
        }
        if (existing !== undefined) {
          disposeTree(existing);
        }
        const built = buildTreeLOD(placement.spec);
        const holder = new THREE.Group();
        holder.position.set(placement.position[0], 0, placement.position[1]);
        holder.add(built.group);
        scene.add(holder);
        trees.set(placement.repo, { built, signature, holder });
      }
      for (const [repo, entry] of trees) {
        if (!seen.has(repo)) {
          disposeTree(entry);
          trees.delete(repo);
        }
      }

      // Pick spheres + hover metadata rebuilt whole (cheap: shared prototypes).
      pickGroup.clear();
      tipInfo.clear();
      if (payload !== null) {
        for (const repo of payload.repos) {
          for (const pr of repo.prs) {
            tipInfo.set(`${repo.name}#${pr.number}`, { title: pr.title, ci: pr.ci, repo: repo.name });
          }
        }
      }
      for (const placement of placements) {
        for (const branch of placement.spec.branches) {
          const pickId = branch.tip?.pickId;
          if (pickId === undefined || pickId === null || branch.points.length === 0) {
            continue;
          }
          const tip = branch.points[branch.points.length - 1];
          const sphere = new THREE.Mesh(pickGeometry, pickMaterial);
          sphere.position.set(placement.position[0] + tip.x, tip.y, placement.position[1] + tip.z);
          sphere.userData.pickId = pickId;
          pickGroup.add(sphere);
        }
      }

      // Frame the grove: center + extent → eased orbit targets.
      if (placements.length > 0) {
        let sumX = 0;
        let sumZ = 0;
        let maxR = 0;
        for (const placement of placements) {
          sumX += placement.position[0];
          sumZ += placement.position[1];
        }
        const centerX = sumX / placements.length;
        const centerZ = sumZ / placements.length;
        for (const placement of placements) {
          maxR = Math.max(maxR, Math.hypot(placement.position[0] - centerX, placement.position[1] - centerZ));
        }
        rig.dTargetX = centerX;
        rig.dTargetZ = centerZ;
        rig.dRadius = Math.max(18, Math.min(85, maxR * 1.55 + 14));
      } else {
        rig.dTargetX = 0;
        rig.dTargetZ = 0;
        rig.dRadius = 34;
      }
    };

    // ── hover + pick ────────────────────────────────────────────────────────
    const raycaster = new THREE.Raycaster();
    const pointerNdc = new THREE.Vector2();
    let hoveredPickId: string | null = null;
    let downX = 0;
    let downY = 0;
    let pointerDown = false;

    const pickAt = (clientX: number, clientY: number): string | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        return null;
      }
      pointerNdc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointerNdc, camera);
      const hit = raycaster.intersectObjects(pickGroup.children, false)[0];
      const pickId: unknown = hit?.object.userData.pickId;
      return typeof pickId === "string" ? pickId : null;
    };

    const onPointerMove = (event: PointerEvent) => {
      hoveredPickId = pickAt(event.clientX, event.clientY);
      const info = hoveredPickId !== null ? tipInfo.get(hoveredPickId) : undefined;
      if (info === undefined) {
        hoverLabel.style.display = "none";
        renderer.domElement.style.cursor = "default";
        return;
      }
      const rect = container.getBoundingClientRect();
      hoverLabel.textContent = "";
      const title = document.createElement("div");
      title.className = "forest-hover-title";
      title.textContent = info.title;
      const sub = document.createElement("div");
      sub.className = "forest-hover-sub";
      sub.textContent = `${forestCiWord(info.ci)} · ${info.repo}`;
      hoverLabel.append(title, sub);
      hoverLabel.style.left = `${event.clientX - rect.left + 14}px`;
      hoverLabel.style.top = `${event.clientY - rect.top + 10}px`;
      hoverLabel.style.display = "block";
      renderer.domElement.style.cursor = "pointer";
    };
    const onPointerDown = (event: PointerEvent) => {
      pointerDown = true;
      downX = event.clientX;
      downY = event.clientY;
    };
    const onPointerUp = (event: PointerEvent) => {
      const wasDown = pointerDown;
      pointerDown = false;
      if (!wasDown || Math.hypot(event.clientX - downX, event.clientY - downY) > CLICK_SLOP_PX) {
        return;
      }
      const pickId = pickAt(event.clientX, event.clientY);
      if (pickId !== null) {
        onPickRef.current?.(pickId);
      }
    };
    const onPointerLeave = () => {
      hoveredPickId = null;
      pointerDown = false;
      hoverLabel.style.display = "none";
      renderer.domElement.style.cursor = "default";
    };
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointerup", onPointerUp);
    renderer.domElement.addEventListener("pointerleave", onPointerLeave);

    const resize = () => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (width === 0 || height === 0) {
        return;
      }
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();

    reconcile();
    let lastTick = tick.current;

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
      if (tick.current !== lastTick) {
        lastTick = tick.current;
        reconcile();
      }
      // Slow idle drift around the grove; the eased radius/target glide any
      // reframe (new org, repo count change) instead of snapping.
      if (!reducedMotion) {
        rig.angle += dt * IDLE_DRIFT_RAD_PER_S;
      }
      const smoothing = 1 - Math.exp(-dt * 3.5);
      rig.radius += (rig.dRadius - rig.radius) * smoothing;
      rig.targetX += (rig.dTargetX - rig.targetX) * smoothing;
      rig.targetZ += (rig.dTargetZ - rig.targetZ) * smoothing;
      applyRig();
      if (!reducedMotion) {
        for (const entry of trees.values()) {
          entry.built.update(t);
        }
        // Dance: hop the whole cat, sway its body, bob the head, wag the tail,
        // and lift alternate paws off the beat.
        const beat = t * 4.2;
        cat.position.y = Math.abs(Math.sin(beat)) * 0.35;
        cat.rotation.y = Math.sin(beat * 0.5) * 0.4;
        catBody.rotation.z = Math.sin(beat) * 0.12;
        catHead.rotation.z = Math.sin(beat + 0.6) * 0.22;
        catTail.rotation.z = Math.sin(beat * 1.5) * 0.5;
        for (let i = 0; i < catPaws.length; i++) {
          const phase = i % 2 === 0 ? beat : beat + Math.PI;
          catPaws[i].position.y = 0.4 + Math.max(0, Math.sin(phase)) * 0.25;
        }
      }
      renderer.render(scene, camera);
    };
    // Same two-wall perf contract as RoomScene: a hidden window costs ~0 GPU.
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
    const onVisibility = () => {
      if (document.hidden) {
        stopLoop();
      } else {
        startLoop();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    onVisibility();

    return () => {
      stopLoop();
      document.removeEventListener("visibilitychange", onVisibility);
      observer.disconnect();
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      renderer.domElement.removeEventListener("pointerleave", onPointerLeave);
      for (const entry of trees.values()) {
        disposeTree(entry);
      }
      trees.clear();
      pickGroup.clear();
      pickGeometry.dispose();
      pickMaterial.dispose();
      groundGeometry.dispose();
      groundMaterial.dispose();
      cat.removeFromParent();
      catMaterial.dispose();
      for (const geometry of catDisposables) {
        geometry.dispose();
      }
      renderer.dispose();
      renderer.domElement.remove();
      hoverLabel.remove();
    };
    // Mount-once scene; updates flow through refs + tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const repoCount = hasForest(forest) ? forest.repos.length : 0;
  return (
    <div
      ref={containerRef}
      className="forest-scene"
      data-testid="forest-scene"
      data-org={hasForest(forest) ? forest.org : ""}
      data-repo-count={repoCount}
      data-issues-visible={issuesVisible ? "true" : "false"}
      aria-label={
        hasForest(forest)
          ? `GitHub forest: ${forest.org}, ${repoCount} repo${repoCount === 1 ? "" : "s"}`
          : "GitHub forest: no org imported"
      }
    />
  );
}
