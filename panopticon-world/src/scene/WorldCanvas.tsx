import { OrbitControls } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { Suspense } from "react";
import { engine, useWorld } from "../world/mockEngine.ts";
import { PAL } from "../world/palette.ts";
import { ErrorBoundary } from "../ui/ErrorBoundary.tsx";
import { Atmosphere } from "./Atmosphere.tsx";
import { Bubbles } from "./Bubbles.tsx";
import { Effects } from "./Effects.tsx";
import { Ground } from "./Ground.tsx";
import { Grove } from "./Grove.tsx";
import { IdeaSpring } from "./IdeaSpring.tsx";
import { Overworld } from "./Overworld.tsx";

export function WorldCanvas() {
  const w = useWorld();
  return (
    <Canvas
      className="world-canvas"
      shadows
      orthographic
      dpr={[1, 1.5]}
      gl={{ antialias: false }}
      camera={{ position: [22, 18, 22], zoom: 30, near: 0.1, far: 240 }}
      onPointerMissed={() => (w.graftFrom ? engine.cancelGraft() : engine.select(null))}
    >
      <fog attach="fog" args={[PAL.skyDay, 34, 96]} />
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
        {/* if post-processing fails on a given GPU, the raw scene still renders */}
        <ErrorBoundary fallback={null}>
          <Effects />
        </ErrorBoundary>
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
