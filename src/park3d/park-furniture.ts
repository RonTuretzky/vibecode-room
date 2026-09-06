import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { BENCH_FOOT_DEPTH, BENCH_FOOT_WIDTH, BENCH_FOOT_Z, BENCH_FRAME_X, parkFurnitureGeometry } from './park-furniture-geometry';
import { parkFurnitureMaterials } from './park-furniture-materials';

/** World's Fair-style benches and Type B-style lamps, with owned cleanup. */
export function createParkFurniture(
  lampPlacements: THREE.Matrix4[], benchPlacements: THREE.Matrix4[],
  groundAt: (x: number, z: number) => number,
) {
  const group = new THREE.Group();
  group.name = "park-street-furniture";
  const { iron, wood, glass, hardware } = parkFurnitureMaterials();
  const geometries: THREE.BufferGeometry[] = [];
  const supports: THREE.BufferGeometry[] = [];
  const point = new THREE.Vector3();
  // Keep seats and posts level; fit their footings to the actual rendered
  // terrain. Sampling each footprint also handles benches rotated on slopes.
  function fit(placement: THREE.Matrix4, feet: THREE.BufferGeometry[], separatePlates = false) {
    const matrix = placement.clone();
    let highest = -Infinity;
    for (const foot of feet) {
      const p = foot.getAttribute('position');
      for (let i = 0; i < p.count; i++) {
        point.fromBufferAttribute(p, i).applyMatrix4(matrix);
        highest = Math.max(highest, groundAt(point.x, point.z));
      }
    }
    matrix.elements[13] = highest - .015;
    for (const foot of feet) {
      const p = foot.getAttribute('position');
      let plateHeight = -Infinity;
      if (separatePlates) {
        for (let i = 0; i < p.count; i++) {
          point.fromBufferAttribute(p, i).applyMatrix4(matrix);
          plateHeight = Math.max(plateHeight, groundAt(point.x, point.z));
        }
        foot.computeBoundingBox();
        const center = foot.boundingBox!.getCenter(new THREE.Vector3());
        const stem = new THREE.CylinderGeometry(.020, .020, .05, 8).translate(center.x, 0, center.z);
        const sp = stem.getAttribute('position');
        for (let i = 0; i < sp.count; i++) {
          const bottom = sp.getY(i) < 0;
          point.fromBufferAttribute(sp, i).applyMatrix4(matrix);
          if (bottom) point.y = plateHeight - .012;
          sp.setXYZ(i, point.x, point.y, point.z);
        }
        stem.computeVertexNormals(); supports.push(stem);
      }
      for (let i = 0; i < p.count; i++) {
        const bottom = p.getY(i) < 0;
        point.fromBufferAttribute(p, i).applyMatrix4(matrix);
        // Bury the bottom slightly to avoid a light leak along the grade.
        if (bottom) point.y = groundAt(point.x, point.z) - (separatePlates ? .025 : .035);
        else if (separatePlates) point.y = plateHeight + .007;
        p.setXYZ(i, point.x, point.y, point.z);
      }
      foot.computeVertexNormals();
      supports.push(foot);
    }
    return matrix;
  }
  const lamps = lampPlacements.map(matrix => fit(matrix, [new THREE.CylinderGeometry(.197, .197, .05, 24)]));
  const benches = benchPlacements.map(matrix => fit(matrix,
    [-BENCH_FRAME_X, BENCH_FRAME_X].flatMap(x => [-BENCH_FOOT_Z, BENCH_FOOT_Z]
      .map(z => new THREE.BoxGeometry(BENCH_FOOT_WIDTH, .05, BENCH_FOOT_DEPTH).translate(x, 0, z))), true));
  function batch(geometry: THREE.BufferGeometry, material: THREE.Material, matrices: THREE.Matrix4[], name: string) {
    geometries.push(geometry);
    if (!matrices.length) return;
    const mesh = new THREE.InstancedMesh(geometry, material, matrices.length);
    mesh.name = name;
    matrices.forEach((matrix, i) => mesh.setMatrixAt(i, matrix));
    mesh.computeBoundingSphere();
    mesh.castShadow = material !== glass;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  const models = parkFurnitureGeometry();
  batch(models.lampMetal, iron, lamps, 'park-lamp-castings');
  batch(models.lampGlass, glass, lamps, 'park-lamp-glazing');
  batch(models.benchWood, wood, benches, 'park-bench-slats');
  batch(models.benchMetal, iron, benches, 'park-bench-castings');
  batch(models.benchHardware, hardware, benches, 'park-bench-bolts');
  if (supports.length) {
    const geometry = mergeGeometries(supports)!;
    supports.forEach(part => part.dispose());
    geometries.push(geometry);
    const mesh = new THREE.Mesh(geometry, iron);
    mesh.name = 'park-furniture-footings';
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
  }
  return { group, dispose() {
    group.removeFromParent();
    group.traverse(node => { if (node instanceof THREE.InstancedMesh) node.dispose(); });
    geometries.forEach(geometry => geometry.dispose());
    iron.dispose(); wood.dispose(); glass.dispose(); hardware.dispose();
  } };
}
