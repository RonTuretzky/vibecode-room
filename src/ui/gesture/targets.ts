import { Zone } from "./core";

// A dwellable UI target: a rect in viewport pixels + how to activate it.
export interface TargetDescriptor {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
  activate: () => void;
}

// A plain rect in viewport pixels (the geometry half of a TargetDescriptor).
export interface PixelRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

// HITBOX INFLATION: each DOM control's dwell hitbox extends this many pixels
// past the visual button on every side, so projector-distance pointing has
// slack around small targets. Applied by GestureLayer's DOM collector ONLY —
// scene raycast rects stay exact — and clamped to the viewport so an
// edge-hugging control never gains area offscreen. Overlaps between adjacent
// inflated hitboxes are arbitrated by the collector's smallest-area-first zone
// order (a smaller control wins acquisition in the shared band) plus the dwell
// selector's sticky hysteresis, so neighbors never flicker-fight mid-dwell.
export const HITBOX_INFLATE_PX = 24;

// Pure inflation math: grow `rect` by `pad` px per side, clamped to the
// [0,viewportW]×[0,viewportH] box. Degenerate viewports yield a zero-area rect
// rather than a negative one.
export function inflateRect(rect: PixelRect, pad: number, viewportW: number, viewportH: number): PixelRect {
  const left = Math.max(0, rect.left - pad);
  const top = Math.max(0, rect.top - pad);
  const right = Math.min(viewportW, rect.left + rect.width + pad);
  const bottom = Math.min(viewportH, rect.top + rect.height + pad);
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

// Maintains STABLE Zone instances per target id across frames — critical because
// DwellSelector accumulates dwell only while `activeZone === zone` by identity.
// Each sync() updates existing zones' rects (normalized to the viewport), adds new
// targets, and drops gone ones. Rects come from the live DOM every frame, so the
// dwell tracks moving/animating UI (bubbles rise, buttons reflow).
export class GestureTargets {
  readonly #zones = new Map<string, Zone>();
  readonly #activate = new Map<string, () => void>();

  // Update the target set from viewport-pixel descriptors; returns the current
  // Zone list (normalized [0,1]) to feed DwellSelector.
  sync(descriptors: readonly TargetDescriptor[], viewportW: number, viewportH: number): Zone[] {
    const out: Zone[] = [];
    const seen = new Set<string>();
    if (viewportW <= 0 || viewportH <= 0) {
      return out;
    }
    for (const d of descriptors) {
      if (d.width <= 0 || d.height <= 0) {
        continue;
      }
      const x = d.left / viewportW;
      const y = d.top / viewportH;
      const w = d.width / viewportW;
      const h = d.height / viewportH;
      let zone = this.#zones.get(d.id);
      if (zone === undefined) {
        zone = new Zone(d.id, d.id, x, y, w, h);
        this.#zones.set(d.id, zone);
      } else {
        zone.setRect(x, y, w, h);
      }
      this.#activate.set(d.id, d.activate);
      seen.add(d.id);
      out.push(zone);
    }
    for (const id of [...this.#zones.keys()]) {
      if (!seen.has(id)) {
        this.#zones.delete(id);
        this.#activate.delete(id);
      }
    }
    return out;
  }

  // Invoke a target's activation (a completed dwell). Returns false if unknown.
  activate(zoneId: string): boolean {
    const fn = this.#activate.get(zoneId);
    if (fn === undefined) {
      return false;
    }
    fn();
    return true;
  }

  has(zoneId: string): boolean {
    return this.#zones.has(zoneId);
  }
}


// ── live cursor presence (shared, render-free) ──────────────────────────────
// The GestureLayer publishes every tracked cursor's viewport position here
// each frame. DOM chrome that opens-on-presence (the ⚙ Controls dock) reads
// it to answer "is any cursor over my rect?" — CSS :hover only sees the OS
// mouse, and dwell-hot only marks ACQUIRED targets, so a merely-hovering
// joystick/hands cursor was invisible to hover-open logic (live-room bug:
// the dock could not dwell-open and idle-folded under a parked cursor).
export interface LiveCursorPoint {
  x: number;
  y: number;
}

const liveCursors: LiveCursorPoint[] = [];

export function publishLiveCursors(points: readonly LiveCursorPoint[]): void {
  liveCursors.length = 0;
  for (const point of points) {
    liveCursors.push({ x: point.x, y: point.y });
  }
}

export function anyLiveCursorOver(rect: { left: number; top: number; right: number; bottom: number }, marginPx = 8): boolean {
  for (const point of liveCursors) {
    if (point.x >= rect.left - marginPx && point.x <= rect.right + marginPx && point.y >= rect.top - marginPx && point.y <= rect.bottom + marginPx) {
      return true;
    }
  }
  return false;
}
