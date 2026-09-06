import * as THREE from 'three';
import { mulberry32 } from '../ui/tree/spec';
import { groundNoise, parkGroundColor } from './park-ground';

export interface TurfSource {
  groundAt: (x: number, z: number) => number;
  waterAt: (x: number, z: number) => number;
  lawnAt: (x: number, z: number) => number;
  canopyAt: (x: number, z: number) => number;
  canPlant: (x: number, z: number, clearance: number) => boolean;
}
// Spend detail on the ground beside the viewer: four times the density in
// a smaller neighbourhood, with a fixed 25-tile / 102,400-tuft ceiling.
const TILE = 8, GRID = 64, CAPACITY = GRID * GRID, RADIUS = 2;
export interface TurfBladePatch { x: number; y: number; z: number; height: number; angle: number; lawn: number; canopy: number }

/** Coordinate-seeded cells retain the same blades when revisited. The
 * short turf stops at paths, structures, wet margins and exposed steep rock. */
export function turfTile(source: TurfSource, tx: number, tz: number): TurfBladePatch[] {
  const rng = mulberry32((Math.imul(tx, 73856093) ^ Math.imul(tz, 19349663) ^ 0x54555246) >>> 0);
  const patches: TurfBladePatch[] = [];
  for (let iz = 0; iz < GRID; iz++) for (let ix = 0; ix < GRID; ix++) {
    const x = (tx + (ix + .12 + rng() * .76) / GRID) * TILE;
    const z = (tz + (iz + .12 + rng() * .76) / GRID) * TILE;
    const pick = rng(), variation = rng(), angle = rng() * Math.PI * 2;
    if (!source.canPlant(x, z, .18) || source.waterAt(x, z) > .12) continue;
    const lawn = source.lawnAt(x, z), canopy = source.canopyAt(x, z);
    const wooded = THREE.MathUtils.smoothstep(canopy, 2, 10) * (1 - lawn);
    const patch = groundNoise(x + 67, z - 182, 5);
    if (pick > (.78 + patch * .2) * (1 - wooded * .78)) continue;
    const y = source.groundAt(x, z);
    const dx = (source.groundAt(x + .15, z) - y) / .15;
    const dz = (source.groundAt(x, z + .15) - y) / .15;
    if (!Number.isFinite(y + dx + dz) || Math.hypot(dx, dz) > 1.1) continue;
    patches.push({ x, y, z, height: (.045 + variation * .065) * (1 + wooded * .6), angle, lawn, canopy });
  }
  return patches;
}

