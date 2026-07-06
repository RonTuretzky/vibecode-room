// Gesture Wall — networked multi-cursor wall client.
//
// A single wall's display. Connects to the fusion server over WebSocket, receives
// that wall's cursor stream, and renders every active user with their own smoothed
// cursor + dwell ring. Pure-logic classes (Point2DFilter, DwellSelector, Zone,
// buildGrid) come from ./core.js so behaviour matches the Python prototype.
//
// Per cursor: an independent Point2DFilter (smoothing) + DwellSelector (dwell-to-
// toggle) run against the SHARED zone grid. A shared per-zone lock prevents two
// users from double-toggling the same tile within a short window.
//
// URL params: ?wall=A&server=ws://localhost:8770&rows=2&cols=3
//
// The pure helpers (parseParams, idToHue, zoneLock decision, stale eviction) are
// exported so they can be unit-tested under node without a DOM or a socket.

import {
  Point2DFilter,
  Zone,
  buildGrid,
  DwellSelector,
} from "./core.js";

// --------------------------------------------------------------------------- //
// Tunables
// --------------------------------------------------------------------------- //
export const STALE_SECONDS = 0.5;     // drop a cursor not seen for this long
export const ZONE_LOCK_SECONDS = 0.4; // a toggled zone is locked from all dwellers
const DWELL_SECONDS = 0.8;
const COOLDOWN_SECONDS = 0.4;
const HYSTERESIS = 0.15;
const FILTER_FREQ = 60, FILTER_MINCUTOFF = 1.0, FILTER_BETA = 0.007;
const RECONNECT_MS = 1500;

// --------------------------------------------------------------------------- //
// Pure helpers (unit-tested under node, no DOM / socket)
// --------------------------------------------------------------------------- //

// Map a cursor id to a stable, well-spread hue in [0, 360).
// Uses the golden-angle so consecutive ids land far apart on the wheel. id=-1
// (the local mouse-test cursor) gets a fixed distinct hue so it never collides.
export function idToHue(id) {
  if (id === -1) return 200;
  // Spread non-negative ids with the golden angle (~137.508deg).
  const GOLDEN = 137.508;
  const h = ((id * GOLDEN) % 360 + 360) % 360;
  return h;
}

// Parse the wall-client URL params from a query string (e.g. location.search).
// Returns { wall, server, rows, cols } with sensible defaults so the client is
// usable with a bare URL.
export function parseParams(search) {
  const p = new URLSearchParams(search || "");
  const wall = p.get("wall") || "A";
  const server = p.get("server") || `ws://${(typeof location !== "undefined" && location.hostname) || "localhost"}:8770`;
  const rows = clampInt(p.get("rows"), 2, 1, 8);
  const cols = clampInt(p.get("cols"), 3, 1, 12);
  return { wall, server, rows, cols };
}

function clampInt(raw, dflt, lo, hi) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

// Shared per-zone lock registry. When any cursor commits a toggle on a zone, that
// zone id is recorded with an unlock time (t + ZONE_LOCK_SECONDS). A zone is
// "locked" for all dwellers until then, so two users dwelling the same tile cannot
// double-toggle it. Implemented as plain functions over a Map<zoneId, unlockT> so
// the policy is testable in isolation.
export function isZoneLocked(locks, zoneId, t) {
  const until = locks.get(zoneId);
  return until != null && t < until;
}

export function lockZone(locks, zoneId, t, lockSeconds = ZONE_LOCK_SECONDS) {
  locks.set(zoneId, t + lockSeconds);
}

// Drop expired lock entries (housekeeping so the Map does not grow unbounded).
export function pruneLocks(locks, t) {
  for (const [zoneId, until] of locks) if (t >= until) locks.delete(zoneId);
  return locks;
}

// Given a map of cursor states keyed by id, return the list of ids whose lastSeen
// is older than STALE_SECONDS relative to `t`. Pure so eviction is testable.
export function staleIds(cursors, t, staleSeconds = STALE_SECONDS) {
  const out = [];
  for (const [id, st] of cursors) if (t - st.lastSeen > staleSeconds) out.push(id);
  return out;
}

// Filter zones a dweller may act on this tick: zones NOT currently locked. The
// dweller still tracks (its ring fills), but a locked zone is invisible to its
// resolveTarget so it cannot commit. Returns a new array (does not mutate).
export function unlockedZones(zones, locks, t) {
  return zones.filter(z => !isZoneLocked(locks, z.id, t));
}

