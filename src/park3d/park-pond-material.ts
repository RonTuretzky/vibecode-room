import * as THREE from "three";

/** Optical shore coverage, not bathymetry. Probe the same water mask used
 * for the mesh, so shallow olive margins follow its clipped boundary. */
export function waterInteriorAt(waterAt: (x: number, z: number) => number, x: number, z: number): number {
  const wet = Math.max(0, Math.min(1, (waterAt(x, z) - .5) * 2));
  if (wet === 0) return 0;
  let cover = 0;
  for (const [radius, weight] of [[4, .7], [9, .3]] as const) {
    cover += weight * (waterAt(x + radius, z) + waterAt(x - radius, z) + waterAt(x, z + radius) + waterAt(x, z - radius)) / 4;
  }
  return wet * Math.max(0, Math.min(1, (cover - .5) * 2));
}

/** Tune Three's ocean-oriented shader for a sheltered pond. Reuses its
 * reflection, Fresnel, shadows and color management; no extra render pass. */
export function refinePondMaterial(material: THREE.ShaderMaterial): void {
  if (material.userData.parkPond) return;
  const normal = "vec3 surfaceNormal = normalize( noise.xzy * vec3( 1.5, 1.0, 1.5 ) );";
  const scatter = "vec3 scatter = max( 0.0, dot( surfaceNormal, eyeDirection ) ) * waterColor;";
  if (!material.fragmentShader.includes(normal) || !material.fragmentShader.includes(scatter)) {
    throw new Error("Three Water shader changed: check the park pond integration");
  }
  material.vertexShader = "attribute float waterInterior; varying float vWaterInterior;\n" + material.vertexShader.replace(
    "void main() {", "void main() { vWaterInterior = waterInterior;");
  material.fragmentShader = "varying float vWaterInterior; uniform vec3 shoreColor;\n" + material.fragmentShader
    .replace(normal, "float pondInterior = smoothstep( 0.0, 1.0, vWaterInterior );\nvec3 surfaceNormal = normalize( noise.xzy * vec3( mix( 0.12, 0.38, pondInterior ), 1.0, mix( 0.12, 0.38, pondInterior ) ) );")
    .replace(scatter, "vec3 pondColor = mix( shoreColor, waterColor, pondInterior );\nvec3 scatter = max( 0.0, dot( surfaceNormal, eyeDirection ) ) * pondColor;");
  material.uniforms.shoreColor = { value: new THREE.Color(0x505d3e) };
  material.uniforms.waterColor!.value.set(0x2d4940);
  material.uniforms.size!.value = 3.5;
  material.uniforms.distortionScale!.value = .3;
  material.userData.parkPond = true;
  material.needsUpdate = true;
}
