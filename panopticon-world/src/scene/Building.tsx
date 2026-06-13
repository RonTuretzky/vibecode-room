import { Billboard, Html, Sparkles } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import * as THREE from "three";
import { BUILDING_META, VIS_TO_BUILDING } from "../world/itemMapping.ts";
import { KIND_ACCENT, PAL } from "../world/palette.ts";
import type { WorldProcess } from "../world/types.ts";
import { freshnessColor, Smoke, useGrowIn } from "./helpers.tsx";

// One Process rendered as its building. Dispatches by visualizer kind and
// reflects lifecycle state (planning/active/paused/dead).
export function Building({ p, selected, onSelect }: { p: WorldProcess; selected: boolean; onSelect: () => void }) {
  const grow = useGrowIn(p.bornAt, 1.4);
  const accent = KIND_ACCENT[p.visualizer];
  const kind = VIS_TO_BUILDING[p.visualizer];
  const active = p.state === "active";
  const paused = p.state === "paused";
  const planning = p.state === "planning";

  if (p.state === "dead") return <Ruin onSelect={onSelect} />;

  return (
    <group
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        document.body.style.cursor = "pointer";
      }}
      onPointerOut={() => (document.body.style.cursor = "auto")}
    >
      {selected && <SelectionRing color={accent} />}
      <group ref={grow}>
        <group scale={paused ? 1 : 1}>
          {kind === "factory" && <Factory active={active} />}
          {kind === "workshop" && <Workshop active={active} accent={accent} />}
          {kind === "garden" && <Garden active={active} />}
          {kind === "library" && <Library active={active} />}
          {kind === "signpost" && <Signpost active={active} />}
          {kind === "observatory" && <Observatory active={active} accent={accent} />}
        </group>

        {/* freshness lamp (conductor-style): how recently this process emitted */}
        {!planning && <FreshLamp p={p} />}
        {/* output artifact that pops when the session loop emits */}
        {active && <OutputBead pulse={p.emitPulse} accent={accent} />}
        {/* QR portal = mobile pairing affordance (§5.7) */}
        <QrPortal />

        {planning && <Scaffold />}
        {paused && <FrozenOverlay />}
      </group>

      <Billboard position={[0, 3.4, 0]}>
        <Html center distanceFactor={12} occlude={false} style={{ pointerEvents: "none" }}>
          <div className={"name-tag " + p.state}>
            <b>{BUILDING_META[kind].icon}</b> {p.title}
            {p.inbox > 0 && <span className="inbox-pip">📥{p.inbox}</span>}
          </div>
        </Html>
      </Billboard>
    </group>
  );
}

