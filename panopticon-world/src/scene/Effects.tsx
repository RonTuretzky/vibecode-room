import { Bloom, EffectComposer, Pixelation, Scanline, Vignette } from "@react-three/postprocessing";
import { BlendFunction } from "postprocessing";

// The SNES/CRT look: chunky pixels + glow + faint scanlines + vignette.
export function Effects() {
  return (
    <EffectComposer multisampling={0}>
      <Bloom intensity={0.55} luminanceThreshold={0.55} luminanceSmoothing={0.25} mipmapBlur />
      <Pixelation granularity={3.2} />
      <Scanline blendFunction={BlendFunction.OVERLAY} density={1.1} opacity={0.18} />
      <Vignette eskil={false} offset={0.22} darkness={0.72} />
    </EffectComposer>
  );
}
