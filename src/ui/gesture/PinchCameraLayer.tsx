import { useEffect, useRef } from "react";
import { applyCameraIntents, getSceneCameraControl } from "./camera-source";
import { HandsClient, type HandsStatus } from "./hands-client";
import { PinchCam, type CameraIntent } from "./pinch-cam";

export interface PinchCameraLayerProps {
  // TouchDesigner hands stream WS URL (e.g. ws://localhost:9980).
  url: string;
  // Window wall identity (urlConfig.wall): sent in the hello and used to drop
  // wall-tagged frames meant for another window. Null when not wall-bound.
  wall: string | null;
  // Optional: surface the live socket state so the HUD hands-toggle can show
  // OFF / connecting / LIVE. The layer stays silent without it.
  onStatus?: (status: HandsStatus) => void;
}

// Glue only: TouchDesigner pinch stream → pure PinchCam interpreter → the
// scene's registered camera control. Renders nothing visible — the camera
// motion IS the feedback (and the mount is assertable in windowless tests).
export function PinchCameraLayer({ url, wall, onStatus }: PinchCameraLayerProps) {
  // Mirrors the last socket state; also forwarded to onStatus when provided so
  // the HUD toggle can label the connection (OFF / connecting / LIVE).
  const statusRef = useRef<HandsStatus>("closed");
  // Live-readable inside the effect so a changing callback identity never
  // re-runs the socket setup (the effect intentionally depends only on url/wall).
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    // LOCAL clock for ALL staleness — never frame.t (TD's clock is informational).
    const nowSec = () => performance.now() / 1000;
    const pinchCam = new PinchCam();

    // Shared translation (camera-source.applyCameraIntents) — the guest fly
    // relay uses the identical path, so the two sources can never drift.
    const apply = (intents: CameraIntent[]) => applyCameraIntents(intents, window.innerHeight);

    // The interpreter is driven PER WS FRAME (~30 Hz), never per rAF, so
    // zero-delta repeats can't dilute the flick EMA; the rig's own lerp does
    // the visual smoothing.
    const client = new HandsClient({
      url,
      wall,
      onStatus: (s) => {
        statusRef.current = s;
        onStatusRef.current?.(s);
        if (s !== "open") {
          // A dropped/closed socket must never leave a grab held.
          apply(pinchCam.idleTick(nowSec()));
        }
      },
      onFrame: (f) => apply(pinchCam.update(f, nowSec())),
    });
    client.start();

    // Safety watchdog: a hung TD (open socket, no frames) releases the grab
    // within ~250 ms + HAND_STALE_SECONDS.
    const iv = setInterval(() => apply(pinchCam.idleTick(nowSec())), 250);

    return () => {
      clearInterval(iv);
      client.stop();
      getSceneCameraControl()?.setTracking(false);
    };
  }, [url, wall]);

  return <div data-testid="pinch-camera-layer" hidden />;
}
