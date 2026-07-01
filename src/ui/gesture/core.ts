// Pure gesture logic — a faithful TypeScript port of gesture-wall/web/core.js so
// the Vibersyn UI can consume the camera-fusion cursor stream and run the same
// dwell-to-select interaction the standalone wall client uses. All coordinates
// are NORMALIZED to [0,1] on both axes (fraction of width/height). Nothing here
// assumes a grid — a Zone is any rect, so cursors dwell onto arbitrary UI targets.

// ── 1-Euro filter (Casiez et al.) ────────────────────────────────────────────
// The fusion SERVER already 1-Euro-smooths the emitted cursor stream, so the live
// overlay usually feeds coords straight through. Ported for parity + tests and
// for any consumer that feeds raw coordinates.
export class LowPassFilter {
  #s: number | null = null;
  #alpha: number;
  constructor(alpha: number) {
    this.#alpha = validAlpha(alpha);
  }
  call(value: number, alpha?: number): number {
    if (alpha !== undefined) {
      this.#alpha = validAlpha(alpha);
    }
    this.#s = this.#s === null ? value : this.#alpha * value + (1 - this.#alpha) * this.#s;
    return this.#s;
  }
  last(): number | null {
    return this.#s;
  }
}

function validAlpha(alpha: number): number {
  if (!(alpha > 0 && alpha <= 1)) {
    throw new Error(`alpha must be in (0,1], got ${alpha}`);
  }
  return alpha;
}

export class OneEuroFilter {
  #freq: number;
  #mincutoff: number;
  #beta: number;
  #dcutoff: number;
  #x: LowPassFilter;
  #dx: LowPassFilter;
  #lastTime: number | null = null;
  constructor(freq = 60, mincutoff = 1.0, beta = 0.0, dcutoff = 1.0) {
    this.#freq = freq;
    this.#mincutoff = mincutoff;
    this.#beta = beta;
    this.#dcutoff = dcutoff;
    this.#x = new LowPassFilter(this.#alpha(mincutoff));
    this.#dx = new LowPassFilter(this.#alpha(dcutoff));
  }
  #alpha(cutoff: number): number {
    const te = 1 / this.#freq;
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / te);
  }
  call(x: number, timestamp: number | null = null): number {
    if (this.#lastTime !== null && timestamp !== null && timestamp > this.#lastTime) {
      this.#freq = 1 / (timestamp - this.#lastTime);
    }
    this.#lastTime = timestamp;
    const prev = this.#x.last();
    const dx = prev === null ? 0 : (x - prev) * this.#freq;
    const edx = this.#dx.call(dx, this.#alpha(this.#dcutoff));
    const cutoff = this.#mincutoff + this.#beta * Math.abs(edx);
    return this.#x.call(x, this.#alpha(cutoff));
  }
}

export class Point2DFilter {
  #fx: OneEuroFilter;
  #fy: OneEuroFilter;
  constructor(freq = 60, mincutoff = 1.0, beta = 0.007, dcutoff = 1.0) {
    this.#fx = new OneEuroFilter(freq, mincutoff, beta, dcutoff);
    this.#fy = new OneEuroFilter(freq, mincutoff, beta, dcutoff);
  }
  call(x: number, y: number, timestamp: number | null = null): [number, number] {
    return [this.#fx.call(x, timestamp), this.#fy.call(y, timestamp)];
  }
}

// ── Zone (a dwellable rect target) ────────────────────────────────────────────
// Identity matters: DwellSelector accumulates dwell only while `activeZone === z`
// across frames, so callers must REUSE the same Zone instance for a given target
// and update its rect in place (setRect), not rebuild it each frame.
export class Zone {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  selected = false;
  constructor(id: string, label: string, x: number, y: number, w: number, h: number) {
    this.id = id;
    this.label = label;
    this.x = x;
    this.y = y;
    this.w = w;
    this.h = h;
  }
  setRect(x: number, y: number, w: number, h: number): void {
    this.x = x;
    this.y = y;
    this.w = w;
    this.h = h;
  }
  // Positive margin SHRINKS the box inward by margin*size on each side; negative
  // margin GROWS it outward. margin is fractional of this rect's own w/h.
  contains(px: number, py: number, margin = 0): boolean {
    const mx = margin * this.w;
    const my = margin * this.h;
    return px >= this.x + mx && px <= this.x + this.w - mx && py >= this.y + my && py <= this.y + this.h - my;
  }
}

export function buildGrid(rows: number, cols: number, padding = 0.06, labels: string[] | null = null): Zone[] {
  if (rows < 1 || cols < 1) {
    throw new Error("rows and cols must be >= 1");
  }
  if (!(padding >= 0 && padding < 0.5)) {
    throw new Error("padding must be in [0,0.5)");
  }
  const cellW = 1 / cols;
  const cellH = 1 / rows;
  const zones: Zone[] = [];
  let idx = 0;
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const x = c * cellW + padding * cellW;
      const y = r * cellH + padding * cellH;
      const w = cellW * (1 - 2 * padding);
      const h = cellH * (1 - 2 * padding);
      const label = labels && idx < labels.length ? labels[idx] : String(idx + 1);
      zones.push(new Zone(`r${r}c${c}`, label, x, y, w, h));
      idx += 1;
    }
  }
  return zones;
}

