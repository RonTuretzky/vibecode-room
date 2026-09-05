import * as THREE from "three";


export function cssHex(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}


// Raw-sRGB color for the sky's hand-authored ShaderMaterials: THREE's color
// management converts hex to the linear working space, but a raw shader
// writes its output UNENCODED — authored hexes come out dark. Storing the raw
// sRGB bytes makes the shader output match the intended hex on screen.
export function rawColor(hex: number): THREE.Color {
  const color = new THREE.Color();
  color.setRGB(((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255, THREE.LinearSRGBColorSpace);
  return color;
}


// Canvas-texture label sprite: word-wrapped title over a rounded glass card,
// always on top, scaled to the true canvas aspect.
export function makeLabelSprite(title: string, statusLine: string, accentCss: string): THREE.Sprite {
  const dpr = 2;
  const maxWidth = 220;
  const padX = 13;
  const padY = 9;
  const titleFont = "600 13px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  const statusFont = "600 10px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

  const measure = document.createElement("canvas").getContext("2d")!;
  measure.font = titleFont;
  // Overflow guards: (1) clamp long titles to ~28 chars with an ellipsis —
  // the full title lives in the tree menu / hover card; (2) a single unbroken
  // word (repo names like "conductor-github-visualizer") can still measure
  // wider than the card, so every drawn line is measure-trimmed to fit.
  const titleMax = 28;
  const clamped = title.length > titleMax ? `${title.slice(0, titleMax - 1).trimEnd()}…` : title;
  const innerWidth = maxWidth - padX * 2;
  const fitLine = (line: string): string => {
    if (measure.measureText(line).width <= innerWidth) {
      return line;
    }
    let cut = line;
    while (cut.length > 1 && measure.measureText(`${cut}…`).width > innerWidth) {
      cut = cut.slice(0, -1);
    }
    return `${cut.trimEnd()}…`;
  };
  const words = clamped.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const attempt = current.length > 0 ? `${current} ${word}` : word;
    if (measure.measureText(attempt).width > innerWidth && current.length > 0) {
      lines.push(fitLine(current));
      current = word;
      if (lines.length === 3) {
        break;
      }
    } else {
      current = attempt;
    }
  }
  if (lines.length < 3 && current.length > 0) {
    lines.push(fitLine(current));
  } else if (current.length > 0) {
    lines[2] = fitLine(`${lines[2].slice(0, 26)}…`);
  }
  const widest = Math.max(...lines.map((line) => measure.measureText(line).width), measure.measureText(statusLine).width * 0.8);
  const width = Math.min(maxWidth, Math.ceil(widest) + padX * 2);
  const lineHeight = 17;
  const statusHeight = statusLine.length > 0 ? 15 : 0;
  const height = padY * 2 + lines.length * lineHeight + statusHeight;

  const canvas = document.createElement("canvas");
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);
  const paint = (status: string) => {
    ctx.clearRect(0, 0, width, height);
    ctx.beginPath();
    ctx.roundRect(0.5, 0.5, width - 1, height - 1, 9);
    ctx.fillStyle = "rgba(6, 16, 24, 0.78)";
    ctx.fill();
    ctx.strokeStyle = "rgba(158, 226, 255, 0.2)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.font = titleFont;
    ctx.fillStyle = "#eaf6ff";
    ctx.textBaseline = "top";
    lines.forEach((line, i) => ctx.fillText(line, padX, padY + i * lineHeight));
    if (status.length > 0) {
      ctx.font = statusFont;
      ctx.fillStyle = accentCss;
      ctx.fillText(status.toUpperCase(), padX, padY + lines.length * lineHeight + 2);
    }
  };
  paint(statusLine);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }));
  const worldScale = 1 / 56;
  sprite.scale.set(width * worldScale, height * worldScale, 1);
  sprite.center.set(0.5, 0);
  sprite.renderOrder = 12;
  // Status-only repaint hook (live progress ticks): redraw the SAME canvas and
  // re-upload it (needsUpdate) — no new texture/material/sprite allocation.
  // The card geometry is frozen at build width; a percent tick shifts the
  // status by a couple px at most, and any structural change (state, stage,
  // title, steering) rebuilds the whole label anyway.
  sprite.userData.updateStatus = (status: string) => {
    paint(status);
    texture.needsUpdate = true;
  };
  return sprite;
}


