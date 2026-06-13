import { Billboard, Html, Sparkles } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { BUILDING_META, VIS_TO_BUILDING } from "../world/itemMapping.ts";
import { engine } from "../world/mockEngine.ts";
import { KIND_ACCENT, PAL } from "../world/palette.ts";
import type { WorldProcess } from "../world/types.ts";
import { Branch, freshnessColor, hash01, useGrowIn } from "./helpers.tsx";

type Vec3 = [number, number, number];
const CROWN: Vec3 = [0, 3.1, 0];

// Lay the lineage out as a tree: meta-session trunk → root branches → forks.
// Nodes spread by angle, climb by generation. (The "genetic loop" made visible.)
function computeLayout(processes: WorldProcess[]) {
  const byId = new Map(processes.map((p) => [p.upid, p]));
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const p of processes) {
    const par = p.parentId && byId.has(p.parentId) ? p.parentId : null;
    if (par) (children.get(par) ?? children.set(par, []).get(par)!).push(p.upid);
    else roots.push(p.upid);
  }
  const out = new Map<string, { pos: Vec3; parentPos: Vec3 }>();
  const place = (id: string, depth: number, angle: number, spread: number, parentPos: Vec3) => {
    const radius = 2.4 + depth * 2.5;
    const height = 3.0 + depth * 1.5 + (hash01(id) - 0.5) * 0.7;
    const ang = angle + (hash01(id + "a") - 0.5) * 0.12;
    const pos: Vec3 = [Math.cos(ang) * radius, height, Math.sin(ang) * radius];
    out.set(id, { pos, parentPos });
    const kids = children.get(id) ?? [];
    kids.forEach((k, i) => {
      const childSpread = spread * 0.62;
      const childAngle =
        kids.length > 1 ? angle - spread / 2 + ((i + 0.5) / kids.length) * spread : angle + (hash01(k) - 0.5) * 0.4;
      place(k, depth + 1, childAngle, childSpread, pos);
    });
  };
  roots.forEach((r, i) => {
    const a = (i / Math.max(1, roots.length)) * Math.PI * 2;
    place(r, 0, a, (Math.PI * 2) / Math.max(1, roots.length) * 0.85, CROWN);
  });
  return out;
}

export function Grove({
  processes,
  selected,
  graftFrom,
}: {
  processes: WorldProcess[];
  selected: string | null;
  graftFrom: string | null;
}) {
  const sway = useRef<THREE.Group>(null);
  const layout = useMemo(() => computeLayout(processes), [processes]);
  useFrame((s) => {
    if (sway.current) sway.current.rotation.z = Math.sin(s.clock.elapsedTime * 0.6) * 0.012;
  });

  return (
    <group position={[0, 0.66, 0]}>
      <Trunk />
      <group ref={sway}>
        {processes.map((p) => {
          const L = layout.get(p.upid);
          if (!L) return null;
          return <Branch key={"b" + p.upid} a={L.parentPos} b={L.pos} bornAt={p.bornAt} />;
        })}
        {processes.map((p) => {
          const L = layout.get(p.upid);
          if (!L) return null;
          return (
            <GroveNode
              key={p.upid}
              p={p}
              pos={L.pos}
              selected={p.upid === selected}
              isSource={graftFrom === p.upid}
              graftActive={!!graftFrom}
            />
          );
        })}
      </group>
    </group>
  );
}

function Trunk() {
  return (
    <group>
      <mesh castShadow position={[0, 1.5, 0]}>
        <cylinderGeometry args={[0.45, 0.85, 3.1, 8]} />
        <meshStandardMaterial color="#7a4a28" roughness={1} flatShading />
      </mesh>
      {/* root flares */}
      {Array.from({ length: 6 }).map((_, i) => {
        const a = (i / 6) * Math.PI * 2;
        return (
          <mesh key={i} position={[Math.cos(a) * 0.7, 0.2, Math.sin(a) * 0.7]} rotation={[0, -a, 0.5]}>
            <cylinderGeometry args={[0.08, 0.22, 1, 5]} />
            <meshStandardMaterial color="#5f3a20" roughness={1} flatShading />
          </mesh>
        );
      })}
      <mesh position={[0, 3.1, 0]}>
        <icosahedronGeometry args={[0.5, 0]} />
        <meshStandardMaterial color="#5f3a20" roughness={1} flatShading />
      </mesh>
    </group>
  );
}