// ── shared bits ──────────────────────────────────────────────────────────────
function SelectionRing({ color }: { color: string }) {
  const r = useRef<THREE.Mesh>(null);
  useFrame((s) => {
    if (!r.current) return;
    const k = 1 + Math.sin(s.clock.elapsedTime * 4) * 0.06;
    r.current.scale.set(k, k, k);
    r.current.rotation.z += 0.01;
  });
  return (
    <mesh ref={r} position={[0, 0.08, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      <torusGeometry args={[1.7, 0.1, 8, 28]} />
      <meshStandardMaterial color={color} emissive={color} emissiveIntensity={1.6} toneMapped={false} />
    </mesh>
  );
}

function FreshLamp({ p }: { p: WorldProcess }) {
  const ref = useRef<THREE.MeshStandardMaterial>(null);
  useFrame(() => {
    if (!ref.current) return;
    const c = freshnessColor(Date.now() - p.lastEmitAt);
    ref.current.color.set(c);
    ref.current.emissive.set(c);
  });
  return (
    <mesh position={[0.9, 2.0, 0.9]}>
      <icosahedronGeometry args={[0.16, 0]} />
      <meshStandardMaterial ref={ref} emissiveIntensity={1.4} toneMapped={false} />
    </mesh>
  );
}

function OutputBead({ pulse, accent }: { pulse: number; accent: string }) {
  const ref = useRef<THREE.Mesh>(null);
  const last = useRef(pulse);
  const t = useRef(1);
  if (pulse !== last.current) {
    last.current = pulse;
    t.current = 0; // restart the pop
  }
  useFrame((_, dt) => {
    if (!ref.current) return;
    t.current = Math.min(1, t.current + dt * 0.8);
    ref.current.position.y = 2.4 + t.current * 1.4;
    const sc = Math.sin(t.current * Math.PI) * 0.3 + 0.02;
    ref.current.scale.setScalar(sc);
  });
  return (
    <mesh ref={ref} position={[0, 2.4, 0]}>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={1.2} toneMapped={false} />
    </mesh>
  );
}

function QrPortal() {
  const ref = useRef<THREE.Mesh>(null);
  useFrame((_, dt) => {
    if (ref.current) ref.current.rotation.y += dt * 1.5;
  });
  return (
    <group position={[1.35, 0.4, -1.1]}>
      <mesh position={[0, 0.4, 0]}>
        <cylinderGeometry args={[0.05, 0.05, 0.8, 5]} />
        <meshStandardMaterial color={PAL.woodDark} flatShading />
      </mesh>
      <mesh ref={ref} position={[0, 0.9, 0]}>
        <torusGeometry args={[0.22, 0.06, 6, 14]} />
        <meshStandardMaterial color={PAL.magenta} emissive={PAL.magenta} emissiveIntensity={1} toneMapped={false} />
      </mesh>
    </group>
  );
}

function Scaffold() {
  return (
    <group>
      {[
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ].map((c, i) => (
        <mesh key={i} position={[c[0] * 1.1, 1.1, c[1] * 1.1]}>
          <cylinderGeometry args={[0.06, 0.06, 2.2, 5]} />
          <meshStandardMaterial color={PAL.wood} flatShading />
        </mesh>
      ))}
      <mesh position={[0, 2.2, 0]}>
        <boxGeometry args={[2.4, 0.08, 2.4]} />
        <meshStandardMaterial color={PAL.wood} flatShading wireframe />
      </mesh>
      <Billboard position={[0, 2.7, 0]}>
        <Html center distanceFactor={14} style={{ pointerEvents: "none" }}>
          <div className="build-tag">🏗️ planning…</div>
        </Html>
      </Billboard>
    </group>
  );
}

function FrozenOverlay() {
  return (
    <group>
      <mesh position={[0, 1.3, 0]}>
        <boxGeometry args={[2.3, 2.6, 2.3]} />
        <meshStandardMaterial color={PAL.cyan} transparent opacity={0.16} flatShading />
      </mesh>
      <Billboard position={[0.9, 2.9, 0]}>
        <Html center distanceFactor={13} style={{ pointerEvents: "none" }}>
          <div className="zzz">💤</div>
        </Html>
      </Billboard>
    </group>
  );
}

function Ruin({ onSelect }: { onSelect: () => void }) {
  return (
    <group onClick={(e) => (e.stopPropagation(), onSelect())}>
      {/* crumbled walls */}
      <mesh position={[-0.5, 0.4, 0.3]} rotation={[0, 0.3, 0.1]}>
        <boxGeometry args={[0.8, 0.8, 0.6]} />
        <meshStandardMaterial color={PAL.stoneDark} roughness={1} flatShading />
      </mesh>
      <mesh position={[0.6, 0.3, -0.2]} rotation={[0, -0.4, -0.15]}>
        <boxGeometry args={[0.7, 0.6, 0.7]} />
        <meshStandardMaterial color={PAL.stoneDark} roughness={1} flatShading />
      </mesh>
      {/* tombstone = pre-kill context archive (C6) */}
      <group position={[0, 0, 0.9]}>
        <mesh position={[0, 0.55, 0]}>
          <boxGeometry args={[0.7, 1.1, 0.16]} />
          <meshStandardMaterial color={PAL.stone} roughness={1} flatShading />
        </mesh>
        <mesh position={[0, 1.1, 0.02]}>
          <cylinderGeometry args={[0.35, 0.35, 0.16, 12, 1, false, 0, Math.PI]} />
          <meshStandardMaterial color={PAL.stone} roughness={1} flatShading />
        </mesh>
      </group>
      <Billboard position={[0, 1.9, 0]}>
        <Html center distanceFactor={13} style={{ pointerEvents: "none" }}>
          <div className="build-tag">🪦 archived</div>
        </Html>
      </Billboard>
    </group>
  );
}

// ── building kinds ───────────────────────────────────────────────────────────
function Factory({ active }: { active: boolean }) {
  const gear = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    if (gear.current && active) gear.current.rotation.z -= dt * 1.6;
  });
  return (
    <group>
      <mesh castShadow position={[0, 0.9, 0]}>
        <boxGeometry args={[2.2, 1.8, 1.8]} />
        <meshStandardMaterial color="#b65a3c" roughness={1} flatShading />
      </mesh>
      {/* saw-tooth roof */}
      {[-0.6, 0, 0.6].map((x, i) => (
        <mesh key={i} castShadow position={[x, 1.95, 0]} rotation={[0, 0, Math.PI / 5]}>
          <boxGeometry args={[0.5, 0.5, 1.8]} />
          <meshStandardMaterial color="#7e3b26" roughness={1} flatShading />
        </mesh>
      ))}
      {/* chimneys */}
      {[-0.6, 0.6].map((x, i) => (
        <group key={i} position={[x, 2.3, -0.6]}>
          <mesh castShadow>
            <cylinderGeometry args={[0.2, 0.24, 1, 8]} />
            <meshStandardMaterial color={PAL.stoneDark} roughness={1} flatShading />
          </mesh>
          {active && (
            <group position={[0, 0.6, 0]}>
              <Smoke count={4} />
            </group>
          )}
        </group>
      ))}
      {/* gear on the face */}
      <group ref={gear} position={[0, 1, 0.95]}>
        <mesh>
          <torusGeometry args={[0.4, 0.12, 6, 10]} />
          <meshStandardMaterial color={PAL.gold} emissive={PAL.gold} emissiveIntensity={active ? 0.5 : 0} flatShading />
        </mesh>
        {Array.from({ length: 6 }).map((_, i) => (
          <mesh key={i} rotation={[0, 0, (i / 6) * Math.PI * 2]}>
            <boxGeometry args={[0.16, 1.04, 0.12]} />
            <meshStandardMaterial color={PAL.gold} flatShading />
          </mesh>
        ))}
      </group>
    </group>
  );
}