// ── DwellSelector (dwell-to-toggle with sticky hysteresis) ────────────────────
export interface DwellEvent {
  zoneId: string;
  selected: boolean;
}

export class DwellSelector {
  readonly #dwellSeconds: number;
  readonly #cooldownSeconds: number;
  readonly #hysteresis: number;
  // When true, a fired zone cannot re-fire until the cursor LEAVES it — so a
  // dwell = exactly one click per approach (correct for click-to-activate a
  // button). When false (the standalone wall's tile behavior), a cursor parked on
  // a zone re-fires every dwell+cooldown, toggling it. The UI uses true.
  readonly #refireOnlyAfterLeave: boolean;
  activeZone: Zone | null = null;
  progress = 0;
  #enterTime: number | null = null;
  #cooldownUntil = 0;
  #consumed: Zone | null = null;

  constructor(dwellSeconds = 0.8, cooldownSeconds = 0.4, hysteresis = 0.15, refireOnlyAfterLeave = false) {
    if (!(dwellSeconds > 0)) {
      throw new Error("dwellSeconds must be > 0");
    }
    if (!(cooldownSeconds >= 0)) {
      throw new Error("cooldownSeconds must be >= 0");
    }
    if (!(hysteresis >= 0 && hysteresis < 0.5)) {
      throw new Error("hysteresis must be in [0,0.5)");
    }
    this.#dwellSeconds = dwellSeconds;
    this.#cooldownSeconds = cooldownSeconds;
    this.#hysteresis = hysteresis;
    this.#refireOnlyAfterLeave = refireOnlyAfterLeave;
  }

  reset(): void {
    // NOTE: does NOT clear #cooldownUntil / #consumed — both survive a reset
    // (they gate re-firing and are cleared by their own conditions).
    this.activeZone = null;
    this.progress = 0;
    this.#enterTime = null;
  }

  // `cursor` is a normalized [x,y] tuple (or null when no hand). `t` is seconds.
  update(zones: readonly Zone[], cursor: readonly [number, number] | null, t: number, engaged = true): DwellEvent | null {
    if (!engaged || cursor === null) {
      this.#consumed = null; // hand pulled away — a fresh approach may re-fire
      this.reset();
      return null;
    }
    if (t < this.#cooldownUntil) {
      this.activeZone = null;
      this.progress = 0;
      this.#enterTime = null;
      return null;
    }
    // Re-arm latch: while the cursor is still parked on the zone it just fired,
    // hold — it must LEAVE before it can dwell again. Prevents a steady cursor
    // from auto-clicking a button (or flipping a toggle) every ~1.2s.
    if (this.#consumed !== null) {
      if (this.#consumed.contains(cursor[0], cursor[1])) {
        this.activeZone = null;
        this.progress = 0;
        this.#enterTime = null;
        return null;
      }
      this.#consumed = null;
    }
    const target = this.#resolveTarget(zones, cursor[0], cursor[1]);
    if (target === null) {
      this.reset();
      return null;
    }
    if (target !== this.activeZone) {
      this.activeZone = target;
      this.#enterTime = t;
      this.progress = 0;
      return null;
    }
    const elapsed = t - (this.#enterTime ?? t);
    this.progress = Math.max(0, Math.min(1, elapsed / this.#dwellSeconds));
    if (elapsed >= this.#dwellSeconds) {
      target.selected = !target.selected;
      const event: DwellEvent = { zoneId: target.id, selected: target.selected };
      this.#cooldownUntil = t + this.#cooldownSeconds;
      if (this.#refireOnlyAfterLeave) {
        this.#consumed = target;
      }
      this.reset();
      return event;
    }
    return null;
  }

  #resolveTarget(zones: readonly Zone[], x: number, y: number): Zone | null {
    // 1) sticky: keep the current zone even if the cursor drifts slightly OUTSIDE
    //    its true edge (negative margin = expanded bounds).
    if (this.activeZone !== null && this.activeZone.contains(x, y, -this.#hysteresis)) {
      return this.activeZone;
    }
    // 2) acquiring a NEW zone requires being well INSIDE its core (shrunk bounds).
    for (const z of zones) {
      if (z.contains(x, y, this.#hysteresis)) {
        return z;
      }
    }
    // 3) fallback plain hit-test for the gap between shrunk-core and true-edge.
    for (const z of zones) {
      if (z.contains(x, y)) {
        return z;
      }
    }
    return null;
  }
}

// Map a cursor id to a stable, well-spread hue in [0,360). id=-1 (mouse-test
// cursor) gets a fixed distinct hue so it never collides.
export function idToHue(id: number): number {
  if (id === -1) {
    return 200;
  }
  const GOLDEN = 137.508;
  return (((id * GOLDEN) % 360) + 360) % 360;
}
