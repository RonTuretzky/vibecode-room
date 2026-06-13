import { Billboard, Float, Html, Sparkles } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useRef, useState } from "react";
import * as THREE from "three";
import { BUILDING_META, VIS_TO_BUILDING } from "../world/itemMapping.ts";
import { engine } from "../world/mockEngine.ts";
import { KIND_ACCENT, PAL } from "../world/palette.ts";
import type { ViewMode, WorldBubble } from "../world/types.ts";

// The suggestion bubbles: beautiful idea orbs that rise from the spring, drift
// in a slow orbit, bob up and down (Float), and pop when their TTL runs out.
export function Bubbles({ bubbles, viewMode }: { bubbles: WorldBubble[]; viewMode: ViewMode }) {
  const orbit = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    if (orbit.current) orbit.current.rotation.y += dt * 0.06;
  });
  const baseY = viewMode === "grove" ? 5.4 : 3.4;
  const radius = viewMode === "grove" ? 6.6 : 5.6;

  return (
    <group ref={orbit} position={[0, baseY, 0]}>
      {bubbles.map((b, i) => {
        const a = b.angle + i * 0.5;
        const r = radius + (b.seed % 1.4);
        return <Orb key={b.id} b={b} pos={[Math.cos(a) * r, ((b.seed * 13) % 10) / 10 - 0.5, Math.sin(a) * r]} />;
      })}
    </group>
  );
}

function Orb({ b, pos }: { b: WorldBubble; pos: [number, number, number] }) {
  const inner = useRef<THREE.Group>(null);
  const [hover, setHover] = useState(false);
  const accent = b.modelInitiated ? PAL.magenta : KIND_ACCENT[b.visualizer];
  const meta = BUILDING_META[VIS_TO_BUILDING[b.visualizer]];

  useFrame(() => {
    if (!inner.current) return;
    const frac = Math.max(0, 1 - (Date.now() - b.createdAt) / b.ttlMs);
    const dying = frac < 0.28 ? 0.6 + frac : 1; // pulse/shrink near expiry
    const target = (hover ? 1.18 : 1) * dying;
    inner.current.scale.lerp(new THREE.Vector3(target, target, target), 0.15);
  });

  return (
    <Float speed={2.2} rotationIntensity={0.5} floatIntensity={1.6} floatingRange={[-0.35, 0.45]} position={pos}>
      <group
        ref={inner}
        onPointerOver={(e) => {
          e.stopPropagation();
          setHover(true);
          document.body.style.cursor = "pointer";
        }}
        onPointerOut={() => {
          setHover(false);
          document.body.style.cursor = "auto";
        }}
        onClick={(e) => {
          e.stopPropagation();
          engine.acceptBubble(b.id); // catch the orb → it plants
        }}
      >
        {/* glass shell */}
        <mesh>
          <icosahedronGeometry args={[0.85, 2]} />
          <meshStandardMaterial
            color={PAL.bubble}
            roughness={0.15}
            metalness={0}
            transparent
            opacity={0.45}
            emissive={accent}
            emissiveIntensity={0.4}
            toneMapped={false}
          />
        </mesh>
        {/* glowing core */}
        <mesh scale={0.42}>
          <icosahedronGeometry args={[1, 1]} />
          <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={1.4} toneMapped={false} />
        </mesh>
        <Sparkles count={10} scale={2} size={2.5} speed={0.5} color={accent} />
        {b.modelInitiated && (
          <mesh position={[0, 1.15, 0]} rotation={[0, 0, Math.PI / 4]}>
            <octahedronGeometry args={[0.18, 0]} />
            <meshStandardMaterial color={PAL.magenta} emissive={PAL.magenta} emissiveIntensity={1.5} toneMapped={false} />
          </mesh>
        )}

        <Billboard position={[0, 1.5, 0]}>
          <Html center distanceFactor={11} occlude={false} style={{ pointerEvents: "none" }}>
            <div className={"orb-label" + (b.modelInitiated ? " model" : "")}>
              <span className="i">{meta.icon}</span>
              {b.title}
              {b.modelInitiated && <em> · prior art</em>}
            </div>
          </Html>
        </Billboard>
      </group>
    </Float>
  );
}
