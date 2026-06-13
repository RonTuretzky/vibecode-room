import { useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { PAL } from "../world/palette.ts";

const DAY_PERIOD = 54; // seconds per in-game day (the meta-session autonomy cycle)

const cDay = new THREE.Color(PAL.skyDay);
const cDusk = new THREE.Color(PAL.skyDusk);
const cNight = new THREE.Color(PAL.skyNight);
const cSunWarm = new THREE.Color("#fff2c4");
const cMoon = new THREE.Color("#9fb6ff");
const tmp = new THREE.Color();

// The meta-session as weather: the sun arcs once per autonomy cycle, the sky
// lerps day↔dusk↔night, and stars fade in after dark.
export function Atmosphere() {
  const sun = useRef<THREE.DirectionalLight>(null);
  const sunMesh = useRef<THREE.Mesh>(null);
  const moonMesh = useRef<THREE.Mesh>(null);
  const stars = useRef<THREE.Points>(null);
  const { scene } = useThree();

  const starGeo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const n = 260;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const r = 60 + Math.random() * 30;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.random() * Math.PI * 0.5;
      pos[i * 3] = Math.cos(th) * Math.cos(ph) * r;
      pos[i * 3 + 1] = Math.sin(ph) * r + 6;
      pos[i * 3 + 2] = Math.sin(th) * Math.cos(ph) * r;
    }
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    return g;
  }, []);

  useFrame((s) => {
    const phase = (s.clock.elapsedTime / DAY_PERIOD + 0.5) % 1; // start at MIDDAY
    const ang = phase * Math.PI * 2 - Math.PI / 2;
    const h = Math.sin(ang); // sun height -1..1
    const day = THREE.MathUtils.clamp(h * 0.9 + 0.5, 0.25, 1); // never fully dark
    const duskAmt = THREE.MathUtils.clamp(1 - Math.abs(h) * 3, 0, 1);

    // sky color
    tmp.copy(cNight).lerp(cDay, day);
    tmp.lerp(cDusk, duskAmt * 0.6);
    scene.background = tmp.clone();
    if (scene.fog) (scene.fog as THREE.Fog).color.copy(tmp);

    const radius = 46;
    if (sun.current) {
      sun.current.position.set(Math.cos(ang) * radius, Math.abs(h) * radius + 8, Math.sin(ang) * radius * 0.4 + 14);
      sun.current.intensity = 0.7 + day * 1.0;
      sun.current.color.copy(cSunWarm).lerp(cMoon, 1 - day);
    }
    if (sunMesh.current) {
      sunMesh.current.position.set(Math.cos(ang) * radius, h * radius, -20);
      (sunMesh.current.material as THREE.MeshBasicMaterial).opacity = THREE.MathUtils.clamp(h * 3, 0, 1);
    }
    if (moonMesh.current) {
      moonMesh.current.position.set(-Math.cos(ang) * radius, -h * radius, -20);
      (moonMesh.current.material as THREE.MeshBasicMaterial).opacity = THREE.MathUtils.clamp(-h * 3, 0, 1);
    }
    if (stars.current) {
      (stars.current.material as THREE.PointsMaterial).opacity = THREE.MathUtils.clamp(1 - day * 1.6, 0, 1);
    }
  });

  return (
    <>
      <hemisphereLight args={["#bfe0ff", "#3a5a2a", 0.8]} />
      <ambientLight intensity={0.6} />
      <directionalLight ref={sun} castShadow position={[20, 30, 14]} intensity={1.2}>
        <orthographicCamera attach="shadow-camera" args={[-22, 22, 22, -22, 1, 90]} />
      </directionalLight>
      <mesh ref={sunMesh}>
        <circleGeometry args={[3.6, 24]} />
        <meshBasicMaterial color="#ffe9a8" transparent />
      </mesh>
      <mesh ref={moonMesh}>
        <circleGeometry args={[2.6, 24]} />
        <meshBasicMaterial color="#dfe6ff" transparent />
      </mesh>
      <points ref={stars} geometry={starGeo}>
        <pointsMaterial size={0.5} color="#ffffff" transparent sizeAttenuation />
      </points>
    </>
  );
}
