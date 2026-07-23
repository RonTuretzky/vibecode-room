import { useEffect, useRef } from "react";
import { HandsClient, type HandsFrame, type HandsStatus } from "./hands-client";

// MediaPipe 21-point hand skeleton edges.
const HAND_EDGES: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],          // thumb
  [0, 5], [5, 6], [6, 7], [7, 8],          // index
  [5, 9], [9, 10], [10, 11], [11, 12],     // middle
  [9, 13], [13, 14], [14, 15], [15, 16],   // ring
  [13, 17], [17, 18], [18, 19], [19, 20],  // pinky
  [0, 17],                                  // palm base
];
const THUMB_TIP = 4;
const INDEX_TIP = 8;

export interface HandSkeletonHudProps {
  // Hands WS URL (same source the pinch camera uses), e.g. ws://localhost:9980.
  url: string;
  wall?: string | null;
  // CSS width of the corner panel; height follows a 4:3 camera aspect.
  width?: number;
}

// A small top-left overlay that draws ONLY the live hand skeleton + per-hand id
// and pinch readout — no camera image. Fed by the same 9980 stream as the pinch
// camera (needs a bridge that emits the `lm` skeleton field; older/TD streams
// without it show the status + a "no skeleton data" note). Never intercepts
// input (pointer-events:none); purely a debug/aim HUD baked into the app.
export function HandSkeletonHud({ url, wall = null, width = 220 }: HandSkeletonHudProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d") ?? null;
    if (canvas === null || ctx === null) {
      return;
    }

    let frame: HandsFrame | null = null;
    let status: HandsStatus = "connecting";
    let stamp = 0;

    const client = new HandsClient({
      url,
      wall,
      onFrame: (f) => {
        frame = f;
        stamp = performance.now();
      },
      onStatus: (s) => {
        status = s;
      },
    });
    client.start();

    const W = 4;
    const H = 3;
    const scale = width / W; // css px per aspect-unit; canvas is width x (width*H/W)
    const cssW = width;
    const cssH = width * (H / W);

    let raf = 0;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      // Panel backdrop.
      ctx.fillStyle = "rgba(6,10,20,0.72)";
      ctx.fillRect(0, 0, cssW, cssH);
      ctx.strokeStyle = "rgba(120,170,255,0.35)";
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, 0.5, cssW - 1, cssH - 1);

      const fresh = frame !== null && performance.now() - stamp < 500;
      const hands = fresh ? frame!.hands : [];

      // Header text.
      ctx.font = "11px ui-monospace, Menlo, monospace";
      ctx.textBaseline = "top";
      const live = status === "open";
      ctx.fillStyle = live ? "#7ef0a0" : "#f0b46a";
      ctx.fillText(
        `hands ${status === "open" ? "LIVE" : status}  ${hands.length} hand${hands.length === 1 ? "" : "s"}`,
        6, 5,
      );

      const px = (nx: number, ny: number): [number, number] => [nx * cssW, ny * cssH];

      for (const hand of hands) {
        const hue = hand.id % 2 === 0 ? 200 : 150;
        const lm = hand.lm;
        if (lm !== undefined && lm.length === 21) {
          ctx.strokeStyle = `hsla(${hue}, 85%, 62%, 0.9)`;
          ctx.lineWidth = 1.6;
          for (const [a, b] of HAND_EDGES) {
            const [ax, ay] = px(lm[a][0], lm[a][1]);
            const [bx, by] = px(lm[b][0], lm[b][1]);
            ctx.beginPath();
            ctx.moveTo(ax, ay);
            ctx.lineTo(bx, by);
            ctx.stroke();
          }
          ctx.fillStyle = `hsla(${hue}, 90%, 78%, 1)`;
          for (const [nx, ny] of lm) {
            const [x, y] = px(nx, ny);
            ctx.beginPath();
            ctx.arc(x, y, 2, 0, Math.PI * 2);
            ctx.fill();
          }
          // Pinch pair highlighted.
          const [tx, ty] = px(lm[THUMB_TIP][0], lm[THUMB_TIP][1]);
          const [ix, iy] = px(lm[INDEX_TIP][0], lm[INDEX_TIP][1]);
          ctx.strokeStyle = hand.pinching ? "#ff5a3c" : "hsla(30,90%,65%,0.8)";
          ctx.lineWidth = hand.pinching ? 3 : 1.6;
          ctx.beginPath();
          ctx.moveTo(tx, ty);
          ctx.lineTo(ix, iy);
          ctx.stroke();
        } else {
          // Fallback: no skeleton in the stream — just plot the cursor dot.
          const [cx, cy] = px(hand.x, hand.y);
          ctx.fillStyle = `hsla(${hue}, 90%, 70%, 1)`;
          ctx.beginPath();
          ctx.arc(cx, cy, 5, 0, Math.PI * 2);
          ctx.fill();
        }

        // Per-hand readout text.
        const label = `${hand.hand ?? "?"} #${hand.id}  pinch ${
          typeof hand.pinch === "number" ? hand.pinch.toFixed(2) : "--"
        }${hand.pinching ? "  PINCH" : ""}`;
        const ty2 = 20 + (hand.id % 2) * 14;
        ctx.font = "10px ui-monospace, Menlo, monospace";
        ctx.fillStyle = hand.pinching ? "#ff8a6a" : "#cfe0ff";
        ctx.fillText(label, 6, ty2);
      }

      if (hands.length === 0) {
        ctx.font = "10px ui-monospace, Menlo, monospace";
        ctx.fillStyle = "rgba(180,200,230,0.6)";
        ctx.fillText(live ? "raise a hand to the camera" : "waiting for hands bridge…", 6, cssH - 16);
      }

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      client.stop();
    };
  }, [url, wall, width]);

  return (
    <canvas
      ref={canvasRef}
      data-testid="hand-skeleton-hud"
      aria-hidden="true"
      style={{
        position: "fixed",
        top: 12,
        left: 12,
        width,
        height: width * (3 / 4),
        borderRadius: 8,
        pointerEvents: "none",
        zIndex: 60,
      }}
    />
  );
}
