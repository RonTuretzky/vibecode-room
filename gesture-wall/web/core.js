// Gesture Wall — shared pure-logic core (ES module).
//
// Direct browser ports of the Python prototype's pure-logic modules, extracted
// here so multiple clients (gesturewall.js single-wall app, wall.js networked
// multi-cursor client) share one implementation with identical behaviour:
//   gesturewall/{filters,zones,dwell,calibration}.py
//
// Named exports: OneEuroFilter, Point2DFilter, Zone, buildGrid, DwellSelector,
// Homography, WALL_CORNERS, CORNER_NAMES.

// --------------------------------------------------------------------------- //
// 1-Euro filter  (port of filters.py)
// --------------------------------------------------------------------------- //
class LowPassFilter {
  constructor(alpha) { this._setAlpha(alpha); this._s = null; }
  _setAlpha(a) {
    if (!(a > 0 && a <= 1)) throw new Error(`alpha must be in (0,1], got ${a}`);
    this._alpha = a;
  }
  call(value, alpha) {
    if (alpha != null) this._setAlpha(alpha);
    const s = this._s == null ? value : this._alpha * value + (1 - this._alpha) * this._s;
    this._s = s;
    return s;
  }
  last() { return this._s; }
}

export class OneEuroFilter {
  constructor(freq = 60, mincutoff = 1.0, beta = 0.0, dcutoff = 1.0) {
    this._freq = freq; this._mincutoff = mincutoff; this._beta = beta; this._dcutoff = dcutoff;
    this._x = new LowPassFilter(this._alpha(mincutoff));
    this._dx = new LowPassFilter(this._alpha(dcutoff));
    this._lasttime = null;
  }
  _alpha(cutoff) {
    const te = 1 / this._freq;
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / te);
  }
  call(x, timestamp) {
    if (this._lasttime != null && timestamp != null && timestamp > this._lasttime)
      this._freq = 1 / (timestamp - this._lasttime);
    this._lasttime = timestamp;
    const prev = this._x.last();
    const dx = prev == null ? 0 : (x - prev) * this._freq;
    const edx = this._dx.call(dx, this._alpha(this._dcutoff));
    const cutoff = this._mincutoff + this._beta * Math.abs(edx);
    return this._x.call(x, this._alpha(cutoff));
  }
}

export class Point2DFilter {
  constructor(freq = 60, mincutoff = 1.0, beta = 0.007, dcutoff = 1.0) {
    this._fx = new OneEuroFilter(freq, mincutoff, beta, dcutoff);
    this._fy = new OneEuroFilter(freq, mincutoff, beta, dcutoff);
  }
  call(x, y, timestamp) {
    return [this._fx.call(x, timestamp), this._fy.call(y, timestamp)];
  }
}

// --------------------------------------------------------------------------- //
// Zones  (port of zones.py)
// --------------------------------------------------------------------------- //
export class Zone {
  constructor(id, label, x, y, w, h) {
    this.id = id; this.label = label;
    this.x = x; this.y = y; this.w = w; this.h = h;
    this.selected = false;
  }
  contains(px, py, margin = 0) {
    const mx = margin * this.w, my = margin * this.h;
    return (this.x + mx <= px && px <= this.x + this.w - mx &&
            this.y + my <= py && py <= this.y + this.h - my);
  }
}

export function buildGrid(rows, cols, padding = 0.06, labels = null) {
  if (rows < 1 || cols < 1) throw new Error("rows and cols must be >= 1");
  if (!(padding >= 0 && padding < 0.5)) throw new Error("padding must be in [0, 0.5)");
  const zones = [];
  const cellW = 1 / cols, cellH = 1 / rows;
  let idx = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * cellW + padding * cellW;
      const y = r * cellH + padding * cellH;
      const w = cellW * (1 - 2 * padding);
      const h = cellH * (1 - 2 * padding);
      const label = labels && idx < labels.length ? labels[idx] : String(idx + 1);
      zones.push(new Zone(`r${r}c${c}`, label, x, y, w, h));
      idx++;
    }
  }
  return zones;
}

