// Gesture Wall — browser port of the Stack A pipeline.
//
// Ports the exact selection logic from the Python prototype so behaviour matches:
//   pose wrist -> mirror -> homography (calibration) -> 1-Euro smoothing
//   -> DwellSelector -> zone toggle, with raise-hand-to-engage gating.
//
// Pure-logic classes (OneEuroFilter, Zone, DwellSelector, Homography) live in
// ./core.js — a shared module ported from gesturewall/{filters,zones,dwell,
// calibration}.py. This file keeps the camera/MediaPipe glue and the App.

import {
  FilesetResolver,
  PoseLandmarker,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

import {
  OneEuroFilter,
  Point2DFilter,
  Zone,
  buildGrid,
  DwellSelector,
  Homography,
  WALL_CORNERS,
  CORNER_NAMES,
} from "./core.js";

// BlazePose 33-landmark indices (same order as the Tasks API flat list).
const LEFT_SHOULDER = 11, RIGHT_SHOULDER = 12;
const LEFT_WRIST = 15, RIGHT_WRIST = 16;

const POSE_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/" +
  "pose_landmarker_lite/float16/latest/pose_landmarker_lite.task";
const WASM_BASE =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";

// --------------------------------------------------------------------------- //
// Pose source — webcam + MediaPipe Tasks PoseLandmarker  (port of PoseSource)
// --------------------------------------------------------------------------- //
class PoseSource {
  constructor(landmarker, video, { mirror = true } = {}) {
    this.landmarker = landmarker;
    this.video = video;
    this.mirror = mirror;
    this._lastTs = -1;
  }
  read() {
    const v = this.video;
    if (v.readyState < 2) return { pointer: null, engaged: false, status: "no_frame" };
    let ts = Math.round(performance.now());
    if (ts <= this._lastTs) ts = this._lastTs + 1;
    this._lastTs = ts;
    const result = this.landmarker.detectForVideo(v, ts);
    const lms = result.landmarks;
    if (!lms || lms.length === 0)
      return { pointer: null, engaged: false, status: "no_pose" };
    const lm = lms[0];
    const rw = lm[RIGHT_WRIST], lw = lm[LEFT_WRIST];
    // Pick the higher (more raised) wrist; image y grows downward.
    let wrist, shoulder;
    if (rw.y <= lw.y) { wrist = rw; shoulder = lm[RIGHT_SHOULDER]; }
    else { wrist = lw; shoulder = lm[LEFT_SHOULDER]; }
    const visible = (wrist.visibility ?? 1.0) >= 0.5;
    const engaged = visible && wrist.y < shoulder.y;
    // Mirror so moving right -> cursor right (Python flips the frame pre-detect).
    const px = this.mirror ? 1 - wrist.x : wrist.x;
    return { pointer: [px, wrist.y], engaged, status: "ok" };
  }
}

// Mouse source for camera-free testing of the full pipeline.
class MouseSource {
  constructor() { this.pointer = null; this.engaged = false; }
  setPointer(x, y) { this.pointer = [x, y]; this.engaged = true; }
  read() { return { pointer: this.pointer, engaged: this.engaged, status: "mouse" }; }
}

// --------------------------------------------------------------------------- //
// App
// --------------------------------------------------------------------------- //
const COLORS = {
  bg: "#18181c", zoneIdle: "#5a5a60", zoneSelected: "#46aa46",
  zoneActive: "#3cc8dc", text: "#ebebeb", cursor: "#3cc8dc",
  ringBg: "#46464c", ringFg: "#3cdcf0",
  midline: "rgba(240,180,60,0.55)",
};

class App {
  constructor() {
    this.canvas = document.getElementById("wall");
    this.ctx = this.canvas.getContext("2d");
    this.video = document.getElementById("cam");
    this.preview = document.getElementById("preview");
    this.previewCtx = this.preview.getContext("2d");
    this.status = document.getElementById("status");

    this.rows = 2; this.cols = 3;
    this.padding = 0.06;
    this.dwell = 0.8; this.cooldown = 0.4; this.hysteresis = 0.15;
    this.minCutoff = 1.0; this.beta = 0.007; this.useFilter = true;
    this.mirror = true; this.showPreview = true;

    this.source = new MouseSource();   // start in mouse mode until camera starts
    this.mode = "MOUSE TEST";
    this.homography = Homography.identity();
    this._loadCalibration();

    this.landmarker = null;
    this.calibrating = false;
    this.calibCaptured = [];
    this.autoCalib = false;          // auto mode: countdown per corner instead of SPACE
    this.calibCountdownSec = 10;     // seconds to hold each corner before auto-capture
    this._calibRemaining = 0;        // seconds left on the current corner (auto mode)
    this._calibLastT = null;         // last tick time, for the countdown delta
    this.fps = 0; this._prev = performance.now() / 1000;

    this._rebuild();
    this._bindUI();
    this._resize();
    window.addEventListener("resize", () => this._resize());
    requestAnimationFrame(() => this._frame());
  }

  _rebuild() {
    this.zones = buildGrid(this.rows, this.cols, this.padding);
    this.selector = new DwellSelector(this.dwell, this.cooldown, this.hysteresis);
    this.pfilter = this.useFilter ? new Point2DFilter(60, this.minCutoff, this.beta) : null;
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(window.innerWidth * dpr);
    this.canvas.height = Math.round(window.innerHeight * dpr);
    this.canvas.style.width = window.innerWidth + "px";
    this.canvas.style.height = window.innerHeight + "px";
  }

  // --- input -------------------------------------------------------------
  async startCamera() {
    this.setStatus("starting camera…");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
        audio: false,
      });
      this.video.srcObject = stream;
      await this.video.play();
    } catch (e) {
      this.setStatus(`camera blocked: ${e.name}. Allow camera access and retry.`);
      return;
    }
    if (!this.landmarker) {
      this.setStatus("loading pose model…");
      const vision = await FilesetResolver.forVisionTasks(WASM_BASE);
      this.landmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: POSE_MODEL_URL, delegate: "GPU" },
        runningMode: "VIDEO",
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
    }
    this.source = new PoseSource(this.landmarker, this.video, { mirror: this.mirror });
    this.mode = "POSE";
    this.setStatus("pose mode — raise a hand above your shoulder to engage");
  }

  useMouse() {
    this.source = new MouseSource();
    this.mode = "MOUSE TEST";
    this.setStatus("mouse test mode — move over a tile and hold still");
  }

  // --- calibration -------------------------------------------------------
  startCalibration() {
    this.calibrating = true;
    this.calibCaptured = [];
    this._calibRemaining = this.calibCountdownSec;
    this._calibLastT = null;
    this.setStatus(this.autoCalib
      ? `auto-calibration: hold on the ${CORNER_NAMES[0]} corner — captures in ${this.calibCountdownSec}s (SPACE to capture now)`
      : `calibration: point at the ${CORNER_NAMES[0]} corner, then press SPACE`);
  }

  _tickCalibration(read, t) {
    const clamp = v => Math.min(1, Math.max(0, v));
    const raw = read.pointer ? [clamp(read.pointer[0]), clamp(read.pointer[1])] : null;
    let countdown = null;
    if (this.autoCalib) {
      if (raw) {
        // Only run the clock down while a pointer is visible (so it pauses if
        // you step out of view). Capture whatever the pointer reads at zero.
        if (this._calibLastT != null) this._calibRemaining -= (t - this._calibLastT);
        this._calibLastT = t;
        if (this._calibRemaining <= 0) { this._doCapture(raw); return; }
        countdown = this._calibRemaining;
      } else {
        this._calibLastT = t;                 // keep the clock fresh; don't decrement
        countdown = this._calibRemaining;
      }
    }
    this._drawCalibration(raw, countdown);
  }

  _doCapture(raw) {
    this.calibCaptured.push([Math.min(1, Math.max(0, raw[0])), Math.min(1, Math.max(0, raw[1]))]);
    this._calibRemaining = this.calibCountdownSec;   // reset the countdown for the next corner
    this._calibLastT = null;
    const n = this.calibCaptured.length;
    if (n === 4) {
      try {
        this.homography = Homography.fromCornerPoints(this.calibCaptured);
        this._saveCalibration();
        this.setStatus("calibration saved ✓");
      } catch (e) {
        this.setStatus(`calibration failed: ${e.message} — re-run and move clearly to each corner`);
      }
      this.calibrating = false;
    } else {
      this.setStatus(this.autoCalib
        ? `captured ${n}/4 — now hold on the ${CORNER_NAMES[n]} corner (${this.calibCountdownSec}s)`
        : `captured ${n}/4 — now point at the ${CORNER_NAMES[n]} corner, then press SPACE`);
    }
  }

  _loadCalibration() {
    try {
      const raw = localStorage.getItem("gesturewall.calibration");
      if (raw) this.homography = new Homography(JSON.parse(raw).matrix);
    } catch { /* ignore */ }
  }
  _saveCalibration() {
    localStorage.setItem("gesturewall.calibration",
      JSON.stringify({ matrix: this.homography.matrix }));
  }
  resetCalibration() {
    this.homography = Homography.identity();
    localStorage.removeItem("gesturewall.calibration");
    this.setStatus("calibration reset to identity");
  }

  resetSelections() {
    for (const z of this.zones) z.selected = false;
    this.selector.reset();
  }

  // --- main loop ---------------------------------------------------------
  _frame() {
    const t = performance.now() / 1000;
    const read = this.source.read();
    this._lastRead = read;
    const { pointer, engaged } = read;

    let cursor = null;
    if (pointer != null) {
      let [wx, wy] = this.homography.apply(pointer[0], pointer[1]);
      if (this.pfilter) [wx, wy] = this.pfilter.call(wx, wy, t);
      cursor = [Math.min(1, Math.max(0, wx)), Math.min(1, Math.max(0, wy))];
    }

    if (this.calibrating) {
      this._tickCalibration(read, t);
    } else {
      const event = this.selector.update(this.zones, cursor, t, engaged);
      if (event) console.log(`[gesturewall] ${event.selected ? "SELECT" : "DESELECT"} ${event.zoneId}`);
      this._draw(cursor, engaged);
    }

    if (this.showPreview && this.mode === "POSE") this._drawPreview();
    else this.preview.style.display = "none";

    const dt = t - this._prev; this._prev = t;
    if (dt > 0) this.fps = 0.9 * this.fps + 0.1 * (1 / dt);
    requestAnimationFrame(() => this._frame());
  }

  // --- drawing -----------------------------------------------------------
  _draw(cursor, engaged) {
    const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;
    ctx.fillStyle = COLORS.bg; ctx.fillRect(0, 0, W, H);

    for (const z of this.zones) {
      const x1 = z.x * W, y1 = z.y * H, w = z.w * W, h = z.h * H;
      const isActive = this.selector.activeZone === z;
      if (z.selected) { ctx.fillStyle = COLORS.zoneSelected; ctx.fillRect(x1, y1, w, h); }
      ctx.lineWidth = isActive ? 6 : 3;
      ctx.strokeStyle = isActive ? COLORS.zoneActive : (z.selected ? COLORS.zoneSelected : COLORS.zoneIdle);
      ctx.strokeRect(x1, y1, w, h);
      ctx.fillStyle = COLORS.text;
      ctx.font = `${Math.round(H * 0.05)}px system-ui, sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(z.label, x1 + w / 2, y1 + h / 2);
    }

    this._drawHalfwayMarkers();

    if (engaged && cursor) this._drawCursor(cursor[0] * W, cursor[1] * H, this.selector.progress);

    const statusTxt = engaged ? "ENGAGED" : "idle (raise hand / move mouse in)";
    ctx.fillStyle = COLORS.text;
    ctx.font = `${Math.round(H * 0.025)}px system-ui, sans-serif`;
    ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.fillText(`${this.mode} | ${statusTxt} | ${this.fps.toFixed(1)} fps`, W * 0.012, H * 0.02);
  }

  // Dashed cross through the screen centre, marking the horizontal and vertical
  // halfway points, with a small ring + tick labels at the very middle.
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

  _drawCursor(cx, cy, progress) {
    const ctx = this.ctx, r = Math.round(this.canvas.height * 0.03);
    ctx.lineWidth = 4; ctx.strokeStyle = COLORS.ringBg;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    if (progress > 0) {
      ctx.lineWidth = 7; ctx.strokeStyle = COLORS.ringFg;
      ctx.beginPath();
      ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
      ctx.stroke();
    }
    ctx.fillStyle = COLORS.cursor;
    ctx.beginPath(); ctx.arc(cx, cy, Math.max(5, r * 0.22), 0, Math.PI * 2); ctx.fill();
  }

  // Interactive corner calibration: a pulsing labeled target shows which corner
  // to point at, others are dim/numbered, captured ones get a green check, and a
  // guide line connects the live cursor to the active target. Press SPACE to capture.
  _drawCalibration(raw, countdown = null) {
    const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() * 0.006);
    const idx = this.calibCaptured.length;
    const px = c => [c[0] * W, c[1] * H];
    ctx.fillStyle = COLORS.bg; ctx.fillRect(0, 0, W, H);

    // Faint wall boundary through the four target corners.
    ctx.strokeStyle = "#3a3a44"; ctx.lineWidth = 2; ctx.setLineDash([10, 10]);
    ctx.beginPath();
    WALL_CORNERS.forEach((c, i) => { const [x, y] = px(c); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.closePath(); ctx.stroke(); ctx.setLineDash([]);

    // The "reach quad" forming from captured points (+ live cursor as next vertex).
    if (idx > 0) {
      const pts = this.calibCaptured.map(px);
      const poly = raw ? [...pts, px(raw)] : pts;
      ctx.beginPath();
      poly.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
      if (idx >= 2) { ctx.closePath(); ctx.fillStyle = "rgba(60,200,220,0.08)"; ctx.fill(); }
      ctx.strokeStyle = "rgba(60,200,220,0.5)"; ctx.lineWidth = 2; ctx.stroke();
    }

    // Target corner markers.
    WALL_CORNERS.forEach((c, i) => {
      const [x, y] = px(c);
      const dir = [Math.sign(0.5 - c[0]) || 1, Math.sign(0.5 - c[1]) || 1];
      if (i < idx) {                                   // already captured -> green check
        ctx.fillStyle = COLORS.zoneSelected;
        ctx.beginPath(); ctx.arc(x, y, H * 0.018, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = "#e6ffe6"; ctx.lineWidth = 4; ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(x - H * 0.008, y); ctx.lineTo(x - H * 0.002, y + H * 0.007);
        ctx.lineTo(x + H * 0.009, y - H * 0.008); ctx.stroke();
      } else if (i === idx) {                          // active -> pulsing rings + label
        for (let k = 0; k < 3; k++) {
          const rr = H * 0.035 * (0.6 + 0.5 * k) + pulse * H * 0.012;
          ctx.strokeStyle = `rgba(60,220,240,${0.75 - 0.22 * k})`;
          ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2); ctx.stroke();
        }
        ctx.fillStyle = COLORS.ringFg;
        ctx.beginPath(); ctx.arc(x, y, H * 0.01, 0, Math.PI * 2); ctx.fill();
        ctx.font = `bold ${Math.round(H * 0.045)}px system-ui, sans-serif`;
        ctx.textAlign = dir[0] > 0 ? "left" : "right"; ctx.textBaseline = "middle";
        ctx.fillStyle = COLORS.ringFg;
        ctx.fillText(CORNER_NAMES[i], x + dir[0] * H * 0.06, y + dir[1] * H * 0.06);
        if (countdown != null) {                       // auto mode: big countdown
          ctx.font = `bold ${Math.round(H * 0.06)}px system-ui, sans-serif`;
          ctx.fillStyle = "#fff";
          ctx.fillText(`${Math.ceil(countdown)}`, x + dir[0] * H * 0.06, y + dir[1] * H * 0.06 + H * 0.065);
        }
      } else {                                         // pending -> dim numbered ring
        ctx.strokeStyle = "#55555f"; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(x, y, H * 0.02, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = "#8a8a96"; ctx.font = `${Math.round(H * 0.025)}px system-ui, sans-serif`;
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(String(i + 1), x, y);
      }
    });

    // Live cursor (the detected wrist) + a guide line to the active target.
    if (raw) {
      const [cx, cy] = px(raw), [tx, ty] = px(WALL_CORNERS[idx]);
      ctx.strokeStyle = "rgba(255,255,255,0.18)"; ctx.lineWidth = 2; ctx.setLineDash([6, 8]);
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(tx, ty); ctx.stroke(); ctx.setLineDash([]);
      const prog = countdown != null ? Math.min(1, Math.max(0, 1 - countdown / this.calibCountdownSec)) : 0;
      this._drawCursor(cx, cy, prog);
    }

    // Header + sub-instruction + footer.
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    ctx.font = `bold ${Math.round(H * 0.034)}px system-ui, sans-serif`;
    ctx.fillStyle = COLORS.text;
    ctx.fillText(`Calibration — Corner ${idx + 1} of 4`, W / 2, H * 0.03);
    ctx.font = `${Math.round(H * 0.026)}px system-ui, sans-serif`;
    ctx.fillStyle = raw ? COLORS.ringFg : "#9a9ad0";
    ctx.fillText(
      raw ? (this.autoCalib
              ? `Hold on the ${CORNER_NAMES[idx]} corner — capturing in ${Math.ceil(countdown ?? this.calibCountdownSec)}s`
              : `Point at the ${CORNER_NAMES[idx]} corner, then press SPACE`)
          : (this.mode === "POSE" ? "Step into the camera view (timer paused)" : "Move the mouse to begin"),
      W / 2, H * 0.03 + H * 0.05);
    ctx.textBaseline = "bottom";
    ctx.font = `${Math.round(H * 0.022)}px system-ui, sans-serif`;
    ctx.fillStyle = "#bcbcc6";
    ctx.fillText(this.autoCalib
      ? "Auto: hold each corner until the timer reaches 0 · SPACE captures now · Esc cancels"
      : "Point at the highlighted corner · press SPACE to capture · Esc to cancel", W / 2, H - H * 0.03);
  }

  _drawPreview() {
    const v = this.video;
    if (v.readyState < 2) { this.preview.style.display = "none"; return; }
    this.preview.style.display = "block";
    const pw = this.preview.width, ph = this.preview.height;
    this.previewCtx.save();
    if (this.mirror) { this.previewCtx.translate(pw, 0); this.previewCtx.scale(-1, 1); }
    this.previewCtx.drawImage(v, 0, 0, pw, ph);
    this.previewCtx.restore();
  }

  setStatus(msg) { this.status.textContent = msg; }

  // --- UI ----------------------------------------------------------------
  _bindUI() {
    const $ = id => document.getElementById(id);
    $("startCam").onclick = () => this.startCamera();
    $("useMouse").onclick = () => this.useMouse();
    $("calibrate").onclick = () => this.startCalibration();
    $("resetCalib").onclick = () => this.resetCalibration();
    $("reset").onclick = () => this.resetSelections();
    $("fullscreen").onclick = () => this._toggleFullscreen();

    const bind = (id, key, parse, rebuild = true) => {
      const el = $(id);
      el.oninput = () => {
        this[key] = parse(el.value);
        const out = $(id + "Val"); if (out) out.textContent = el.value;
        if (rebuild) this._rebuild();
      };
    };
    bind("rows", "rows", v => parseInt(v));
    bind("cols", "cols", v => parseInt(v));
    bind("dwell", "dwell", v => parseFloat(v));
    bind("minCutoff", "minCutoff", v => parseFloat(v));
    bind("beta", "beta", v => parseFloat(v));

    $("mirror").onchange = e => {
      this.mirror = e.target.checked;
      if (this.source instanceof PoseSource) this.source.mirror = this.mirror;
    };
    $("filter").onchange = e => { this.useFilter = e.target.checked; this._rebuild(); };
    $("previewToggle").onchange = e => { this.showPreview = e.target.checked; };
    const autoEl = $("autoCalib");
    if (autoEl) autoEl.onchange = e => { this.autoCalib = e.target.checked; };
    const autoSecsEl = $("autoSecs");
    if (autoSecsEl) autoSecsEl.oninput = () => {
      this.calibCountdownSec = parseInt(autoSecsEl.value);
      const out = $("autoSecsVal"); if (out) out.textContent = autoSecsEl.value;
    };

    // Mouse drives the cursor in mouse-test mode.
    this.canvas.addEventListener("mousemove", e => {
      if (this.source instanceof MouseSource)
        this.source.setPointer(e.clientX / window.innerWidth, e.clientY / window.innerHeight);
    });

    window.addEventListener("keydown", e => {
      if (e.key === "r") this.resetSelections();
      else if (e.key === "c") this.startCalibration();
      else if (e.key === "f") this._toggleFullscreen();
      else if (e.key === " " && this.calibrating) {
        e.preventDefault();
        // Capture the detected wrist regardless of the raise-hand engage gate —
        // the bottom corners need you to point low (hand below the shoulder).
        const r = this._lastRead?.pointer;
        if (r) this._doCapture(r);
        else this.setStatus(this.mode === "POSE" ? "step into the camera view to capture" : "move the mouse to capture");
      }
      else if (e.key === "Escape" && this.calibrating) { this.calibrating = false; this.setStatus("calibration cancelled"); }
    });
  }

  _toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
      document.getElementById("panel").classList.remove("pinned");  // auto-hide while projecting
    } else {
      document.exitFullscreen();
    }
  }
}

window.addEventListener("DOMContentLoaded", () => new App());
