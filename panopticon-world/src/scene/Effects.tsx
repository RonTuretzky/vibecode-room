import { Bloom, EffectComposer, Pixelation, Scanline, Vignette } from "@react-three/postprocessing";
import { BlendFunction } from "postprocessing";

// The SNES/CRT look: chunky pixels + glow + faint scanlines + vignette.
export function Effects() {
  return (
    <EffectComposer multisampling={0}>
      <Bloom intensity={0.5} luminanceThreshold={0.6} luminanceSmoothing={0.3} />
      <Pixelation granularity={2.5} />
      <Scanline blendFunction={BlendFunction.OVERLAY} density={1.1} opacity={0.12} />
      <Vignette eskil={false} offset={0.32} darkness={0.45} />
    </EffectComposer>
  );
}
