import { Sparkles } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import * as THREE from "three";
import { PAL } from "../world/palette.ts";

// The Idea Spring — the always-on room transcript made physical. Conversation
// wells up here and floats off as idea bubbles. (Overworld center piece.)
export function IdeaSpring() {
  const water = useRef<THREE.Mesh>(null);
  const orbs = useRef<(THREE.Mesh | null)[]>([]);

  useFrame((s) => {
    const t = s.clock.elapsedTime;
    if (water.current) {
      const m = water.current.material as THREE.MeshStandardMaterial;
      m.emissiveIntensity = 0.5 + Math.sin(t * 2) * 0.2;
      water.current.position.y = 1.02 + Math.sin(t * 1.5) * 0.03;
    }
    orbs.current.forEach((o, i) => {
      if (!o) return;
      const p = (t * 0.4 + i / 6) % 1;
      o.position.y = 1.1 + p * 2.6;
      const a = i * 1.7 + t * 0.5;
      o.position.x = Math.cos(a) * (0.25 + p * 0.5);
      o.position.z = Math.sin(a) * (0.25 + p * 0.5);
      o.scale.setScalar((1 - p) * 0.22 + 0.04);
      (o.material as THREE.MeshStandardMaterial).opacity = (1 - p) * 0.85;
    });
  });

  return (
    <group position={[0, 0.66, 0]}>
      {/* basin */}
      <mesh castShadow receiveShadow position={[0, 0.45, 0]}>
        <cylinderGeometry args={[1.7, 1.9, 0.9, 12]} />
        <meshStandardMaterial color={PAL.stone} roughness={1} flatShading />
      </mesh>
      <mesh position={[0, 0.9, 0]}>
        <torusGeometry args={[1.62, 0.18, 8, 14]} />
        <meshStandardMaterial color={PAL.stoneDark} roughness={1} flatShading />
      </mesh>
      {/* water surface */}
      <mesh ref={water} position={[0, 1.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[1.55, 18]} />
        <meshStandardMaterial color={PAL.cyan} emissive={PAL.cyan} emissiveIntensity={0.6} transparent opacity={0.85} />
      </mesh>
      {/* central column / spout */}
      <mesh castShadow position={[0, 1.5, 0]}>
        <cylinderGeometry args={[0.18, 0.3, 1.4, 8]} />
        <meshStandardMaterial color={PAL.stone} roughness={1} flatShading />
      </mesh>
      <pointLight position={[0, 2, 0]} color={PAL.cyan} intensity={6} distance={9} />

      {/* welling bubble orbs */}
      {Array.from({ length: 6 }).map((_, i) => (
        <mesh key={i} ref={(el) => (orbs.current[i] = el)}>
          <icosahedronGeometry args={[1, 1]} />
          <meshStandardMaterial color={PAL.bubble} emissive={PAL.cyan} emissiveIntensity={0.7} transparent opacity={0.8} />
        </mesh>
      ))}
      <Sparkles count={26} scale={[3, 3, 3]} position={[0, 2, 0]} size={3} speed={0.4} color={PAL.cyan} />
    </group>
  );
}
