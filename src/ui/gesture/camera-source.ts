// Bridge between the 3D RoomScene and the pinch-camera layer.
//
// The scene owns the rig and ALL clamps; the pinch layer never touches three.js.
// It talks through this registry, mirroring the gesture-dwell seam in
// scene-source.ts.

export interface SceneCameraControl {
  // rad; world units (height clamped [1.4,30] inside).
  orbitBy(dYaw: number, dHeight: number): void;
  // Screen px; scene applies its 0.0045*radius pan feel.
  panBy(dxPx: number, dyPx: number): void;
  // dRadius *= scale, clamped [4,45] (wheel parity).
  zoomBy(scale: number): void;
  // rad/s, units/s -> existing inertia decay (release coast).
  flick(yawVel: number, heightVel: number): void;
  // true: tight 16/s rig lerp + zero residual mouse inertia.
  setTracking(on: boolean): void;
}

// One scene per window (each wall window is its own full app instance).
let current: SceneCameraControl | null = null;

export function registerSceneCameraControl(control: SceneCameraControl): () => void {
  current = control;
  return () => {
    if (current === control) {
      current = null;
    }
  };
}

export function getSceneCameraControl(): SceneCameraControl | null {
  return current;
}