// --------------------------------------------------------------------------- //
// WS connection with auto-reconnect + hello handshake
// --------------------------------------------------------------------------- //
class WallSocket {
  constructor(url, wall, onCursors, onState) {
    this.url = url;
    this.wall = wall;
    this.onCursors = onCursors;     // (msg) => void   for {type:"cursors"}
    this.onState = onState;         // (state:string) => void
    this.ws = null;
    this._closed = false;
    this._reconnectTimer = null;
    this.connect();
  }
  connect() {
    if (this._closed) return;
    this.onState("connecting");
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.onState("connected");
      this._send({ type: "hello", wall: this.wall });
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg && msg.type === "cursors" && msg.wall === this.wall) this.onCursors(msg);
    };
    ws.onclose = () => { this.onState("disconnected"); this._scheduleReconnect(); };
    ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
  }
  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }
  _scheduleReconnect() {
    if (this._closed || this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect();
    }, RECONNECT_MS);
  }
  close() {
    this._closed = true;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this.ws) { try { this.ws.close(); } catch { /* ignore */ } }
  }
}

// --------------------------------------------------------------------------- //
// Colours
// --------------------------------------------------------------------------- //
const COLORS = {
  bg: "#18181c", zoneIdle: "#5a5a60", zoneSelected: "#46aa46",
  zoneLocked: "#aa8a46", text: "#ebebeb",
  midline: "rgba(240,180,60,0.55)",
};

// --------------------------------------------------------------------------- //
// Wall client app
// --------------------------------------------------------------------------- //
class WallClient {
  constructor(params) {
    this.wall = params.wall;
    this.rows = params.rows;
    this.cols = params.cols;
    this.serverUrl = params.server;

    this.canvas = document.getElementById("wall");
    this.ctx = this.canvas.getContext("2d");
    this.hud = document.getElementById("hud");

    this.zones = buildGrid(this.rows, this.cols, 0.06);
    // Per-cursor state: id -> { filter, dwell, hue, lastSeen, x, y, engaged, conf, progress }.
    this.cursors = new Map();
    // Shared per-zone lock: zoneId -> unlock-time (seconds).
    this.zoneLocks = new Map();

    this.connState = "connecting";
    this.mouseCursor = false;   // is the local mouse-test cursor (id=-1) active?

    this.socket = new WallSocket(
      this.serverUrl, this.wall,
      (msg) => this._onCursors(msg),
      (s) => { this.connState = s; },
    );

    this._resize();
    window.addEventListener("resize", () => this._resize());
    this._bindUI();
    requestAnimationFrame(() => this._frame());
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(window.innerWidth * dpr);
    this.canvas.height = Math.round(window.innerHeight * dpr);
    this.canvas.style.width = window.innerWidth + "px";
    this.canvas.style.height = window.innerHeight + "px";
  }

  // Ensure a per-cursor state object exists (lazily create its filter+dwell).
  _ensureCursor(id) {
    let st = this.cursors.get(id);
    if (!st) {
      st = {
        filter: new Point2DFilter(FILTER_FREQ, FILTER_MINCUTOFF, FILTER_BETA),
        dwell: new DwellSelector(DWELL_SECONDS, COOLDOWN_SECONDS, HYSTERESIS),
        hue: idToHue(id),
        lastSeen: 0, x: 0, y: 0, engaged: false, conf: 0, progress: 0,
      };
      this.cursors.set(id, st);
    }
    return st;
  }

  // Apply a server "cursors" frame: refresh raw position/engaged/conf + lastSeen.
  _onCursors(msg) {
    const t = performance.now() / 1000;
    for (const c of msg.cursors || []) {
      if (c.id === -1) continue;       // -1 is reserved for the local mouse cursor
      const st = this._ensureCursor(c.id);
      st.rawX = c.x; st.rawY = c.y;
      st.engaged = !!c.engaged;
      st.conf = c.conf ?? 0;
      st.lastSeen = t;
    }
  }

  // Inject/refresh the local mouse-test cursor (id=-1) from a canvas event.
  _setMouse(nx, ny) {
    const st = this._ensureCursor(-1);
    st.rawX = nx; st.rawY = ny;
    st.engaged = true; st.conf = 1.0;
    st.lastSeen = performance.now() / 1000;
    this.mouseCursor = true;
  }

