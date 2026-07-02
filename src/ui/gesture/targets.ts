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
