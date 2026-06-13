import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";

// Conductor-style freshness color: just-emitted = green → stale = red.
// (Mirrors RonTuretzky/conductor-github-visualizer's 0-15/15-30/30-60/60+ ramp,
//  retuned to this sim's faster emit cadence.)
export function freshnessColor(ageMs: number): string {
  if (ageMs < 4500) return "#7cfc6b";
  if (ageMs < 9000) return "#ffe36b";
  if (ageMs < 16000) return "#ff9e3d";
  return "#ff5a6b";
}

export const hash01 = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000;
};

const UP = new THREE.Vector3(0, 1, 0);

/**
 * A bark branch that grows from `a` toward `b`. Anchored at `a`, it scales its
 * length 0→1 over `grow` seconds starting at `bornAt`. Used for Grove lineage.
 */
export function Branch({
  a,
  b,
  bornAt,
  grow = 1.1,
  rBase = 0.16,
  rTip = 0.07,
  color = "#7a4a28",
}: {
  a: [number, number, number];
  b: [number, number, number];
  bornAt: number;
  grow?: number;
  rBase?: number;
  rTip?: number;
  color?: string;
}) {
  const group = useRef<THREE.Group>(null);
  const { len, quat, mid } = useMemo(() => {
    const start = new THREE.Vector3(...a);
    const end = new THREE.Vector3(...b);
    const dir = end.clone().sub(start);
    const l = Math.max(0.001, dir.length());
    const q = new THREE.Quaternion().setFromUnitVectors(UP, dir.clone().normalize());
    return { len: l, quat: q, mid: l / 2 };
  }, [a, b]);

  useFrame(() => {
    if (!group.current) return;
    const t = (Date.now() - bornAt) / (grow * 1000);
    const g = Math.max(0.001, Math.min(1, t < 0 ? 0 : 1 - Math.pow(1 - Math.min(1, t), 3)));
    group.current.scale.y = g;
  });

  return (
    <group ref={group} position={a} quaternion={quat}>
      <mesh position={[0, mid, 0]} castShadow>
        <cylinderGeometry args={[rTip, rBase, len, 6]} />
        <meshStandardMaterial color={color} roughness={1} flatShading />
      </mesh>
    </group>
  );
}

// Rising smoke/steam puffs for active factories & fountains.
export function Smoke({
  count = 5,
  color = "#dfe6f0",
  spread = 0.35,
  rise = 2.4,
  size = 0.28,
}: {
  count?: number;
  color?: string;
  spread?: number;
  rise?: number;
  size?: number;
}) {
  const refs = useRef<(THREE.Mesh | null)[]>([]);
  const seeds = useMemo(
    () => Array.from({ length: count }, (_, i) => ({ off: i / count, x: (Math.random() - 0.5) * spread, z: (Math.random() - 0.5) * spread })),
    [count, spread],
  );
  useFrame((s) => {
    const t = s.clock.elapsedTime;
    refs.current.forEach((m, i) => {
      if (!m) return;
      const p = (t * 0.35 + seeds[i].off) % 1;
      m.position.y = p * rise;
      m.position.x = seeds[i].x * (0.4 + p);
      m.position.z = seeds[i].z * (0.4 + p);
      const sc = (0.4 + p * 0.9) * size;
      m.scale.setScalar(sc);
      const mat = m.material as THREE.MeshStandardMaterial;
      mat.opacity = Math.max(0, (1 - p) * 0.6);
    });
  });
  return (
    <>
      {seeds.map((_, i) => (
        <mesh key={i} ref={(el) => (refs.current[i] = el)}>
          <icosahedronGeometry args={[1, 0]} />
          <meshStandardMaterial color={color} transparent opacity={0.5} flatShading roughness={1} />
        </mesh>
      ))}
    </>
  );
}

/** Smoothly lerp a mesh/group scale toward a target (used for "grow in" pops). */
export function useGrowIn(bornAt: number, dur = 0.9) {
  const ref = useRef<THREE.Group>(null);
  useFrame(() => {
    if (!ref.current) return;
    const t = Math.min(1, (Date.now() - bornAt) / (dur * 1000));
    const e = 1 - Math.pow(1 - t, 3);
    ref.current.scale.setScalar(0.001 + e);
  });
  return ref;
}