  // --- main loop ---------------------------------------------------------
  _frame() {
    const t = performance.now() / 1000;

    // 1) Evict stale cursors (no fresh sample within STALE_SECONDS).
    for (const id of staleIds(this.cursors, t)) this.cursors.delete(id);

    // 2) Housekeep the shared zone-lock registry.
    pruneLocks(this.zoneLocks, t);

    // 3) Per cursor: dwell against the SHARED zones minus locked ones. The
    //    SERVER already smooths the pointer (server-side 1-Euro), so this
    //    example frontend uses its (x, y) directly — no client re-filtering.
    //    A different frontend can consume the same {id,x,y,engaged,conf} stream
    //    and do whatever it likes with the coordinates.
    for (const [, st] of this.cursors) {
      if (st.rawX == null) continue;
      st.x = Math.min(1, Math.max(0, st.rawX));
      st.y = Math.min(1, Math.max(0, st.rawY));

      // If this dweller is mid-dwell on a zone that just got locked by another
      // user, reset it: DwellSelector's sticky-hysteresis keeps a reference to its
      // own activeZone and would otherwise complete the toggle even though we hide
      // the zone below. Resetting guarantees a locked zone is ignored by ALL
      // dwellers, not just newly-arriving ones.
      if (st.dwell.activeZone && isZoneLocked(this.zoneLocks, st.dwell.activeZone.id, t))
        st.dwell.reset();

      // Dwell only sees zones that are not currently locked, so a recently-toggled
      // tile is ignored by every dweller for ZONE_LOCK_SECONDS.
      const visibleZones = unlockedZones(this.zones, this.zoneLocks, t);
      const event = st.dwell.update(visibleZones, [st.x, st.y], t, st.engaged);
      st.progress = st.dwell.progress;
      if (event) {
        // The dweller toggled `event.selected` on a Zone object inside visibleZones,
        // which is the SAME Zone instance as in this.zones (filter keeps refs).
        lockZone(this.zoneLocks, event.zoneId, t);
        // Opt-in: bridge the completed dwell to the Vibersyn projector (wall B).
        // No-op unless the wall was opened with ?vibersyn=<url>. See
        // web/vibersyn-bridge.js.
        if (typeof window !== "undefined" && window.__vibersynBridge)
          window.__vibersynBridge.onDwell(event, this.wall);
      }
    }

    this._draw(t);
    requestAnimationFrame(() => this._frame());
  }

