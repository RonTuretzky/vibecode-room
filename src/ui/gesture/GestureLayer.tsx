import { useEffect, useRef } from "react";
import { DwellSelector, Zone, idToHue } from "./core";
import { GestureTargets, type TargetDescriptor } from "./targets";
import { GestureWallClient, type GestureCursor, type GestureWallStatus } from "./wall-client";

// Dwell/interaction tuning — matches the standalone wall client defaults.
const DWELL_SECONDS = 0.8;
const COOLDOWN_SECONDS = 0.4;
const HYSTERESIS = 0.15;
// A CAMERA cursor not seen for this long is dropped (the hand left). The local
// mouse-test cursor is sticky (holding still is how you dwell) so it is exempt.
const STALE_SECONDS = 0.5;

// The Vibersyn UI elements a person gestures at: the idea/process bubbles and the
// control buttons. Addressed by their existing data-testid / data-callsign; a
// completed dwell fires a synthetic .click() (all handlers are plain onClick).
const CONTROL_TESTIDS = ["capture-button", "auto-build-button", "emergency-button", "unmute-button", "mic-button"];

interface CursorState {
  x: number;
  y: number;
  engaged: boolean;
  lastSeen: number; // seconds
  isMouse: boolean;
}

export interface GestureLayerProps {
  // The wall id to subscribe to on the fusion server (e.g. "A").
  wall: string;
  // Fusion server WS URL (e.g. ws://localhost:8770). Empty disables the camera
  // stream; the mouse-test cursor still works for local dev.
  fusionUrl: string;
  // When true, moving the mouse injects a local id=-1 cursor so dwell can be
  // driven without cameras. Default true.
  mouseTest?: boolean;
}

// A full-viewport, pointer-events:none overlay that turns the gesture-wall camera
// cursor stream (or the mouse) into dwell-to-click interaction over the real
// Vibersyn UI. Camera cursors and the mouse are both processed identically.
export function GestureLayer({ wall, fusionUrl, mouseTest = true }: GestureLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const statusRef = useRef<GestureWallStatus>("closed");

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d") ?? null;

    const cursors = new Map<number, CursorState>();
    const dwellers = new Map<number, DwellSelector>();
    const targets = new GestureTargets();
    let raf = 0;

    const nowSec = () => performance.now() / 1000;

    // ── mouse-test cursor (id = -1): sticky, engaged, updated on move ──────────
    const MOUSE_ID = -1;
    const onMouseMove = (e: MouseEvent) => {
      if (!mouseTest) {
        return;
      }
      const w = window.innerWidth || 1;
      const h = window.innerHeight || 1;
      cursors.set(MOUSE_ID, { x: e.clientX / w, y: e.clientY / h, engaged: true, lastSeen: nowSec(), isMouse: true });
    };
    if (mouseTest) {
      window.addEventListener("mousemove", onMouseMove, { passive: true });
    }

    // ── camera cursor stream ──────────────────────────────────────────────────
    let client: GestureWallClient | null = null;
    if (fusionUrl.trim().length > 0) {
      client = new GestureWallClient({
        url: fusionUrl,
        wall,
        onStatus: (s) => {
          statusRef.current = s;
        },
        onCursors: (incoming: GestureCursor[]) => {
          const t = nowSec();
          for (const c of incoming) {
            cursors.set(c.id, { x: c.x, y: c.y, engaged: c.engaged, lastSeen: t, isMouse: false });
          }
        },
      });
      client.start();
    }

    // ── the interaction + render loop ─────────────────────────────────────────
    const collectTargets = (): TargetDescriptor[] => {
      const out: TargetDescriptor[] = [];
      const add = (id: string, el: Element) => {
        const r = el.getBoundingClientRect();
        out.push({ id, left: r.left, top: r.top, width: r.width, height: r.height, activate: () => (el as HTMLElement).click() });
      };
      let bubbleIdx = 0;
      document.querySelectorAll('[data-testid="bubble"]').forEach((el) => {
        const callsign = el.getAttribute("data-callsign") ?? `b${bubbleIdx}`;
        bubbleIdx += 1;
        add(`bubble:${callsign}`, el);
      });
      for (const testid of CONTROL_TESTIDS) {
        const el = document.querySelector(`[data-testid="${testid}"]`);
        if (el !== null) {
          add(testid, el);
        }
      }
      return out;
    };

    const frame = () => {
      const t = nowSec();
      const vpW = window.innerWidth || 1;
      const vpH = window.innerHeight || 1;

      // The mouse cursor stays alive at its last position (holding still = dwell).
      const mouse = cursors.get(MOUSE_ID);
      if (mouse !== undefined) {
        mouse.lastSeen = t;
      }
      // Drop stale camera cursors + their dwellers.
      for (const [id, c] of [...cursors]) {
        if (!c.isMouse && t - c.lastSeen > STALE_SECONDS) {
          cursors.delete(id);
          dwellers.delete(id);
        }
      }

      const zones: Zone[] = targets.sync(collectTargets(), vpW, vpH);

      for (const [id, c] of cursors) {
        let dweller = dwellers.get(id);
        if (dweller === undefined) {
          // refireOnlyAfterLeave: a dwell = ONE click; the cursor must leave the
          // target before it can activate it again (no accidental repeat toggles).
          dweller = new DwellSelector(DWELL_SECONDS, COOLDOWN_SECONDS, HYSTERESIS, true);
          dwellers.set(id, dweller);
        }
        const event = dweller.update(zones, [c.x, c.y], t, c.engaged);
        if (event !== null) {
          targets.activate(event.zoneId);
        }
      }

      draw(ctx, canvas, cursors, dwellers, vpW, vpH);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      if (mouseTest) {
        window.removeEventListener("mousemove", onMouseMove);
      }
      client?.stop();
    };
  }, [wall, fusionUrl, mouseTest]);

  return (
    <canvas
      ref={canvasRef}
      className="gesture-overlay"
      data-testid="gesture-overlay"
      aria-hidden="true"
    />
  );
}

