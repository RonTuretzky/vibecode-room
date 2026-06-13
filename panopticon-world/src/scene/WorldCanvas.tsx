import { OrbitControls } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { Suspense } from "react";
import { engine, useWorld } from "../world/mockEngine.ts";
import { PAL } from "../world/palette.ts";
import { Atmosphere } from "./Atmosphere.tsx";
import { Bubbles } from "./Bubbles.tsx";
import { Ground } from "./Ground.tsx";
import { Grove } from "./Grove.tsx";
import { IdeaSpring } from "./IdeaSpring.tsx";
import { Overworld } from "./Overworld.tsx";

export function WorldCanvas() {
  const w = useWorld();
  return (
    <Canvas
      className="world-canvas"
      orthographic
      dpr={0.75} // low-res backing buffer → chunky SNES pixels (cheap, crash-proof)
      gl={{ antialias: false, powerPreference: "high-performance", failIfMajorPerformanceCaveat: false }}
      camera={{ position: [22, 18, 22], zoom: 30, near: 0.1, far: 240 }}
      onCreated={({ gl }) => {
        // Recover gracefully instead of blanking if the GPU drops the context.
        gl.domElement.addEventListener(
          "webglcontextlost",
          (e) => {
            e.preventDefault();
            console.warn("[panopticon-world] webgl context lost — attempting restore");
          },
          false,
        );
      }}
      onPointerMissed={() => (w.graftFrom ? engine.cancelGraft() : engine.select(null))}
    >
      <fog attach="fog" args={[PAL.skyDay, 38, 110]} />
      <Suspense fallback={null}>
        <Atmosphere />
        <Ground />

        {w.viewMode === "overworld" ? (
          <>
            <IdeaSpring />
            <Overworld processes={w.processes} selected={w.selected} />
          </>
        ) : (
          <Grove processes={w.processes} selected={w.selected} graftFrom={w.graftFrom} />
        )}

        <Bubbles bubbles={w.bubbles} viewMode={w.viewMode} />
      </Suspense>

      <OrbitControls
        makeDefault
        enablePan
        enableDamping
        target={[0, 1.8, 0]}
        minZoom={14}
        maxZoom={78}
        minPolarAngle={0.15}
        maxPolarAngle={Math.PI * 0.47}
      />
    </Canvas>
  );
}
