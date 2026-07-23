import { useEffect, useRef } from "react";
import { getSceneCameraControl } from "./camera-source";
import { HandsClient, type HandsStatus } from "./hands-client";
import { PinchCam, type CameraIntent } from "./pinch-cam";

export interface PinchCameraLayerProps {
  // TouchDesigner hands stream WS URL (e.g. ws://localhost:9980).
  url: string;
  // Window wall identity (urlConfig.wall): sent in the hello and used to drop
  // wall-tagged frames meant for another window. Null when not wall-bound.
  wall: string | null;
}

// Glue only: TouchDesigner pinch stream → pure PinchCam interpreter → the
// scene's registered camera control. Renders nothing visible — the camera
// motion IS the feedback (and the mount is assertable in windowless tests).
export function PinchCameraLayer({ url, wall }: PinchCameraLayerProps) {
  // Write-only, matching GestureLayer's silent-status precedent — no HUD chip.
  const statusRef = useRef<HandsStatus>("closed");

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    // LOCAL clock for ALL staleness — never frame.t (TD's clock is informational).
    const nowSec = () => performance.now() / 1000;
    const pinchCam = new PinchCam();

    const apply = (intents: CameraIntent[]) => {
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
            control.flick(it.yawVel, it.heightVel);
            control.setTracking(false);
            break;
          case "orbit":
            control.orbitBy(it.dYaw, it.dHeight);
            break;
          case "zoom":
            control.zoomBy(it.scale);
            break;
          case "pan":
            // Normalized → px via viewport HEIGHT for BOTH axes (the
            // OrbitControls convention); the rig's 0.0045*radius panSpeed
            // then applies its own feel.
            control.panBy(it.dx * window.innerHeight, it.dy * window.innerHeight);
            break;
        }
      }
    };

    // The interpreter is driven PER WS FRAME (~30 Hz), never per rAF, so
    // zero-delta repeats can't dilute the flick EMA; the rig's own lerp does
    // the visual smoothing.
    const client = new HandsClient({
      url,
      wall,
      onStatus: (s) => {
        statusRef.current = s;
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