// Draw each cursor as a hued dot + a dwell progress ring (arc = that cursor's
// dwell progress). Pure canvas; no state.
function draw(
  ctx: CanvasRenderingContext2D | null,
  canvas: HTMLCanvasElement | null,
  cursors: Map<number, CursorState>,
  dwellers: Map<number, DwellSelector>,
  vpW: number,
  vpH: number,
): void {
  if (ctx === null || canvas === null) {
    return;
  }
  const dpr = window.devicePixelRatio || 1;
  const pxW = Math.round(vpW * dpr);
  const pxH = Math.round(vpH * dpr);
  if (canvas.width !== pxW || canvas.height !== pxH) {
    canvas.width = pxW;
    canvas.height = pxH;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, vpW, vpH);

  for (const [id, c] of cursors) {
    const cx = c.x * vpW;
    const cy = c.y * vpH;
    const hue = idToHue(id);
    const alpha = c.engaged ? 1 : 0.4;

    // dwell ring
    const progress = dwellers.get(id)?.progress ?? 0;
    ctx.lineWidth = 4;
    ctx.strokeStyle = `hsla(${hue}, 90%, 60%, ${0.25 * alpha})`;
    ctx.beginPath();
    ctx.arc(cx, cy, 22, 0, Math.PI * 2);
    ctx.stroke();
    if (progress > 0) {
      ctx.strokeStyle = `hsla(${hue}, 95%, 62%, ${alpha})`;
      ctx.beginPath();
      ctx.arc(cx, cy, 22, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
      ctx.stroke();
    }

    // cursor dot
    ctx.fillStyle = `hsla(${hue}, 95%, 62%, ${alpha})`;
    ctx.beginPath();
    ctx.arc(cx, cy, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `hsla(${hue}, 95%, 88%, ${alpha})`;
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}
