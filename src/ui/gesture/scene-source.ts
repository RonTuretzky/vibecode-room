// Bridge between the 3D RoomScene and the gesture dwell layer.
//
// The scene owns the camera + raycaster, so IT decides what a viewport point is
// aiming at (real raycast against the idea/build nodes) and what a node's
// current screen rect is (projected bounding box — fed to the dwell state
// machine as a Zone so hysteresis/progress track the node even as it drifts).
// The gesture layer never touches three.js; it talks through this registry.
//
// Target ids are namespaced so the layer can route highlights back:
//   scene:idea:<key>       — a ready idea node (dwell = build it)
//   scene:proc:<callsign>  — a build/process node (dwell = steer / open deck)

export interface SceneDwellRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface SceneDwellSource {
  // Raycast at viewport (client px) coordinates → target id or null.
  pick(clientX: number, clientY: number): string | null;
  // Current projected screen rect of a known target, or null when it is gone.
  rectFor(id: string): SceneDwellRect | null;
  // Synthesize the node's click semantics (idea → build, process → steer/deck).
  activate(id: string): void;
  // The set of target ids currently dwelled on — the scene grows/glows them.
  setHighlights(ids: ReadonlySet<string>): void;
}

// One scene per window (each wall window is its own full app instance).
let current: SceneDwellSource | null = null;

export function registerSceneDwellSource(source: SceneDwellSource): () => void {
  current = source;
  return () => {
    if (current === source) {
      current = null;
    }
  };
}

export function getSceneDwellSource(): SceneDwellSource | null {
  return current;
}