/** Five bent, tapered blades: fifteen solid triangles, no alpha overdraw. */
export function turfGeometry(): THREE.BufferGeometry {
  const positions: number[] = [], colors: number[] = [], indices: number[] = [];
  for (let blade = 0; blade < 5; blade++) {
    const angle = blade * 2.39996, c = Math.cos(angle), s = Math.sin(angle), start = positions.length / 3;
    for (const [t, side] of [[0, -1], [0, 1], [.58, -1], [.58, 1], [1, 0]]) {
      const lean = t! * t! * .30, width = .035 * (1 - t! * .65) * side!;
      positions.push(c * lean - s * width + c * .38, t!, s * lean + c * width + s * .38);
      const brightness = .58 + t! * .58;
      colors.push(brightness, brightness, brightness * .96);
    }
    indices.push(start, start + 2, start + 3, start, start + 3, start + 1, start + 2, start + 4, start + 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices); geometry.computeVertexNormals(); geometry.computeBoundingSphere();
  return geometry;
}

/** A fixed-size pool follows the eye instead of storing millions of blades
 * over the park. Recycled tile buffers never grow with distance travelled. */
export function createParkTurf(source: TurfSource, coordinates: {
  toRoom: (x: number, y: number, z: number) => THREE.Vector3;
  toPark: (x: number, z: number) => { x: number; z: number };
}) {
  const group = new THREE.Group(); group.name = 'park-close-turf';
  const geometry = turfGeometry();
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: .96 });
  const windTime = { value: 0 }, visibility = { value: 1 };
  material.onBeforeCompile = shader => {
    const anchor = '#include <begin_vertex>';
    if (!shader.vertexShader.includes(anchor)) throw new Error('Three turf shader changed');
    shader.uniforms.parkTurfTime = windTime; shader.uniforms.parkTurfVisibility = visibility;
    shader.vertexShader = 'uniform float parkTurfTime; uniform float parkTurfVisibility;\n' + shader.vertexShader.replace(anchor, `${anchor}
      vec3 turfRoot = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
      float turfFade = (1.0 - smoothstep(10.0, 16.0, distance(turfRoot.xz, cameraPosition.xz))) * parkTurfVisibility;
      transformed.y *= turfFade;
      transformed.xz += vec2(.10, .055) * position.y * position.y * turfFade
        * sin(parkTurfTime * 1.3 + turfRoot.x * .67 + turfRoot.z * .43);
    `);
    const physical = THREE.ShaderChunk.lights_physical_pars_fragment.replace(
      'reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution );',
      `float bladeCosine = dot(geometryNormal, directLight.direction);
       float bladeDiffuse = max(0.0, (bladeCosine + .2) / 1.2) * .86 + max(0.0, -bladeCosine) * .12;
       reflectedLight.directDiffuse += bladeDiffuse * directLight.color * BRDF_Lambert(material.diffuseContribution);`,
    );
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_physical_pars_fragment>', physical);
  };
  material.customProgramCacheKey = () => 'park-close-turf-v2';
  const active = new Map<string, THREE.InstancedMesh>(), pool: THREE.InstancedMesh[] = [], all: THREE.InstancedMesh[] = [];
  let pending: { key: string; x: number; z: number }[] = [], previousCell = '', disposed = false, lastTime: number | null = null;
  const dummy = new THREE.Object3D(), color = new THREE.Color();
  const fill = (mesh: THREE.InstancedMesh, tx: number, tz: number) => {
    const plants = turfTile(source, tx, tz);
    plants.forEach((p, i) => {
      dummy.position.copy(coordinates.toRoom(p.x, p.y - .018, p.z));
      dummy.rotation.y = p.angle; dummy.scale.setScalar(p.height); dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      parkGroundColor(p.x, p.z, p.lawn, p.canopy, 0, true, color).multiplyScalar(1.08);
      mesh.setColorAt(i, color);
    });
    mesh.count = plants.length; mesh.visible = plants.length > 0;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    if (plants.length) mesh.computeBoundingSphere();
  };
  return { group,
    update(camera: THREE.Camera, groundY: number, time: number, motion: boolean) {
      if (disposed) return;
      if (motion && lastTime !== null) windTime.value += Math.max(0, Math.min(.1, time - lastTime));
      lastTime = time;
      visibility.value = 1 - THREE.MathUtils.smoothstep(camera.position.y - groundY, 10, 18);
      group.visible = visibility.value > 0;
      if (!group.visible) { group.userData.instances = 0; return; }
      const p = coordinates.toPark(camera.position.x, camera.position.z);
      const cx = Math.floor(p.x / TILE), cz = Math.floor(p.z / TILE), cell = `${cx},${cz}`;
      if (cell !== previousCell) {
        previousCell = cell;
        const wanted = new Map<string, { key: string; x: number; z: number }>();
        for (let z = cz - RADIUS; z <= cz + RADIUS; z++) for (let x = cx - RADIUS; x <= cx + RADIUS; x++) {
          const key = `${x},${z}`; wanted.set(key, { key, x, z });
        }
        for (const [key, mesh] of active) if (!wanted.has(key)) {
          mesh.visible = false; pool.push(mesh); active.delete(key);
        }
        pending = [...wanted.values()].filter(t => !active.has(t.key))
          .sort((a, b) => (a.x - cx) ** 2 + (a.z - cz) ** 2 - (b.x - cx) ** 2 - (b.z - cz) ** 2);
      }
      // One dense tile uses the previous four-tile sampling budget. Populate
      // the viewer's immediate ground first, then fill the fading outskirts.
      if (pending.length) {
        const tile = pending.shift()!;
        let mesh = pool.pop();
        if (!mesh) {
          mesh = new THREE.InstancedMesh(geometry, material, CAPACITY);
          mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
          mesh.receiveShadow = true; mesh.userData.parkReflect = false;
          group.add(mesh); all.push(mesh);
        }
        fill(mesh, tile.x, tile.z); active.set(tile.key, mesh);
      }
      let instances = 0;
      for (const mesh of active.values()) instances += mesh.count;
      group.userData.instances = instances;
    },
    get allocatedTiles() { return all.length; },
    dispose() {
      if (disposed) return;
      disposed = true; group.removeFromParent(); all.forEach(m => m.dispose());
      geometry.dispose(); material.dispose(); active.clear(); pool.length = 0; pending.length = 0;
    },
  };
}
