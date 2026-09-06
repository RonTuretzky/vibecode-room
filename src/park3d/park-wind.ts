import * as THREE from 'three';

const deformation = `
float parkTreePhase = 0.0;
#ifdef USE_INSTANCING
  parkTreePhase = dot(instanceMatrix[3].xz, vec2(0.031, 0.019));
#endif
float parkFlex = smoothstep(3.0, 11.0, position.y) * parkWindStrength;
float parkSway = sin(parkWindTime * 0.8 + parkTreePhase) * 0.09
  + sin(parkWindTime * 1.3 + parkTreePhase * 1.7) * 0.035;
float parkFlutter = sin(parkWindTime * 3.0 + dot(position.xz, vec2(1.5, 0.9))) * 0.012;
transformed.x += (parkSway + parkFlutter) * parkFlex;
transformed.z += cos(parkWindTime * 0.7 + parkTreePhase) * 0.035 * parkFlex;
`;

/** Coherent, gentle crown motion in both the visible and shadow shaders.
 * Shared uniforms avoid CPU matrix updates or new geometry per frame. */
export function createParkWind() {
  const time = { value: 0 }, strength = { value: 0 };
  const attached = new WeakSet<THREE.Material>();
  return {
    attach(material: THREE.Material) {
      if (attached.has(material)) return;
      attached.add(material);
      const previous = material.onBeforeCompile.bind(material);
      const previousKey = material.customProgramCacheKey();
      material.onBeforeCompile = (shader, renderer) => {
        previous(shader, renderer);
        if (!shader.vertexShader.includes('#include <begin_vertex>')) throw new Error('Park wind: Three vertex shader no longer exposes begin_vertex');
        shader.uniforms.parkWindTime = time; shader.uniforms.parkWindStrength = strength;
        shader.vertexShader = 'uniform float parkWindTime; uniform float parkWindStrength;\n' +
          shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n' + deformation);
      };
      material.customProgramCacheKey = () => previousKey + '|park-wind-v1';
      material.needsUpdate = true;
    },
    update(seconds: number, enabled: boolean) { time.value = enabled ? seconds : 0; strength.value = enabled ? 1 : 0; },
  };
}
