import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

/** Slatted park benches and acorn lamps, with shared geometry and owned cleanup. */
export function createParkFurniture(lamps: THREE.Matrix4[], benches: THREE.Matrix4[]) {
  const group = new THREE.Group();
  group.name = "park-street-furniture";
  const iron = new THREE.MeshStandardMaterial({ color: 0x263b30, roughness: .67, metalness: .45 });
  const wood = new THREE.MeshStandardMaterial({ color: 0x786044, roughness: .88 });
  const glass = new THREE.MeshStandardMaterial({ color: 0xf0e4bf, roughness: .28, emissive: 0xffdf9c, emissiveIntensity: .2 });
  const geometries: THREE.BufferGeometry[] = [];
  function cylinder(top: number, bottom: number, height: number, y: number) {
    const geo = new THREE.CylinderGeometry(top, bottom, height, 12);
    return geo.translate(0, y, 0);
  }
  function box(w: number, h: number, d: number, x: number, y: number, z: number) {
    return new THREE.BoxGeometry(w, h, d).translate(x, y, z);
  }
  function batch(parts: THREE.BufferGeometry[], material: THREE.Material, matrices: THREE.Matrix4[]) {
    const geometry = mergeGeometries(parts)!;
    parts.forEach(part => part.dispose());
    geometries.push(geometry);
    if (!matrices.length) return;
    const mesh = new THREE.InstancedMesh(geometry, material, matrices.length);
    matrices.forEach((matrix, i) => mesh.setMatrixAt(i, matrix));
    mesh.computeBoundingSphere();
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
  }
  const lampMetal: THREE.BufferGeometry[] = [cylinder(.15, .22, .14, .07), cylinder(.075, .14, .5, .39),
    cylinder(.043, .075, 2.8, 1.98), cylinder(.12, .09, .14, 3.42),
    cylinder(.18, .2, .08, 3.51), cylinder(.035, .21, .14, 3.99), cylinder(0, .045, .12, 4.12)];
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI / 2;
    lampMetal.push(box(.018, .4, .018, Math.cos(a) * .17, 3.73, Math.sin(a) * .17));
  }
  batch(lampMetal, iron, lamps);
  const globe = new THREE.SphereGeometry(.19, 12, 10).scale(1, 1.25, 1).translate(0, 3.73, 0);
  batch([globe], glass, lamps);
  const slats: THREE.BufferGeometry[] = [], frame: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 5; i++) slats.push(box(1.9, .055, .085, 0, .46, -.22 + i * .105));
  for (let i = 0; i < 4; i++) slats.push(box(1.9, .075, .045, 0, .64 + i * .1, -.27 - i * .012));
  for (const side of [-1, 1]) {
    const x = side * .72;
    for (const z of [-.2, .2]) frame.push(box(.055, .42, .055, x, .21, z));
    frame.push(box(.065, .05, .57, x, .41, 0));
    frame.push(box(.05, .56, .05, x, .72, -.3));
    frame.push(box(.055, .05, .48, x, .69, 0));
    frame.push(box(.045, .22, .045, x, .57, .19));
  }
  frame.push(box(1.5, .045, .045, 0, .22, -.2));
  batch(slats, wood, benches);
  batch(frame, iron, benches);
  return { group, dispose() {
    group.removeFromParent();
    group.traverse(node => { if (node instanceof THREE.InstancedMesh) node.dispose(); });
    geometries.forEach(geometry => geometry.dispose());
    iron.dispose(); wood.dispose(); glass.dispose();
  } };
}
