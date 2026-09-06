import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Six-foot 1939 World's Fair bench, proportioned from the manufacturer's
// 6737-6 drawing. The ornamental casting remains an interpretation.
export const BENCH_FRAME_X = .838, BENCH_FOOT_Z = .284;
export const BENCH_FOOT_WIDTH = .064, BENCH_FOOT_DEPTH = .089;
export const BENCH_FOOTPRINT = { halfWidth: .93, back: -.40, front: .36 };

function merge(parts: THREE.BufferGeometry[]) {
  const geometry = mergeGeometries(parts)!;
  parts.forEach(part => part.dispose());
  return geometry;
}

/** Small bevels carry real edge highlights instead of perfectly sharp boxes. */
function roundedSlat(w: number, h: number, d: number, index: number) {
  const b = .003, shape = new THREE.Shape();
  shape.moveTo(-w / 2 + b, -h / 2 + b); shape.lineTo(w / 2 - b, -h / 2 + b);
  shape.lineTo(w / 2 - b, h / 2 - b); shape.lineTo(-w / 2 + b, h / 2 - b); shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: d - b * 2, steps: 1,
    bevelEnabled: true, bevelSize: b, bevelThickness: b, bevelSegments: 1 });
  g.translate(0, 0, -d / 2 + b);
  const p = g.getAttribute('position'), uv = g.getAttribute('uv');
  const colors = new Float32Array(p.count * 3), tone = .95 + (index * .618 % 1) * .1;
  for (let i = 0; i < p.count; i++) {
    uv.setXY(i, p.getX(i) / 1.8288 + .5, (p.getY(i) + p.getZ(i)) * 3.2 + index * .271);
    colors.set([tone, tone, tone], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

function bar(points: number[][], radius: number, segments = 10) {
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(p[0], p[1], p[2]))), segments, radius, 6, false);
}

function beam(a: THREE.Vector3, b: THREE.Vector3, width: number, depth: number) {
  const g = new THREE.BoxGeometry(width, a.distanceTo(b), depth);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize()));
  return g.translate(...a.clone().add(b).multiplyScalar(.5).toArray());
}

function lathe(profile: number[][], segments = 24, fluted = false) {
  const g = new THREE.LatheGeometry(profile.map(p => new THREE.Vector2(p[0], p[1])), segments);
  if (fluted) {
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i), r = Math.hypot(p.getX(i), p.getZ(i));
      const amplitude = y > .20 && y < .97 ? .009 : y > 3.53 && y < 3.73 ? .004 : 0;
      if (!amplitude || r === 0) continue;
      const scale = (r - amplitude * (.5 + .5 * Math.cos(Math.atan2(p.getX(i), p.getZ(i)) * 8))) / r;
      p.setXYZ(i, p.getX(i) * scale, y, p.getZ(i) * scale);
    }
    g.computeVertexNormals();
  }
  return g;
}