function Workshop({ active, accent }: { active: boolean; accent: string }) {
  const sign = useRef<THREE.MeshStandardMaterial>(null);
  useFrame((s) => {
    if (sign.current) sign.current.emissiveIntensity = active ? 0.6 + Math.sin(s.clock.elapsedTime * 3) * 0.4 : 0.1;
  });
  return (
    <group>
      <mesh castShadow position={[0, 0.85, 0]}>
        <boxGeometry args={[2, 1.7, 1.7]} />
        <meshStandardMaterial color="#e7d3a8" roughness={1} flatShading />
      </mesh>
      {/* gable roof */}
      <mesh castShadow position={[0, 2.05, 0]} rotation={[0, Math.PI / 4, 0]}>
        <coneGeometry args={[1.6, 1, 4]} />
        <meshStandardMaterial color={PAL.roofBlue} roughness={1} flatShading />
      </mesh>
      {/* glowing marquee sign */}
      <mesh position={[0, 1.3, 0.9]}>
        <boxGeometry args={[1.3, 0.5, 0.08]} />
        <meshStandardMaterial ref={sign} color={accent} emissive={accent} emissiveIntensity={0.4} toneMapped={false} />
      </mesh>
      {/* door */}
      <mesh position={[0, 0.5, 0.86]}>
        <boxGeometry args={[0.5, 0.9, 0.08]} />
        <meshStandardMaterial color={PAL.woodDark} flatShading />
      </mesh>
      {/* flag */}
      <mesh position={[0, 2.9, 0]}>
        <cylinderGeometry args={[0.03, 0.03, 0.7, 4]} />
        <meshStandardMaterial color={PAL.woodDark} flatShading />
      </mesh>
      <mesh position={[0.25, 3.05, 0]}>
        <boxGeometry args={[0.5, 0.3, 0.04]} />
        <meshStandardMaterial color={accent} flatShading />
      </mesh>
    </group>
  );
}

function Garden({ active }: { active: boolean }) {
  const canopy = useRef<THREE.Group>(null);
  useFrame((s) => {
    if (canopy.current) canopy.current.rotation.z = Math.sin(s.clock.elapsedTime * 1.2) * 0.05;
  });
  return (
    <group>
      {/* planter */}
      <mesh castShadow position={[0, 0.4, 0]}>
        <cylinderGeometry args={[1.4, 1.2, 0.8, 10]} />
        <meshStandardMaterial color={PAL.wood} roughness={1} flatShading />
      </mesh>
      <mesh position={[0, 0.82, 0]}>
        <cylinderGeometry args={[1.3, 1.3, 0.1, 10]} />
        <meshStandardMaterial color="#5a3b22" flatShading />
      </mesh>
      {/* trunk */}
      <mesh castShadow position={[0, 1.5, 0]}>
        <cylinderGeometry args={[0.18, 0.26, 1.6, 6]} />
        <meshStandardMaterial color={PAL.woodDark} roughness={1} flatShading />
      </mesh>
      {/* blossom canopy */}
      <group ref={canopy} position={[0, 2.5, 0]}>
        {[
          [0, 0, 0, 1],
          [0.6, -0.2, 0.3, 0.7],
          [-0.5, -0.1, -0.3, 0.7],
          [0.1, 0.4, -0.4, 0.6],
        ].map((c, i) => (
          <mesh key={i} castShadow position={[c[0], c[1], c[2]]} scale={c[3]}>
            <icosahedronGeometry args={[0.8, 0]} />
            <meshStandardMaterial color={i % 2 ? "#ff9ad5" : "#ff7ce5"} roughness={1} flatShading />
          </mesh>
        ))}
        {active && <Sparkles count={20} scale={2.6} size={3} speed={0.5} color={PAL.magenta} />}
      </group>
    </group>
  );
}

