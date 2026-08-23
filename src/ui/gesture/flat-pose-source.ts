// Bridge between the 3D RoomScene's FLAT-LOCKED rig and the guest-hands room
// socket (GestureLayer's GestureWallClient on /api/hands/room).
//
// Mirrors the camera-source.ts seam, but BOTH ways: under ?flat=1 the two wall
// windows share one panorama pose ({yaw, height, dist, cx, cz} — RoomScene's
// flatRig targets), and "identical input streams" alone cannot keep two copies equal
// forever (reconnects, refreshes, key-timing skew). So the scene PUBLISHES its
// pose after local input (via the sender the layer registers) and ADOPTS poses
// heard from the partner window (via the control the scene registers) — the
// server's RemoteHandsHub relays "flatpose" frames between the wall windows.
// Neither side touches the other's internals: the scene owns the rig and all
// clamps; the layer owns the socket.

export interface FlatPose {
  yaw: number; // rad, RoomScene orbit convention
  height: number; // world units (scene clamps [1.4,30])
  dist: number; // world units (scene clamps [6,45])
  // The panorama's roaming centre (the palm-depth free-roam walk translates
  // it), world units on the ground plane (scene clamps ±80). Old frames on
  // the wire may omit them — parsers default 0, the pre-roam origin.
  cx: number;
  cz: number;
}

export interface SceneFlatPoseControl {
  // Adopt the partner window's pose as this window's flat targets, verbatim
  // (the scene's flatView easing smooths the correction). The scene marks its
  // targets clean here so an adoption never re-publishes (loop prevention).
  adopt(pose: FlatPose): void;
}

// One scene per window (each wall window is its own full app instance).
let control: SceneFlatPoseControl | null = null;

export function registerSceneFlatPoseControl(next: SceneFlatPoseControl): () => void {
  control = next;
  return () => {
    if (control === next) {
      control = null;
    }
  };
}

export function getSceneFlatPoseControl(): SceneFlatPoseControl | null {
  return control;
}

// The upward path: GestureLayer registers a sender that frames the pose as a
// {"type":"flatpose",…} and pushes it up its room-subscription socket (dropped
// silently while the socket is down — pose publishes recur on input, so the
// next one lands after reconnect). Null when no room subscription exists
// (no remoteUrl): the scene's publish is then a no-op.
export type FlatPoseSender = (pose: FlatPose) => void;

let sender: FlatPoseSender | null = null;

export function registerFlatPoseSender(next: FlatPoseSender): () => void {
  sender = next;
  return () => {
    if (sender === next) {
      sender = null;
    }
  };
}

export function getFlatPoseSender(): FlatPoseSender | null {
  return sender;
}
