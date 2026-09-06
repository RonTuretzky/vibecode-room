import type * as THREE from "three";

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