export function parkFurnitureGeometry() {
  const wood: THREE.BufferGeometry[] = [], frame: THREE.BufferGeometry[] = [], hardware: THREE.BufferGeometry[] = [];
  function bolt(x: number, y: number, z: number, tilt: number) {
    const g = new THREE.SphereGeometry(.0065, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2);
    g.scale(1, .45, 1); g.rotateX(tilt); g.translate(x, y, z); hardware.push(g);
  }
  for (let i = 0; i < 6; i++) {
    const z = -.212 + i * .077, t = (z + .05) / .27, y = .385 + .055 * t * t;
    const angle = -Math.atan(.11 * (z + .05) / (.27 * .27));
    wood.push(roundedSlat(1.8288, .03175, .0635, i).rotateX(angle).translate(0, y, z));
    for (const x of [-BENCH_FRAME_X, BENCH_FRAME_X]) for (const offset of [-.0254, .0254])
      bolt(x + offset, y + .016 * Math.cos(angle), z + .016 * Math.sin(angle), angle);
  }
  for (let i = 0; i < 3; i++) {
    const y = .59 + i * .116, z = -.27 - i * .036;
    wood.push(roundedSlat(1.8288, .0635, .03175, i + 6).rotateX(-.30).translate(0, y, z));
    for (const x of [-BENCH_FRAME_X, BENCH_FRAME_X]) for (const offset of [-.0254, .0254])
      bolt(x + offset, y + .0047, z + .016, Math.PI / 2 - .30);
  }
  for (const x of [-BENCH_FRAME_X, BENCH_FRAME_X]) {
    // Circular armrest and two arched legs form the characteristic open side.
    frame.push(new THREE.TorusGeometry(.205, .014, 6, 32).rotateY(Math.PI / 2).translate(x, .463, .006));
    for (const side of [-1, 1]) {
      frame.push(bar([[x, .01, side * BENCH_FOOT_Z], [x, .12, side * .245], [x, .235, side * .12], [x, .265, 0]], .021));
    }
    frame.push(bar([[x, .02, -.284], [x, .34, -.23], [x, .59, -.30], [x, .845, -.376]], .017));
    frame.push(bar([[x, .407, -.252], [x, .366, -.10], [x, .375, .055], [x, .42, .22], [x, .414, .292]], .018));
    frame.push(new THREE.CylinderGeometry(.039, .039, .025, 12).rotateZ(Math.PI / 2).translate(x, .27, 0));
    for (let petal = 0; petal < 6; petal++) {
      const angle = petal * Math.PI / 3;
      frame.push(new THREE.SphereGeometry(.012, 6, 4).scale(.8, 1, 1)
        .translate(x + Math.sign(x) * .016, .27 + Math.sin(angle) * .025, Math.cos(angle) * .025));
    }
  }
  frame.push(beam(new THREE.Vector3(-BENCH_FRAME_X, .27, 0), new THREE.Vector3(BENCH_FRAME_X, .27, 0), .016, .016));
  for (const side of [-1, 1]) frame.push(beam(new THREE.Vector3(-.82, .565 + (side > 0 ? .24 : 0), -.30 - (side > 0 ? .072 : 0)),
    new THREE.Vector3(.82, .565 + (side < 0 ? .24 : 0), -.30 - (side < 0 ? .072 : 0)), .022, .005));

  // Type B: a fluted pedestal, narrow shaft, molded capital and vase-shaped
  // lantern. 3.81 m reaches the base of the luminaire in the DOT reference.
  const lamp: THREE.BufferGeometry[] = [lathe([[0, 0], [.20, 0], [.20, .055], [.18, .065], [.18, .105], [.145, .13],
    [.124, .18], [.12, .22], [.12, .96], [.124, 1.00], [.12, 1.06], [.095, 1.10], [.068, 1.17],
    [.06, 1.24], [.044, 1.28], [.044, 3.46], [.058, 3.47], [.063, 3.50], [.057, 3.53],
    [.088, 3.71], [.105, 3.74], [.112, 3.78], [.14, 3.79], [.14, 3.82], [0, 3.82]], 32, true),
    lathe([[0, 4.20], [.226, 4.20], [.232, 4.225], [.224, 4.25], [.198, 4.26], [.163, 4.31],
      [.154, 4.34], [.10, 4.35], [.083, 4.42], [.045, 4.43], [.043, 4.46], [.026, 4.47], [0, 4.50]])];
  for (let i = 0; i < 4; i++) {
    const angle = i * Math.PI / 2, sx = Math.sin(angle), sz = Math.cos(angle);
    lamp.push(bar([[sx * .13, 3.81, sz * .13], [sx * .18, 3.93, sz * .18],
      [sx * .208, 4.08, sz * .208], [sx * .216, 4.21, sz * .216]], .012, 6));
  }
  lamp.push(new THREE.SphereGeometry(.027, 10, 6).scale(1, 1.4, 1).translate(0, 4.52, 0));
  const glass = lathe([[.115, 3.82], [.146, 3.86], [.172, 3.93], [.193, 4.02], [.207, 4.12], [.21, 4.20]]);
  return { benchWood: merge(wood), benchMetal: merge(frame), benchHardware: merge(hardware), lampMetal: merge(lamp), lampGlass: glass };
}
