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

// Camera-intent shape shared by every PinchCam consumer (the laptop-bridge
// layer and the guest fly-mode relay). Structural mirror of pinch-cam's
// CameraIntent — declared here so this seam module stays import-light.
export interface AppliedCameraIntent {
  kind: "grab" | "release" | "orbit" | "zoom" | "pan";
  yawVel?: number;
  heightVel?: number;
  dYaw?: number;
  dHeight?: number;
  scale?: number;
  dx?: number;
  dy?: number;
}

// Apply interpreter intents to the registered scene control. ONE translation
// for every pinch source, so the guest fly relay and the laptop bridge can
// never drift apart on the pan px convention or the tracking lifecycle.
export function applyCameraIntents(intents: AppliedCameraIntent[], viewportHeightPx: number): void {
  const control = getSceneCameraControl();
  if (control === null) {
    return;
  }
  for (const it of intents) {
    switch (it.kind) {
      case "grab":
        control.setTracking(true);
        break;
      case "release":
        control.flick(it.yawVel ?? 0, it.heightVel ?? 0);
        control.setTracking(false);
        break;
      case "orbit":
        control.orbitBy(it.dYaw ?? 0, it.dHeight ?? 0);
        break;
      case "zoom":
        control.zoomBy(it.scale ?? 1);
        break;
      case "pan":
        // Normalized → px via viewport HEIGHT for BOTH axes (the
        // OrbitControls convention); the rig's 0.0045*radius panSpeed
        // then applies its own feel.
        control.panBy((it.dx ?? 0) * viewportHeightPx, (it.dy ?? 0) * viewportHeightPx);
        break;
    }
  }
}