// --------------------------------------------------------------------------- //
// Dwell-to-select state machine  (port of dwell.py)
// --------------------------------------------------------------------------- //
export class DwellSelector {
  constructor(dwellSeconds = 0.8, cooldownSeconds = 0.4, hysteresis = 0.15) {
    if (dwellSeconds <= 0) throw new Error("dwellSeconds must be > 0");
    if (cooldownSeconds < 0) throw new Error("cooldownSeconds must be >= 0");
    if (!(hysteresis >= 0 && hysteresis < 0.5)) throw new Error("hysteresis must be in [0, 0.5)");
    this.dwellSeconds = dwellSeconds;
    this.cooldownSeconds = cooldownSeconds;
    this.hysteresis = hysteresis;
    this.activeZone = null;
    this.progress = 0;
    this._enterTime = null;
    this._cooldownUntil = 0;
  }
  reset() { this.activeZone = null; this.progress = 0; this._enterTime = null; }
  _resolveTarget(zones, x, y) {
    if (this.activeZone && this.activeZone.contains(x, y, -this.hysteresis))
      return this.activeZone;
    const core = zones.find(z => z.contains(x, y, this.hysteresis));
    if (core) return core;
    return zones.find(z => z.contains(x, y)) || null;
  }
  update(zones, cursor, t, engaged = true) {
    if (!engaged || cursor == null) { this.reset(); return null; }
    if (t < this._cooldownUntil) {
      this.activeZone = null; this.progress = 0; this._enterTime = null; return null;
    }
    const target = this._resolveTarget(zones, cursor[0], cursor[1]);
    if (target == null) { this.reset(); return null; }
    if (target !== this.activeZone) {
      this.activeZone = target; this._enterTime = t; this.progress = 0; return null;
    }
    const elapsed = t - this._enterTime;
    this.progress = Math.max(0, Math.min(1, elapsed / this.dwellSeconds));
    if (elapsed >= this.dwellSeconds) {
      target.selected = !target.selected;
      const event = { zoneId: target.id, selected: target.selected };
      this._cooldownUntil = t + this.cooldownSeconds;
      this.reset();
      return event;
    }
    return null;
  }
}

// --------------------------------------------------------------------------- //
// Homography  (port of calibration.py, with an in-JS getPerspectiveTransform)
// --------------------------------------------------------------------------- //
export const WALL_CORNERS = [[0.05, 0.05], [0.95, 0.05], [0.95, 0.95], [0.05, 0.95]];
export const CORNER_NAMES = ["TOP-LEFT", "TOP-RIGHT", "BOTTOM-RIGHT", "BOTTOM-LEFT"];

export class Homography {
  constructor(matrix = null) {
    this.matrix = matrix || [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  }
  static identity() { return new Homography(); }
  apply(x, y) {
    const m = this.matrix;
    const denom = m[2][0] * x + m[2][1] * y + m[2][2];
    if (Math.abs(denom) < 1e-12) return [x, y];
    return [(m[0][0] * x + m[0][1] * y + m[0][2]) / denom,
            (m[1][0] * x + m[1][1] * y + m[1][2]) / denom];
  }
  static fromCornerPoints(src, dst = WALL_CORNERS) {
    if (src.length !== 4) throw new Error("exactly 4 source points are required");
    let area = 0;
    for (let i = 0; i < 4; i++) {
      const [x1, y1] = src[i], [x2, y2] = src[(i + 1) % 4];
      area += x1 * y2 - x2 * y1;
    }
    if (Math.abs(area) / 2 < 1e-6)
      throw new Error("source points are degenerate (collinear/coincident)");
    return new Homography(getPerspectiveTransform(src, dst));
  }
}

// Solve the 8 homography params (h33 = 1) from 4 point correspondences.
function getPerspectiveTransform(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -x * u, -y * u]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -x * v, -y * v]); b.push(v);
  }
  const h = solveLinear(A, b);
  return [[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], 1]];
}

// Gaussian elimination with partial pivoting for an n x n system.
function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++)
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col];
    if (Math.abs(d) < 1e-12) throw new Error("singular system in homography solve");
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / d;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}
