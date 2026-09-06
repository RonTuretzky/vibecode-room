import * as THREE from 'three';
import { mulberry32 } from '../ui/tree/spec';

let cloudField: THREE.DataTexture | null = null;

// A periodic density field avoids expensive per-fragment noise, and has no
// panorama seam. The one shared 512² texture persists across park rebuilds.
function cloudTexture() {
  if (cloudField) return cloudField;
  const size = 512, field = new Float32Array(size * size), rng = mulberry32(0x434c4f55);
  let amplitude = .52, weight = 0;
  for (let cells = 4; cells <= 128; cells *= 2) {
    const grid = Float32Array.from({ length: cells * cells }, () => rng());
    for (let y = 0; y < size; y++) {
      const gy = y * cells / size, iy = Math.floor(gy), fy = gy - iy;
      const sy = fy * fy * (3 - 2 * fy);
      for (let x = 0; x < size; x++) {
        const gx = x * cells / size, ix = Math.floor(gx), fx = gx - ix;
        const sx = fx * fx * (3 - 2 * fx);
        const a = grid[iy * cells + ix]!, b = grid[iy * cells + (ix + 1) % cells]!;
        const c = grid[((iy + 1) % cells) * cells + ix]!, d = grid[((iy + 1) % cells) * cells + (ix + 1) % cells]!;
        field[y * size + x] += amplitude * ((a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy);
      }
    }
    weight += amplitude; amplitude *= .52;
  }
  const pixels = new Uint8Array(size * size);
  for (let i = 0; i < field.length; i++) {
    pixels[i] = Math.round(field[i]! / weight * 255);
  }
  cloudField = new THREE.DataTexture(pixels, size, size, THREE.RedFormat);
  cloudField.name = 'park-cloud-density';
  cloudField.wrapS = cloudField.wrapT = THREE.RepeatWrapping;
  cloudField.magFilter = THREE.LinearFilter;
  cloudField.minFilter = THREE.LinearMipmapLinearFilter;
  cloudField.generateMipmaps = true;
  cloudField.needsUpdate = true;
  return cloudField;
}

/** Static fair-weather cloud lighting in the existing physical sky draw. */
export function addParkClouds(material: THREE.ShaderMaterial) {
  const start = material.fragmentShader.indexOf('\t\t\t// Clouds\n');
  const end = material.fragmentShader.indexOf('\t\t\tgl_FragColor', start);
  if (start < 0 || end < 0) throw new Error('Park clouds require the Three Sky cloud blend section');
  material.uniforms.parkCloudField = { value: cloudTexture() };
  material.fragmentShader = 'uniform sampler2D parkCloudField;\n' + material.fragmentShader.slice(0, start) + /* glsl */`
      // World-anchored cloud deck. Horizon fading and mip filtering prevent
      // high-frequency noise at grazing angles. No animation/extra render pass.
      if (direction.y > .012) {
        float cloudHeight = max(200.0, 1800.0 - cameraPosition.y);
        vec2 cloudUV = (cameraPosition.xz + direction.xz * cloudHeight / max(.018, direction.y)) / 12000.0 + vec2(.17, .39);
        float body = texture2D(parkCloudField, cloudUV).r;
        float detail = texture2D(parkCloudField, cloudUV * 3.0 + vec2(.31, .73)).r;
        float density = smoothstep(.50, .66, body + (detail - .5) * .26);
        float sunward = texture2D(parkCloudField, cloudUV + vSunDirection.xz * .018).r;
        float edgeLight = clamp(.54 + (body - sunward) * 6.0, 0.0, 1.0);
        vec3 cloudLight = mix(vec3(.50, .59, .70), vec3(2.35, 2.24, 2.05), edgeLight);
        // Dense portions reveal cool undersides; thin edges retain warm light.
        cloudLight *= 1.0 - density * .18;
        float opacity = (1.0 - exp(-density * 3.2)) * smoothstep(.012, .14, direction.y);
        cloudLight = mix(texColor, cloudLight, smoothstep(.015, .22, direction.y));
        texColor = mix(texColor, cloudLight, opacity);
      }
` + material.fragmentShader.slice(end);
  material.needsUpdate = true;
}