  // --- drawing -----------------------------------------------------------
  _draw(t) {
    const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;
    ctx.fillStyle = COLORS.bg; ctx.fillRect(0, 0, W, H);

    // Zones.
    for (const z of this.zones) {
      const x1 = z.x * W, y1 = z.y * H, w = z.w * W, h = z.h * H;
      const locked = isZoneLocked(this.zoneLocks, z.id, t);
      if (z.selected) { ctx.fillStyle = COLORS.zoneSelected; ctx.fillRect(x1, y1, w, h); }
      ctx.lineWidth = locked ? 6 : 3;
      ctx.strokeStyle = locked ? COLORS.zoneLocked : (z.selected ? COLORS.zoneSelected : COLORS.zoneIdle);
      ctx.strokeRect(x1, y1, w, h);
      ctx.fillStyle = COLORS.text;
      ctx.font = `${Math.round(H * 0.05)}px system-ui, sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(z.label, x1 + w / 2, y1 + h / 2);
    }

    this._drawHalfwayMarkers();

    // Cursors.
    let n = 0;
    for (const [id, st] of this.cursors) {
      if (st.rawX == null) continue;
      n++;
      if (st.engaged) this._drawCursor(id, st, W, H);
    }

    this._drawHud(n);
  }

  // Dashed cross through the screen centre, marking the horizontal and vertical
  // halfway points, with a solid dot at the very middle.
  _drawHalfwayMarkers() {
    const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;
    const cx = W / 2, cy = H / 2;
    ctx.save();
    ctx.strokeStyle = COLORS.midline;
    ctx.lineWidth = Math.max(1, Math.round(H * 0.002));
    ctx.setLineDash([14, 12]);
    ctx.beginPath();
    ctx.moveTo(cx, 0); ctx.lineTo(cx, H);   // vertical midline (½ width)
    ctx.moveTo(0, cy); ctx.lineTo(W, cy);   // horizontal midline (½ height)
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = COLORS.midline;
    ctx.beginPath(); ctx.arc(cx, cy, Math.max(5, H * 0.01), 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  _drawCursor(id, st, W, H) {
    const ctx = this.ctx;
    const cx = st.x * W, cy = st.y * H;
    const r = Math.round(H * 0.03);
    const hue = st.hue;
    const ringBg = `hsl(${hue}, 40%, 35%)`;
    const ringFg = `hsl(${hue}, 85%, 60%)`;
    const dot = `hsl(${hue}, 85%, 58%)`;

    // Dwell ring background.
    ctx.lineWidth = 4; ctx.strokeStyle = ringBg;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    // Dwell progress arc.
    if (st.progress > 0) {
      ctx.lineWidth = 7; ctx.strokeStyle = ringFg;
      ctx.beginPath();
      ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * st.progress);
      ctx.stroke();
    }
    // Cursor dot.
    ctx.fillStyle = dot;
    ctx.beginPath(); ctx.arc(cx, cy, Math.max(5, r * 0.22), 0, Math.PI * 2); ctx.fill();

    // Id badge.
    const label = id === -1 ? "mouse" : `#${id}`;
    ctx.font = `bold ${Math.round(H * 0.02)}px system-ui, sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "bottom";
    const tw = ctx.measureText(label).width;
    const bx = cx, by = cy - r - H * 0.008;
    ctx.fillStyle = "rgba(20,20,26,0.7)";
    ctx.fillRect(bx - tw / 2 - 6, by - H * 0.022, tw + 12, H * 0.024);
    ctx.fillStyle = ringFg;
    ctx.fillText(label, bx, by);
  }

  _drawHud(userCount) {
    const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;
    const dot = { connected: "#46dc6e", connecting: "#dcc846", disconnected: "#dc4646" }[this.connState] || "#888";
    const txt = `wall ${this.wall}  ·  ${userCount} user${userCount === 1 ? "" : "s"}  ·  ${this.connState}`;
    ctx.font = `${Math.round(H * 0.025)}px system-ui, sans-serif`;
    ctx.textAlign = "left"; ctx.textBaseline = "top";
    const pad = W * 0.012, y = H * 0.02, rad = H * 0.01;
    // Connection indicator dot.
    ctx.fillStyle = dot;
    ctx.beginPath(); ctx.arc(pad + rad, y + rad, rad, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = COLORS.text;
    ctx.fillText(txt, pad + 2 * rad + 8, y);

    // Also reflect into the DOM HUD if present.
    if (this.hud) this.hud.textContent = txt;
  }

  // --- UI ----------------------------------------------------------------
  _bindUI() {
    // Mouse-test fallback: moving the mouse over the canvas injects cursor id=-1.
    this.canvas.addEventListener("mousemove", (e) => {
      this._setMouse(e.clientX / window.innerWidth, e.clientY / window.innerHeight);
    });
    // Leaving the canvas lets the mouse cursor go stale and be evicted.

    window.addEventListener("keydown", (e) => {
      if (e.key === "f") this._toggleFullscreen();
    });

    // Visible fullscreen button (each projector window needs its own click — a
    // browser can only fullscreen the window the click happened in).
    const fsbtn = document.getElementById("fsbtn");
    if (fsbtn) fsbtn.addEventListener("click", () => this._toggleFullscreen());

    // Hide the overlays (button/HUD/hint) while fullscreen so the wall is clean.
    document.addEventListener("fullscreenchange", () => {
      document.body.classList.toggle("fs", !!document.fullscreenElement);
    });
  }

  _toggleFullscreen() {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen();
    else document.exitFullscreen();
  }
}

// --------------------------------------------------------------------------- //
// Bootstrap (skipped under node — no document)
// --------------------------------------------------------------------------- //
if (typeof document !== "undefined") {
  window.addEventListener("DOMContentLoaded", () => {
    const params = parseParams(typeof location !== "undefined" ? location.search : "");
    // Surface the resolved params for debugging.
    console.log(`[wall] wall=${params.wall} server=${params.server} grid=${params.rows}x${params.cols}`);
    new WallClient(params);
  });
}
