import * as THREE from 'three';

/** Mineral grain on steep banks and small leaf fragments under woodland.
 * Uses the terrain's existing draw/material, with no extra texture or pass.
 * Layers are illustrative ground cover, not a geological survey. */
export function refineParkGround(material: THREE.MeshStandardMaterial): void {
  material.onBeforeCompile = shader => {
    const vertex = '#include <begin_vertex>', fragment = '#include <color_fragment>';
    if (!shader.vertexShader.includes(vertex) || !shader.fragmentShader.includes(fragment)) throw new Error('Three ground shader changed');
    shader.vertexShader = 'attribute vec2 parkGroundLayers; varying vec2 vParkGroundLayers; varying vec3 vParkGroundPosition;\n' + shader.vertexShader
      .replace(vertex, `${vertex}\nvParkGroundLayers = parkGroundLayers; vParkGroundPosition = position;`);
    shader.fragmentShader = `
      varying vec2 vParkGroundLayers;
      varying vec3 vParkGroundPosition;
      float parkGroundHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float parkGroundNoise(vec2 p) {
        vec2 cell = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(parkGroundHash(cell), parkGroundHash(cell + vec2(1,0)), f.x),
                   mix(parkGroundHash(cell + vec2(0,1)), parkGroundHash(cell + vec2(1,1)), f.x), f.y);
      }
      ` + shader.fragmentShader.replace(fragment, `${fragment}
      vec3 gp = vParkGroundPosition;
      vec2 grainUV = gp.xz + vec2(gp.y * .6, -gp.y * .3);
      float mineral = parkGroundNoise(grainUV * 1.8);
      float folds = sin(gp.y * 7.0 + gp.x * .6 + parkGroundNoise(grainUV * .35) * 4.0) * .025;
      vec3 stone = vec3(.195, .191, .166) * (.80 + mineral * .40 + folds);
      float rockCover = vParkGroundLayers.x * smoothstep(.12, .68, parkGroundNoise(grainUV * .46));
      diffuseColor.rgb = mix(diffuseColor.rgb, stone, rockCover * .85);
      // Each quarter-metre cell can contain a rotated, irregular leaf.
      // Coverage fades when subpixel, avoiding shimmer in distant woodland.
      vec2 leafUV = gp.xz * 4.0, cell = floor(leafUV);
      float seed = parkGroundHash(cell), angle = seed * 6.2831853;
      vec2 leaf = fract(leafUV) - vec2(.28 + seed * .44, .25 + parkGroundHash(cell + 19.0) * .50);
      leaf = mat2(cos(angle), -sin(angle), sin(angle), cos(angle)) * leaf;
      float contour = length(leaf / vec2(.32, .13)) + sin(leaf.x * 32.0) * .07;
      float coverage = (1.0 - smoothstep(.75, 1.05, contour)) * smoothstep(.3, .5, seed);
      float detail = 1.0 - smoothstep(.25, .8, max(fwidth(leafUV.x), fwidth(leafUV.y)));
      vec3 leafColor = mix(vec3(.13, .105, .065), vec3(.24, .19, .11), seed);
      diffuseColor.rgb = mix(diffuseColor.rgb, leafColor, coverage * detail * vParkGroundLayers.y * .65);
      `);
  };
  material.customProgramCacheKey = () => 'park-ground-cover-v1';
  material.needsUpdate = true;
}
