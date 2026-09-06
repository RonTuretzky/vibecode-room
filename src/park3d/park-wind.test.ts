import { expect, test } from 'bun:test';
import * as THREE from 'three';
import { createParkWind } from './park-wind';

test('leaf and shadow deformation share time, preserve other shader hooks, and stop for reduced motion', () => {
  const visible = new THREE.MeshStandardMaterial(), depth = new THREE.MeshDepthMaterial();
  visible.onBeforeCompile = shader => { shader.uniforms.originalHook = { value: 7 }; };
  const wind = createParkWind();
  wind.attach(visible); wind.attach(depth);
  const key = visible.customProgramCacheKey(); wind.attach(visible);
  expect(visible.customProgramCacheKey()).toBe(key);
  const compile = (material: THREE.Material, source: string) => {
    const shader = { uniforms: {}, vertexShader: source, fragmentShader: '' } as Parameters<THREE.Material['onBeforeCompile']>[0];
    material.onBeforeCompile(shader, {} as THREE.WebGLRenderer); return shader;
  };
  const eye = compile(visible, THREE.ShaderLib.standard.vertexShader), shadow = compile(depth, THREE.ShaderLib.depth.vertexShader);
  expect(eye.uniforms.originalHook!.value).toBe(7);
  expect(eye.uniforms.parkWindTime).toBe(shadow.uniforms.parkWindTime);
  expect(eye.uniforms.parkWindStrength).toBe(shadow.uniforms.parkWindStrength);
  wind.update(12, true);
  expect(eye.uniforms.parkWindTime!.value).toBe(12); expect(shadow.uniforms.parkWindStrength!.value).toBe(1);
  wind.update(15, false);
  expect(eye.uniforms.parkWindTime!.value).toBe(0); expect(shadow.uniforms.parkWindStrength!.value).toBe(0);
  expect(eye.vertexShader.split('float parkTreePhase')).toHaveLength(2);
  expect(shadow.vertexShader).toContain('smoothstep(3.0, 11.0, position.y)');
  visible.dispose(); depth.dispose();
});