// Repaint an existing label sprite's status line in place (see the
// updateStatus hook above) — the sprite, material, canvas and texture persist.
export function updateLabelStatus(label: THREE.Sprite, status: string): void {
  (label.userData.updateStatus as ((status: string) => void) | undefined)?.(status);
}


// Soft radial glow texture (halos, moon, auroras) tinted via material color.
export function makeGlowTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, "rgba(255,255,255,0.85)");
  gradient.addColorStop(0.35, "rgba(255,255,255,0.28)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}


// Procedural butterfly wing for ONE side (forewing + hindwing lobes) painted
// with transparent surround: the plane it maps is alpha-tested, so this one
// canvas provides the two-lobed silhouette AND the pattern — dark basal
// suffusion, veins radiating from the root, a dark margin band with pale
// spots, and a hindwing eyespot. Texture space: u=0 body hinge → u=1 tip,
// v=1 (canvas top) is the head end. The base hue comes from the palette.
export function makeButterflyWingTexture(base: number): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const hsl = { h: 0, s: 0, l: 0 };
  new THREE.Color(base).getHSL(hsl);
  const tint = (dl: number, a: number): string => {
    const c = new THREE.Color().setHSL(hsl.h, hsl.s, THREE.MathUtils.clamp(hsl.l + dl, 0, 1));
    return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${a})`;
  };
  const dark = (a: number): string => `rgba(38,28,24,${a})`;
  // Silhouette: costal edge sweeping to the forewing apex, a shallow notch,
  // then the rounder hindwing lobe with a scalloped trailing edge.
  const trace = (): void => {
    ctx.beginPath();
    ctx.moveTo(4, 70);
    ctx.quadraticCurveTo(90, 10, 212, 30); // leading (costal) edge
    ctx.quadraticCurveTo(242, 46, 208, 100); // rounded apex → outer margin
    ctx.quadraticCurveTo(140, 96, 100, 116); // deep notch cutting between lobes
    ctx.quadraticCurveTo(206, 128, 180, 188); // hindwing outer bulge
    ctx.quadraticCurveTo(150, 234, 96, 238); // trailing scallop
    ctx.quadraticCurveTo(60, 240, 34, 218); // anal lobe
    ctx.quadraticCurveTo(12, 196, 4, 152); // back to the body line
    ctx.closePath();
  };
  // Base fill: lighter at the root, deepening slightly toward the margins.
  const shade = ctx.createRadialGradient(14, 120, 8, 14, 120, 250);
  shade.addColorStop(0, tint(0.1, 1));
  shade.addColorStop(0.55, tint(0, 1));
  shade.addColorStop(1, tint(-0.08, 1));
  trace();
  ctx.fillStyle = shade;
  ctx.fill();
  // Everything else clips to the silhouette so the alpha edge stays crisp.
  ctx.save();
  trace();
  ctx.clip();
  // Dark basal suffusion where the wing meets the body.
  const basal = ctx.createRadialGradient(6, 120, 0, 6, 120, 85);
  basal.addColorStop(0, dark(0.55));
  basal.addColorStop(1, dark(0));
  ctx.fillStyle = basal;
  ctx.fillRect(0, 0, size, size);
  // Veins radiating from the root across each lobe.
  ctx.strokeStyle = dark(0.4);
  ctx.lineWidth = 2.5;
  ctx.lineCap = "round";
  const vein = (x0: number, y0: number, x1: number, y1: number, bow: number): void => {
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.quadraticCurveTo((x0 + x1) / 2, (y0 + y1) / 2 + bow, x1, y1);
    ctx.stroke();
  };
  vein(12, 96, 222, 34, -16);
  vein(12, 98, 226, 62, -14);
  vein(12, 102, 204, 92, -8);
  vein(12, 106, 160, 102, -4);
  vein(12, 148, 190, 148, 6);
  vein(12, 152, 174, 184, 10);
  vein(12, 156, 132, 220, 12);
  vein(12, 160, 76, 230, 10);
  // Dark margin band around the whole outline (half the stroke lands
  // inside the clip), with a soft wide underlay.
  trace();
  ctx.strokeStyle = dark(0.25);
  ctx.lineWidth = 36;
  ctx.stroke();
  trace();
  ctx.strokeStyle = dark(0.92);
  ctx.lineWidth = 16;
  ctx.stroke();
  // Pale spots riding the dark margin near the apex + hindwing edge.
  ctx.fillStyle = "rgba(255,252,244,0.85)";
  for (const [x, y, r] of [[218, 44, 6], [212, 70, 5], [196, 90, 4.5], [172, 182, 3.5], [138, 218, 3.5]] as const) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // Hindwing eyespot: dark ring, pale iris, dark pupil, white glint.
  ctx.fillStyle = dark(0.95);
  ctx.beginPath();
  ctx.arc(148, 168, 14, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = tint(0.16, 1);
  ctx.beginPath();
  ctx.arc(148, 168, 9, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = dark(0.95);
  ctx.beginPath();
  ctx.arc(148, 168, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.beginPath();
  ctx.arc(145.5, 165.5, 1.8, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}


// Gradient sky dome (visualizer technique) with a 3-stop ramp for extra depth.
// NOTE: BackSide alone makes the sphere visible from inside — flipping the
// geometry with scale(-1,1,1) on top of it double-inverts the winding and the
// dome vanishes (the sky rendered as the black clear color for months).
// `rawSrgb` keeps the authored hexes as-is (see rawColor): the dome shader
// writes unencoded output, so converted colors render darker than authored —
// the orbit night wants that moody sink, the research dusk wants true color.
export function makeSkyDome(bottom: number, mid: number, top: number, rawSrgb = false): THREE.Mesh {
  const toColor = rawSrgb ? rawColor : (hex: number) => new THREE.Color(hex);
  const geom = new THREE.SphereGeometry(160, 32, 32);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      bottomColor: { value: toColor(bottom) },
      midColor: { value: toColor(mid) },
      topColor: { value: toColor(top) },
      offset: { value: 20 },
    },
    vertexShader: `
      varying vec3 vWorldPosition;
      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 bottomColor;
      uniform vec3 midColor;
      uniform vec3 topColor;
      uniform float offset;
      varying vec3 vWorldPosition;
      void main() {
        float h = clamp(normalize(vWorldPosition + offset).y, 0.0, 1.0);
        vec3 color = h < 0.35
          ? mix(bottomColor, midColor, smoothstep(0.0, 0.35, h))
          : mix(midColor, topColor, smoothstep(0.35, 1.0, h));
        // Screen-space dither: ±1 LSB of hash noise breaks the visible
        // banding rings a smooth 8-bit gradient otherwise develops.
        float dither = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
        gl_FragColor = vec4(color + dither * (1.5 / 255.0), 1.0);
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
  });
  return new THREE.Mesh(geom, mat);
}


export function makeStars(rng: () => number, count: number, size: number, opacity: number, fullDome: boolean): THREE.Points {
  const positions: number[] = [];
  for (let i = 0; i < count; i++) {
    const theta = rng() * Math.PI * 2;
    const phi = rng() * Math.PI * (fullDome ? 0.62 : 0.42) + 0.06;
    const r = 130;
    positions.push(r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta));
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  return new THREE.Points(geom, new THREE.PointsMaterial({ color: 0xdcecff, size, transparent: true, opacity, fog: false }));
}