function GroveNode({
  p,
  pos,
  selected,
  isSource,
  graftActive,
}: {
  p: WorldProcess;
  pos: Vec3;
  selected: boolean;
  isSource: boolean;
  graftActive: boolean;
}) {
  const grow = useGrowIn(p.bornAt, 1.6);
  const fruit = useRef<THREE.MeshStandardMaterial>(null);
  const ring = useRef<THREE.Mesh>(null);
  const [hover, setHover] = useState(false);
  const accent = KIND_ACCENT[p.visualizer];
  const meta = BUILDING_META[VIS_TO_BUILDING[p.visualizer]];
  const dead = p.state === "dead";
  const paused = p.state === "paused";
  const targetable = graftActive && !isSource && !dead;

  useFrame((s) => {
    if (fruit.current) {
      const c = dead ? "#6a5a4a" : paused ? "#8aa0c8" : freshnessColor(Date.now() - p.lastEmitAt);
      fruit.current.color.set(c);
      fruit.current.emissive.set(c);
      fruit.current.emissiveIntensity = dead ? 0.05 : paused ? 0.25 : 0.9;
    }
    if (ring.current) {
      const k = 1 + Math.sin(s.clock.elapsedTime * 5) * 0.08;
      ring.current.scale.set(k, k, k);
    }
  });

  return (
    <group
      position={pos}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHover(true);
        document.body.style.cursor = targetable || !graftActive ? "pointer" : "crosshair";
      }}
      onPointerOut={() => {
        setHover(false);
        document.body.style.cursor = "auto";
      }}
      onClick={(e) => {
        e.stopPropagation();
        engine.nodeClick(p.upid);
      }}
    >
      <group ref={grow} position={[0, isSource ? 0.5 : 0, 0]}>
        {/* foliage cluster */}
        {!dead &&
          [
            [0, 0.1, 0, 1],
            [0.55, -0.1, 0.2, 0.6],
            [-0.45, -0.05, -0.25, 0.6],
            [0.05, 0.45, -0.35, 0.5],
          ].map((c, i) => (
            <mesh key={i} position={[c[0], c[1], c[2]]} scale={c[3]}>
              <icosahedronGeometry args={[0.6, 0]} />
              <meshStandardMaterial color={i % 2 ? "#3fa34d" : "#57c267"} roughness={1} flatShading />
            </mesh>
          ))}
        {dead &&
          [0, 1, 2].map((i) => (
            <mesh key={i} position={[(i - 1) * 0.4, -0.2 - i * 0.1, 0]} rotation={[0, 0, 0.4]}>
              <icosahedronGeometry args={[0.3, 0]} />
              <meshStandardMaterial color="#6a5a3a" roughness={1} flatShading />
            </mesh>
          ))}

        {/* the fruit — colored by freshness (conductor-style) */}
        <mesh castShadow>
          <icosahedronGeometry args={[0.5, 1]} />
          <meshStandardMaterial ref={fruit} roughness={0.4} toneMapped={false} flatShading />
        </mesh>
        {/* kind gem on top keeps building identity */}
        <mesh position={[0, 0.6, 0]} scale={0.34}>
          <octahedronGeometry args={[1, 0]} />
          <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={1} toneMapped={false} flatShading />
        </mesh>
        {p.state === "active" && <Sparkles count={8} scale={1.6} size={2.5} speed={0.4} color={accent} />}

        {selected && (
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.7, 0]}>
            <torusGeometry args={[0.85, 0.07, 8, 22]} />
            <meshStandardMaterial color={PAL.cyan} emissive={PAL.cyan} emissiveIntensity={1.6} toneMapped={false} />
          </mesh>
        )}
        {targetable && (
          <mesh ref={ring} rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.7, 0]}>
            <torusGeometry args={[0.95, 0.06, 8, 22]} />
            <meshStandardMaterial color={PAL.green} emissive={PAL.green} emissiveIntensity={1.4} toneMapped={false} />
          </mesh>
        )}
        {isSource && (
          <Billboard position={[0, 1.2, 0]}>
            <Html center distanceFactor={12} style={{ pointerEvents: "none" }}>
              <div className="graft-tag">✥ pick a branch to graft onto</div>
            </Html>
          </Billboard>
        )}
      </group>

      {(hover || selected) && !isSource && (
        <Billboard position={[0, 1.25, 0]}>
          <Html center distanceFactor={12} style={{ pointerEvents: "none" }}>
            <div className={"name-tag " + p.state}>
              <b>{meta.icon}</b> {p.title}
            </div>
          </Html>
        </Billboard>
      )}
    </group>
  );
}