function Library({ active }: { active: boolean }) {
  const book = useRef<THREE.Group>(null);
  useFrame((s) => {
    if (book.current && active) book.current.position.y = 3.2 + Math.sin(s.clock.elapsedTime * 1.5) * 0.12;
  });
  return (
    <group>
      <mesh castShadow position={[0, 1.3, 0]}>
        <boxGeometry args={[1.7, 2.6, 1.7]} />
        <meshStandardMaterial color="#8b6a4a" roughness={1} flatShading />
      </mesh>
      {/* book-spine stripes */}
      {[-0.5, 0, 0.5].map((y, i) => (
        <mesh key={i} position={[0, 0.8 + y + 0.6, 0.86]}>
          <boxGeometry args={[1.5, 0.3, 0.06]} />
          <meshStandardMaterial color={["#d65a4a", "#4a73d6", "#8be36b"][i]} flatShading />
        </mesh>
      ))}
      {/* roof */}
      <mesh castShadow position={[0, 2.75, 0]}>
        <boxGeometry args={[1.9, 0.3, 1.9]} />
        <meshStandardMaterial color="#6e4a2e" flatShading />
      </mesh>
      {/* floating book */}
      <group ref={book} position={[0, 3.2, 0]}>
        <mesh>
          <boxGeometry args={[0.7, 0.12, 0.5]} />
          <meshStandardMaterial color="#c9a0ff" emissive="#c9a0ff" emissiveIntensity={active ? 0.6 : 0.1} flatShading />
        </mesh>
      </group>
    </group>
  );
}

function Signpost({ active }: { active: boolean }) {
  const board = useRef<THREE.Group>(null);
  useFrame((s) => {
    if (board.current) board.current.rotation.z = Math.sin(s.clock.elapsedTime * 1.6) * (active ? 0.08 : 0.02);
  });
  return (
    <group>
      <mesh castShadow position={[0, 1, 0]}>
        <cylinderGeometry args={[0.12, 0.14, 2, 6]} />
        <meshStandardMaterial color={PAL.woodDark} roughness={1} flatShading />
      </mesh>
      <group ref={board} position={[0, 1.8, 0]}>
        <mesh castShadow>
          <boxGeometry args={[1.6, 0.9, 0.12]} />
          <meshStandardMaterial color={PAL.wood} roughness={1} flatShading />
        </mesh>
        {/* carved text lines */}
        {[0.2, 0, -0.2].map((y, i) => (
          <mesh key={i} position={[0, y, 0.07]}>
            <boxGeometry args={[1.1 - i * 0.2, 0.08, 0.02]} />
            <meshStandardMaterial color="#5a3b22" flatShading />
          </mesh>
        ))}
        {/* little roof */}
        <mesh position={[0, 0.6, 0]} rotation={[0, 0, 0]}>
          <boxGeometry args={[1.8, 0.12, 0.4]} />
          <meshStandardMaterial color={PAL.green} flatShading />
        </mesh>
      </group>
    </group>
  );
}

function Observatory({ active, accent }: { active: boolean; accent: string }) {
  const dome = useRef<THREE.Mesh>(null);
  const stars = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    if (dome.current && active) dome.current.rotation.y += dt * 0.4;
    if (stars.current && active) stars.current.rotation.y += dt * 0.5;
  });
  return (
    <group>
      <mesh castShadow position={[0, 0.9, 0]}>
        <cylinderGeometry args={[1.3, 1.5, 1.8, 12]} />
        <meshStandardMaterial color="#cfd6e2" roughness={1} flatShading />
      </mesh>
      {/* dome */}
      <mesh ref={dome} castShadow position={[0, 2, 0]}>
        <sphereGeometry args={[1.35, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshStandardMaterial color={PAL.roofBlue} roughness={0.8} flatShading />
      </mesh>
      {/* telescope */}
      <mesh position={[0.2, 2.4, 0.2]} rotation={[0, 0, -Math.PI / 4]}>
        <cylinderGeometry args={[0.14, 0.2, 1.4, 8]} />
        <meshStandardMaterial color={PAL.gold} metalness={0.4} roughness={0.5} flatShading />
      </mesh>
      {/* data constellation = bar chart in the sky */}
      <group ref={stars} position={[0, 3.4, 0]}>
        {[0.4, 0.8, 0.5, 1, 0.7].map((h, i) => (
          <mesh key={i} position={[(i - 2) * 0.34, h / 2, 0]}>
            <boxGeometry args={[0.18, h, 0.18]} />
            <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={active ? 1 : 0.2} toneMapped={false} />
          </mesh>
        ))}
      </group>
    </group>
  );
}
