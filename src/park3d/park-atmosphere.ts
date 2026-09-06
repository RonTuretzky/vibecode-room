import * as THREE from "three";
import { Sky } from "three/addons/objects/Sky.js";

/** A single sun/shadow pass, with a physical sky and warm, distance-based haze. */
export function createParkAtmosphere(renderer: THREE.WebGLRenderer, scene: THREE.Scene, group: THREE.Group, camera: THREE.Camera) {
  const previous = { toneMapping: renderer.toneMapping, exposure: renderer.toneMappingExposure, environmentIntensity: scene.environmentIntensity, shadowType: renderer.shadowMap.type, shadows: renderer.shadowMap.enabled, autoShadow: renderer.shadowMap.autoUpdate, environment: scene.environment };
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = .96;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;
  scene.fog = new THREE.FogExp2(0xd1dace, .0019);

  const sky = new Sky();
  sky.name = "park-atmospheric-sky";
  sky.scale.setScalar(9500);
  const uniforms = sky.material.uniforms;
  uniforms.turbidity.value = 3.8;
  uniforms.rayleigh.value = 1.65;
  uniforms.mieCoefficient.value = .004;
  uniforms.mieDirectionalG.value = .83;
  const direction = new THREE.Vector3(-.62, .48, -.62).normalize();
  uniforms.sunPosition.value.copy(direction);
  group.add(sky);

  // Generate environment lighting from the same sky, then release the baker.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environmentScene = new THREE.Scene();
  environmentScene.add(sky.clone());
  const environment = pmrem.fromScene(environmentScene, .02, .1, 12000);
  pmrem.dispose();
  scene.environment = environment.texture;
  scene.environmentIntensity = .07;

  const sun = new THREE.DirectionalLight(0xffdfaf, 2.5);
  sun.name = "park-sun";
  sun.position.copy(direction).multiplyScalar(110);
  sun.target.position.set(0, 0, -6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -48, right: 48, top: 48, bottom: -48, near: 1, far: 240 });
  sun.shadow.bias = -.00018;
  sun.shadow.normalBias = .065;
  group.add(sun, sun.target);
  group.add(new THREE.HemisphereLight(0xc3dcf1, 0x72724b, .8));
  let lastShadow = -Infinity;
  const forward = new THREE.Vector3(), focus = new THREE.Vector3();
  return {
    direction,
    update(t: number) {
      // Shadows move with foliage, at a lower cadence than camera rendering.
      if (t - lastShadow > .18) {
        camera.getWorldDirection(forward);
        const reach = camera.position.y > 20 && forward.y < -.08
          ? THREE.MathUtils.clamp(-camera.position.y / forward.y, 28, 300) : 28;
        focus.set(Math.round((camera.position.x + forward.x * reach) / 2) * 2, 0,
          Math.round((camera.position.z + forward.z * reach) / 2) * 2);
        sun.target.position.copy(focus);
        sun.position.copy(focus).addScaledVector(direction, 260);
        const span = THREE.MathUtils.clamp(camera.position.y * 1.35, 48, 160);
        Object.assign(sun.shadow.camera, { left: -span, right: span, top: span, bottom: -span, far: 600 });
        sun.shadow.camera.updateProjectionMatrix();
        renderer.shadowMap.needsUpdate = true;
        lastShadow = t;
      }
    },
    dispose() {
      environment.dispose();
      sun.shadow.dispose();
      scene.environment = previous.environment;
      scene.environmentIntensity = previous.environmentIntensity;
      renderer.toneMapping = previous.toneMapping;
      renderer.toneMappingExposure = previous.exposure;
      renderer.shadowMap.enabled = previous.shadows;
      renderer.shadowMap.type = previous.shadowType;
      renderer.shadowMap.autoUpdate = previous.autoShadow;
    },
  };
}
