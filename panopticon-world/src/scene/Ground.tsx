import { useMemo } from "react";
import { PAL } from "../world/palette.ts";
import { hash01 } from "./helpers.tsx";

// The floating SNES island: chunky octagonal grass disc ringed by sand and
// water, with a stone plaza at the center (under the Idea Spring / world tree).
export function Ground() {
  const decor = useMemo(() => {
    const items: { x: number; z: number; kind: "rock" | "bush" | "flower"; s: number; c: string }[] = [];
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2 + hash01("a" + i);
      const r = 5 + hash01("r" + i) * 9.5;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const roll = hash01("k" + i);
      const kind = roll < 0.33 ? "rock" : roll < 0.66 ? "bush" : "flower";
      const c = kind === "flower" ? ["#ff7ce5", "#ffd86b", "#6be8ff"][i % 3] : kind === "rock" ? PAL.stone : PAL.grassDark;
      items.push({ x, z, kind, s: 0.5 + hash01("s" + i) * 0.7, c });
    }
    return items;
  }, []);

  return (
    <group>
      {/* water */}
      <mesh position={[0, -0.9, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <circleGeometry args={[46, 40]} />
        <meshStandardMaterial color={PAL.water} roughness={0.4} metalness={0.1} />
      </mesh>
      {/* sand ring */}
      <mesh position={[0, -0.35, 0]}>
        <cylinderGeometry args={[16.8, 17.6, 0.7, 8]} />
        <meshStandardMaterial color={PAL.sand} roughness={1} flatShading />
      </mesh>
      {/* grass island */}
      <mesh position={[0, -0.2, 0]} receiveShadow>
        <cylinderGeometry args={[16, 16.4, 1.2, 8]} />
        <meshStandardMaterial color={PAL.grassLight} roughness={1} flatShading />
      </mesh>
      {/* darker grass top highlight */}
      <mesh position={[0, 0.41, 0]} receiveShadow>
        <cylinderGeometry args={[15.4, 15.8, 0.1, 8]} />
        <meshStandardMaterial color={PAL.grassDark} roughness={1} flatShading />
      </mesh>
      {/* central stone plaza */}
      <mesh position={[0, 0.5, 0]} receiveShadow>
        <cylinderGeometry args={[3.4, 3.7, 0.3, 12]} />
        <meshStandardMaterial color={PAL.stone} roughness={1} flatShading />
      </mesh>

      {decor.map((d, i) => (
        <group key={i} position={[d.x, 0.5, d.z]}>
          {d.kind === "rock" && (
            <mesh castShadow position={[0, d.s * 0.4, 0]}>
              <dodecahedronGeometry args={[d.s * 0.6, 0]} />
              <meshStandardMaterial color={d.c} roughness={1} flatShading />
            </mesh>
          )}
          {d.kind === "bush" && (
            <mesh castShadow position={[0, d.s * 0.5, 0]}>
              <icosahedronGeometry args={[d.s * 0.7, 0]} />
              <meshStandardMaterial color={d.c} roughness={1} flatShading />
            </mesh>
          )}
          {d.kind === "flower" && (
            <group position={[0, 0, 0]}>
              <mesh position={[0, d.s * 0.5, 0]}>
                <cylinderGeometry args={[0.04, 0.04, d.s, 4]} />
                <meshStandardMaterial color={PAL.grassEdge} flatShading />
              </mesh>
              <mesh position={[0, d.s + 0.05, 0]}>
                <icosahedronGeometry args={[0.16, 0]} />
                <meshStandardMaterial color={d.c} emissive={d.c} emissiveIntensity={0.4} flatShading />
              </mesh>
            </group>
          )}
        </group>
      ))}

      {/* fake blob shadow under the center instead of a per-frame ContactShadows pass */}
      <mesh position={[0, 0.67, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[5, 24]} />
        <meshBasicMaterial color="#0f0b22" transparent opacity={0.22} />
      </mesh>
    </group>
  );
}
