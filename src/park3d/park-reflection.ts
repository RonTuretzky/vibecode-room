import type * as THREE from "three";

/** Match the drawing buffer's aspect at bounded resolution. A fixed 768²
 * mirror undersampled skyline edges on Retina displays. Quantization avoids
 * reallocating for every pixel while a window is being resized. */
export function parkReflectionSize(width: number, height: number) {
  const longest = Math.max(1, width, height);
  const side = Math.max(128, Math.min(1536, Math.round(longest * .75 / 64) * 64));
  const size = (n: number) => Math.max(128, Math.round(n / longest * side / 8) * 8);
  return { width: size(width), height: size(height) };
}

/** Keep the same cached target; resize only after a new size has settled. */
export class ParkReflectionQuality {
  private inputWidth = 0;
  private inputHeight = 0;
  private desiredWidth = 0;
  private desiredHeight = 0;
  private pendingSince = 0;
  private initialized = false;
  constructor(private target: THREE.RenderTarget, maxSamples: number) {
    const samples = Math.min(4, maxSamples);
    if (target.samples !== samples) { target.samples = samples; target.dispose(); }
  }
  update(width: number, height: number, nowMs: number): boolean {
    if (width <= 0 || height <= 0) return false;
    if (width !== this.inputWidth || height !== this.inputHeight) {
      const size = parkReflectionSize(width, height);
      this.inputWidth = width; this.inputHeight = height;
      if (size.width !== this.desiredWidth || size.height !== this.desiredHeight) {
        this.desiredWidth = size.width; this.desiredHeight = size.height; this.pendingSince = nowMs;
      }
    }
    if (this.target.width === this.desiredWidth && this.target.height === this.desiredHeight) {
      this.initialized = true; return false;
    }
    if (this.initialized && nowMs - this.pendingSince < 250) return false;
    this.target.setSize(this.desiredWidth, this.desiredHeight);
    this.initialized = true; return true;
  }
}

/** Refresh at full rate while navigating; reuse the reflection between
 * 30 Hz updates at rest. Water ripples are animated in the main shader. */
export class ParkReflectionSchedule {
  private lastAt = -Infinity;
  private world: number[] = [];
  private projection: number[] = [];

  shouldRender(nowMs: number, camera: Pick<THREE.Camera, "matrixWorld" | "projectionMatrix">): boolean {
    const world = camera.matrixWorld.elements, projection = camera.projectionMatrix.elements;
    const moved = world.some((n, i) => this.world[i] === undefined || Math.abs(n - this.world[i]!) > .0001)
      || projection.some((n, i) => this.projection[i] === undefined || n !== this.projection[i]);
    if (!moved && nowMs - this.lastAt < 1000 / 30) return false;
    this.world = world.slice(); this.projection = projection.slice(); this.lastAt = nowMs;
    return true;
  }
}
