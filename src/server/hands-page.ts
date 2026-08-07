// GET /hands — the guest hand-controls page. People on the room LAN open this
// on THEIR OWN computer and drive the wall's dwell-to-click layer from it.
//
// Deliberately self-contained (inline CSS/JS, no build step, no framework):
// served straight from the API process on every listener (main bind, the
// 0.0.0.0 phone listener, and the optional TLS listener), so it must work
// without the Vite bundle on any modern browser.
//
// Two input modes, both speaking the same guest WS protocol (/hands/ws):
//   ✋ Camera — in-browser MediaPipe hand tracking on the guest's webcam.
//      Cursor = palm-knuckle centroid, mirrored, mapped through a central
//      interaction-zone inset (full wall reach without stretching off camera)
//      and One-Euro filtered (port of gesture-wall/gesturewall/filters.py).
//      Engage = pinch: |thumb_tip−index_tip| over a foreshortening-robust palm
//      scale, same ON<0.30/OFF>0.45 thresholds as the room's standalone bridge
//      (gesture-wall/touchdesigner/hands_mediapipe.py) but frame-debounced,
//      velocity-gated, and click-position-anchored — the pinch motion itself
//      must not drag the click off-target. Needs a secure context (the TLS
//      listener's https URL, or localhost on the host machine) — browsers
//      refuse getUserMedia on plain LAN http. Tracking runs entirely on the
//      guest's machine; only tiny cursor frames cross the network.
//   🖱 Trackpad — always works, everywhere: the pad maps 1:1 onto the wall
//      (16:9). Hover to aim (dimmed dot), press-and-hold still to dwell-click.
//
// MediaPipe is SELF-HOSTED: the tracker bundle, wasm, and hand model are
// served by this room server under /hands/assets (registered in app.ts) — a
// guest device needs zero internet, only the room LAN.

export function handsPageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Vibersyn — hand controls</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; flex-direction: column; align-items: center;
    background: #0b0e14; color: #e6e9f0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  main { width: min(46rem, calc(100vw - 2rem)); padding: 1.25rem 0 2rem; }
  header.top { display: flex; align-items: baseline; gap: 0.75rem; flex-wrap: wrap; }
  h1 { font-size: 1.15rem; margin: 0; }
  .status { font-size: 0.8rem; padding: 0.2rem 0.6rem; border-radius: 1rem; border: 1px solid #2a3040; color: #8b93a7; }
  .status[data-state="live"] { color: #7ee2a8; border-color: #2c5a41; }
  .status[data-state="connecting"] { color: #f0c674; border-color: #5a4c2c; }
  .you { display: inline-flex; align-items: center; gap: 0.4rem; font-size: 0.8rem; color: #8b93a7; }
  .you .dot { width: 0.7rem; height: 0.7rem; border-radius: 50%; background: #5b8cff; box-shadow: 0 0 8px currentColor; }
  .tabs { display: flex; gap: 0.5rem; margin: 1rem 0 0.75rem; }
  .tabs button {
    padding: 0.55rem 0.9rem; font-size: 0.95rem; border-radius: 0.6rem; cursor: pointer;
    border: 1px solid #2a3040; background: #131826; color: #8b93a7;
  }
  .tabs button[aria-pressed="true"] { color: #e6e9f0; border-color: #5b8cff; background: #17203a; }
  .walls { display: flex; gap: 0.4rem; margin-left: auto; }
  .walls button {
    padding: 0.45rem 0.7rem; font-size: 0.8rem; border-radius: 0.6rem; cursor: pointer;
    border: 1px solid #2a3040; background: #131826; color: #8b93a7;
  }
  .walls button[aria-pressed="true"] { color: #e6e9f0; border-color: #7ee2a8; }
  .banner { border: 1px solid #5a4c2c; background: #1c1810; color: #f0c674; border-radius: 0.6rem;
    padding: 0.6rem 0.85rem; font-size: 0.85rem; margin: 0.5rem 0; }
  .banner a { color: #9db9ff; }
  .banner[hidden] { display: none; }
  .surface { position: relative; width: 100%; aspect-ratio: 16 / 9; border-radius: 0.9rem;
    border: 1px solid #2a3040; background: #0e1320; overflow: hidden; touch-action: none; }
  .surface[hidden] { display: none; }
  #pad-dot { position: absolute; width: 18px; height: 18px; margin: -9px 0 0 -9px; border-radius: 50%;
    background: #5b8cff; opacity: 0; pointer-events: none; box-shadow: 0 0 14px currentColor; }
  #pad-hint { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    color: #46506a; font-size: 0.95rem; text-align: center; padding: 1rem; pointer-events: none; }
  #cam-canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
  #cam-note { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    color: #8b93a7; font-size: 0.95rem; text-align: center; padding: 1.5rem; }
  #cam-note a { color: #9db9ff; }
  #cam-status { position: absolute; left: 0; right: 0; bottom: 0.4rem; text-align: center;
    color: #8b93a7; font-size: 0.8rem; pointer-events: none; text-shadow: 0 1px 3px #0b0e14; }
  #cam-status[hidden] { display: none; }
  p.hint { color: #8b93a7; font-size: 0.85rem; line-height: 1.5; margin: 0.85rem 0 0; }
  .wasd-row { display: flex; align-items: center; justify-content: center; gap: 1.25rem; margin-top: 0.9rem; }
  .wasd { display: grid; grid-template-columns: repeat(3, 3.4rem); grid-template-rows: repeat(2, 3.4rem); gap: 0.4rem; }
  .wasd button {
    font-size: 1.15rem; font-weight: 700; border-radius: 0.7rem; cursor: pointer;
    border: 1px solid #2a3040; background: #131826; color: #8b93a7;
    touch-action: none; -webkit-user-select: none; user-select: none;
  }
  .wasd button[data-held="1"] { color: #0b0e14; background: #5b8cff; border-color: #5b8cff; }
  .wasd .k-w { grid-column: 2; grid-row: 1; }
  .wasd .k-a { grid-column: 1; grid-row: 2; }
  .wasd .k-s { grid-column: 2; grid-row: 2; }
  .wasd .k-d { grid-column: 3; grid-row: 2; }
  .wasd-label { color: #46506a; font-size: 0.8rem; max-width: 11rem; line-height: 1.4; }
  @media (max-width: 30rem) {
    main { padding-top: 0.75rem; }
    .wasd { grid-template-columns: repeat(3, 3rem); grid-template-rows: repeat(2, 3rem); }
  }
</style>
</head>
<body>
<main>
  <header class="top">
    <h1>✋ Vibersyn hand controls</h1>
    <span class="status" id="status" data-testid="guest-status" data-state="connecting">connecting…</span>
    <span class="you" id="you" hidden><span class="dot" id="you-dot"></span>your dot on the wall</span>
  </header>

  <div class="banner" id="no-wall-banner" hidden data-testid="guest-no-wall">
    No wall is listening for guests right now — open the room wall (run-room.sh; guest
    hands is on by default) and this page connects by itself.
  </div>

  <div class="tabs" role="tablist">
    <button type="button" id="mode-hands" data-testid="guest-mode-hands" aria-pressed="false">✋ Camera hands</button>
    <button type="button" id="mode-pad" data-testid="guest-mode-pad" aria-pressed="true">🖱 Trackpad</button>
    <span class="walls" id="walls" data-testid="guest-walls"></span>
  </div>

  <div class="surface" id="pad" data-testid="guest-pad">
    <div id="pad-hint">hover to aim · hold still to click — or press to click instantly</div>
    <div id="pad-dot"></div>
  </div>

  <div class="surface" id="cam" hidden>
    <canvas id="cam-canvas"></canvas>
    <div id="cam-note">starting camera…</div>
    <div id="cam-status" hidden>pinch to click — your cursor freezes while pinched</div>
  </div>

  <!-- Remote WASD: walk the wall's 3D camera (same fly-through the desk
       keyboard drives). Works in BOTH modes, multi-touch: hold W+D to walk a
       curve while your other thumb aims on the pad. -->
  <div class="wasd-row" data-testid="guest-wasd">
    <div class="wasd">
      <button type="button" class="k-w" data-key="w" data-testid="guest-key-w">W</button>
      <button type="button" class="k-a" data-key="a" data-testid="guest-key-a">A</button>
      <button type="button" class="k-s" data-key="s" data-testid="guest-key-s">S</button>
      <button type="button" class="k-d" data-key="d" data-testid="guest-key-d">D</button>
    </div>
    <div class="wasd-label">walk the room camera — W/S forward &amp; back, A/D strafe (hold them)</div>
  </div>

  <p class="hint">
    This pad is the wall: your dot appears on the room screen where you point. To click something,
    hold your cursor still on it until the ring around it completes (~1s) — or press/pinch while
    on it to click instantly. Camera mode: point by moving your open hand, click by
    <strong>pinching</strong> thumb+index; your cursor freezes while pinched, so the click always
    lands where you aimed. Hand tracking runs entirely in your browser — only cursor positions are sent.
  </p>
</main>
<script type="module">
(() => {
  const SEND_MIN_MS = 33;          // ≤30 Hz on the wire
  const HEARTBEAT_MS = 100;        // keep a still cursor alive (wall evicts at 0.5s)
  const PINCH_ON = 0.30;           // ratio thresholds: hands_mediapipe.py parity
  const PINCH_OFF = 0.45;
  const PALM = [0, 5, 9, 13, 17];  // wrist + finger-base knuckles: pinching barely moves this centroid
  // One-Euro cursor filter (Casiez et al.) — values match the repo's Kinect-side
  // filters (gesture-wall/gesturewall/filters.py): mincutoff kills still-hand
  // jitter, beta lets fast sweeps cut through the added lag.
  const ONE_EURO_MINCUTOFF = 1.0;
  const ONE_EURO_BETA = 0.02;
  const ONE_EURO_DCUTOFF = 1.0;
  // Pinch ratio gets its own slower scalar One-Euro: it only feeds a debounced
  // threshold, so smoothing beats responsiveness.
  const PINCH_EURO_MINCUTOFF = 0.8;
  const PINCH_EURO_BETA = 0.01;
  // Interaction-zone inset ("PHIZ"): a comfortable central sub-rect of the
  // camera frame maps to the FULL wall — edges reachable without stretching off
  // camera, and the 4:3 camera → 16:9 wall anisotropy stops mattering. Y is
  // upper-middle: arms drop over a session, they don't rise.
  const INSET_X_MIN = 0.18, INSET_X_MAX = 0.82;
  const INSET_Y_MIN = 0.12, INSET_Y_MAX = 0.70;
  // Pinch debounce (frames): a single noisy ratio frame can no longer click.
  const PINCH_ON_FRAMES = 2;       // consecutive below-ON frames to engage
  const PINCH_OFF_FRAMES = 3;      // consecutive above-OFF frames to release
  const HAND_LOST_FRAMES = 5;      // pinch survives 1–2-frame tracking dropouts; gone this long → force release
  const ENGAGE_MAX_SPEED = 0.9;    // normalized units/sec (pre-filter): moving this fast suppresses NEW engage votes, never release
  // Heisenberg fix, HARD freeze (operator request): the pinch motion itself
  // drags the palm centroid, so a confirmed engage snaps the cursor back to
  // where it was BACKTRACK_MS before the first engage vote — and then the
  // cursor does not move AT ALL for as long as the pinch holds (no drift
  // unfreeze; pinch-dragging is deliberately impossible). Releasing the pinch
  // resumes the live cursor — the filters keep running underneath, so there
  // is no catch-up lag on release.
  const CURSOR_HISTORY = 8;        // ring buffer of filtered positions (frames)
  const BACKTRACK_MS = 120;
  const ARMED_RATIO = 0.6;         // guest-side feedback: ring tightens below this ratio
  // SELF-HOSTED (offline LAN): the tracker bundle, wasm, and model are served
  // by the room itself under /hands/assets — a guest phone needs zero
  // internet, only the room server.
  const MEDIAPIPE_BASE = "/hands/assets";
  const MODEL_URL = "/hands/assets/hand_landmarker.task";

  const el = (id) => document.getElementById(id);
  const statusEl = el("status"), youEl = el("you"), youDot = el("you-dot");
  const wallsEl = el("walls"), noWallBanner = el("no-wall-banner");
  const pad = el("pad"), padDot = el("pad-dot"), cam = el("cam"), camNote = el("cam-note");
  const camStatus = el("cam-status");
  const camCanvas = el("cam-canvas"), ctx = camCanvas.getContext("2d");
  const modeHands = el("mode-hands"), modePad = el("mode-pad");

  // idToHue parity with the wall (src/ui/gesture/core.ts) so "your dot" here
  // matches the color the room sees.
  const idToHue = (id) => (((id * 137.508) % 360) + 360) % 360;

  // ── connection state ───────────────────────────────────────────────────────
  let ws = null, wsOpen = false, stopped = false;
  let myIds = null;              // [id-for-hand-0, id-for-hand-1] from welcome
  let walls = [];                // walls currently subscribed on the room side
  let chosenWall = localStorage.getItem("vibersyn.guest-wall") || null;
  let lastSendAt = 0;
  let lastCursors = [];          // latest cursor state, resent by the heartbeat

  const setStatus = (state, label) => {
    statusEl.dataset.state = state;
    statusEl.textContent = label;
  };

  const send = (payload) => {
    if (wsOpen) {
      try { ws.send(JSON.stringify(payload)); } catch { /* reconnect handles it */ }
    }
  };

  const sendCursors = (cursors, force = false) => {
    lastCursors = cursors;
    const now = performance.now();
    if (!force && now - lastSendAt < SEND_MIN_MS) return;
    lastSendAt = now;
    send({ type: "cursors", cursors });
  };

  // Heartbeat: a motionless pointer generates no events, but the wall evicts
  // cursors it has not heard from in 0.5s — and holding still IS how you dwell.
  setInterval(() => { if (lastCursors.length > 0) sendCursors(lastCursors, true); }, HEARTBEAT_MS);

  // A wall picked at an earlier session may not exist tonight — drop the stale
  // choice so the picker highlight matches where frames actually route (the
  // hub already falls back to a live wall on its side).
  const syncChosenWall = () => {
    if (chosenWall !== null && walls.length > 0 && !walls.includes(chosenWall)) {
      chosenWall = null;
      localStorage.removeItem("vibersyn.guest-wall");
    }
  };

  const renderWalls = () => {
    noWallBanner.hidden = walls.length > 0;
    wallsEl.replaceChildren();
    if (walls.length < 2) return;
    for (const wall of walls) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = "Wall " + wall;
      b.setAttribute("aria-pressed", String(wall === (chosenWall ?? walls[0])));
      b.addEventListener("click", () => {
        chosenWall = wall;
        localStorage.setItem("vibersyn.guest-wall", wall);
        send({ type: "hello", client: "vibersyn-guest", wall });
        renderWalls();
      });
      wallsEl.appendChild(b);
    }
  };

  const connect = () => {
    if (stopped) return;
    setStatus("connecting", "connecting…");
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    try { ws = new WebSocket(scheme + "://" + location.host + "/hands/ws"); }
    catch { setTimeout(connect, 1500); return; }
    ws.onopen = () => {
      wsOpen = true;
      setStatus("live", "connected");
      send({ type: "hello", client: "vibersyn-guest", ...(chosenWall ? { wall: chosenWall } : {}) });
    };
    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      let msg; try { msg = JSON.parse(event.data); } catch { return; }
      if (msg && msg.type === "welcome" && Array.isArray(msg.ids)) {
        myIds = msg.ids;
        walls = Array.isArray(msg.walls) ? msg.walls : [];
        syncChosenWall();
        const hue = idToHue(msg.ids[0]);
        youDot.style.background = "hsl(" + hue + ", 95%, 62%)";
        youDot.style.color = "hsl(" + hue + ", 95%, 62%)";
        youEl.hidden = false;
        renderWalls();
      } else if (msg && msg.type === "walls" && Array.isArray(msg.walls)) {
        walls = msg.walls;
        syncChosenWall();
        renderWalls();
      }
    };
    ws.onclose = () => {
      wsOpen = false;
      setStatus("closed", "reconnecting…");
      setTimeout(connect, 1500);
    };
    ws.onerror = () => { /* onclose follows */ };
  };
  connect();

  // ── trackpad mode ──────────────────────────────────────────────────────────
  let padPointerId = null;   // the pressed pointer, if any
  let padState = null;       // {x, y, engaged} or null when outside

  const padFrame = () => {
    if (padState === null) { sendCursors([]); padDot.style.opacity = "0"; return; }
    sendCursors([{ id: 0, x: padState.x, y: padState.y, engaged: padState.engaged }]);
    const rect = pad.getBoundingClientRect();
    padDot.style.left = (padState.x * rect.width) + "px";
    padDot.style.top = (padState.y * rect.height) + "px";
    padDot.style.opacity = padState.engaged ? "1" : "0.45";
    if (myIds !== null) {
      const hue = idToHue(myIds[0]);
      padDot.style.background = "hsl(" + hue + ", 95%, 62%)";
      padDot.style.color = "hsl(" + hue + ", 95%, 62%)";
    }
  };
  const padPoint = (event) => {
    const rect = pad.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    };
  };
  pad.addEventListener("pointerdown", (event) => {
    padPointerId = event.pointerId;
    pad.setPointerCapture(event.pointerId);
    padState = { ...padPoint(event), engaged: true };
    padFrame();
  });
  pad.addEventListener("pointermove", (event) => {
    const engaged = padPointerId === event.pointerId || (event.buttons & 1) === 1;
    padState = { ...padPoint(event), engaged };
    padFrame();
  });
  const padRelease = (event) => {
    if (padPointerId === event.pointerId) padPointerId = null;
    // Mouse keeps hovering (aim state); touch lifts away entirely.
    padState = event.pointerType === "mouse" ? { ...padPoint(event), engaged: false } : null;
    padFrame();
  };
  pad.addEventListener("pointerup", padRelease);
  pad.addEventListener("pointercancel", padRelease);
  pad.addEventListener("pointerleave", () => { if (padPointerId === null) { padState = null; padFrame(); } });

  // ── WASD: walk the wall's fly-through camera ───────────────────────────────
  // Held keys stream as {type:"keys",held:[...]} — sent on every change and
  // heartbeated every 250ms while non-empty (the wall auto-releases a guest
  // silent for 1.5s, so a crashed page can never leave the camera walking).
  // Per-button pointer capture gives real multi-touch: W+D with two thumbs.
  const heldKeys = new Set();
  const sendKeys = () => send({ type: "keys", held: [...heldKeys] });
  setInterval(() => { if (heldKeys.size > 0) sendKeys(); }, 250);
  for (const button of document.querySelectorAll(".wasd button")) {
    const key = button.dataset.key;
    const press = (event) => {
      event.preventDefault();
      button.setPointerCapture(event.pointerId);
      if (!heldKeys.has(key)) { heldKeys.add(key); button.dataset.held = "1"; sendKeys(); }
    };
    const release = () => {
      if (heldKeys.delete(key)) { delete button.dataset.held; sendKeys(); }
    };
    button.addEventListener("pointerdown", press);
    button.addEventListener("pointerup", release);
    button.addEventListener("pointercancel", release);
    // A keyboard on the guest machine works too (desk parity, accessibility).
    button.addEventListener("contextmenu", (event) => event.preventDefault());
  }
  const releaseAllKeys = () => {
    if (heldKeys.size === 0) return;
    heldKeys.clear();
    for (const button of document.querySelectorAll(".wasd button")) delete button.dataset.held;
    sendKeys();
  };
  window.addEventListener("blur", releaseAllKeys);

  // ── camera-hands mode ──────────────────────────────────────────────────────
  // camEpoch cancels in-flight startups: stopCamera bumps it, and every await
  // inside startCamera re-checks — so switching to trackpad mid-permission-
  // prompt can never leave the webcam captured (LED on) in the background.
  let camRunning = false, camStream = null, landmarker = null, camRaf = 0, camEpoch = 0;
  let landmarkerLoading = null;   // single-flight CDN load, reused across retries
  const video = document.createElement("video");
  video.playsInline = true; video.muted = true;

  // ── One-Euro filter — port of gesture-wall/gesturewall/filters.py ──────────
  // (also mirrored in src/ui/gesture/core.ts). Timestamp-aware: freq is refined
  // from the wall-clock seconds passed to each call.
  const oneEuro = (mincutoff, beta, dcutoff) => {
    let freq = 60, lastTime = null, s = null, ds = null;
    const alpha = (cutoff) => 1 / (1 + freq / (2 * Math.PI * cutoff));
    return (x, t) => {
      if (lastTime !== null && t > lastTime) freq = 1 / (t - lastTime);
      lastTime = t;
      const dx = s === null ? 0 : (x - s) * freq;
      const da = alpha(dcutoff);
      ds = ds === null ? dx : da * dx + (1 - da) * ds;
      const a = alpha(mincutoff + beta * Math.abs(ds));
      s = s === null ? x : a * x + (1 - a) * s;
      return s;
    };
  };

  // Per-hand tracking state: filters, pinch debounce votes, Heisenberg freeze,
  // and a short ring buffer of filtered positions for the engage backtrack.
  const hands = new Map();
  let prevFrameIds = [];   // cursor ids sent last frame (sticky-id source)
  const handState = (id) => {
    let st = hands.get(id);
    if (st === undefined) {
      st = {
        fx: oneEuro(ONE_EURO_MINCUTOFF, ONE_EURO_BETA, ONE_EURO_DCUTOFF),
        fy: oneEuro(ONE_EURO_MINCUTOFF, ONE_EURO_BETA, ONE_EURO_DCUTOFF),
        fr: oneEuro(PINCH_EURO_MINCUTOFF, PINCH_EURO_BETA, ONE_EURO_DCUTOFF),
        engaged: false, onVotes: 0, offVotes: 0, lost: 0,
        history: [], voteStartAt: 0, frozen: null, prevRaw: null,
      };
      hands.set(id, st);
    }
    return st;
  };

  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const dist = (a, b, aspect) => Math.hypot((a.x - b.x) * aspect, a.y - b.y);
  const pinchRatio = (lm, aspect) => {
    // Foreshortening guard: wrist→middle_MCP collapses when the palm pitches
    // toward the camera; the knuckle span (index_MCP→pinky_MCP) barely does.
    const scale = Math.max(dist(lm[0], lm[9], aspect), 0.9 * dist(lm[5], lm[17], aspect));
    if (scale <= 1e-6) return 4;
    return Math.min(dist(lm[4], lm[8], aspect) / scale, 4);
  };

  // Text + optional link, built via DOM APIs — no fetched value is ever parsed
  // as HTML (the info payload is same-origin, but this page runs on plain LAN
  // http where "same-origin" is only as strong as the network).
  const camFail = (text, linkUrl, tail) => {
    camNote.replaceChildren();
    camNote.append(document.createTextNode(text));
    if (linkUrl) {
      const a = document.createElement("a");
      a.href = linkUrl;
      a.textContent = linkUrl;
      camNote.append(a);
    }
    if (tail) camNote.append(document.createTextNode(tail));
    camNote.style.display = "flex";
    camStatus.hidden = true;
  };

  const loadLandmarker = async () => {
    const vision = await import(MEDIAPIPE_BASE + "/vision_bundle.mjs");
    const fileset = await vision.FilesetResolver.forVisionTasks(MEDIAPIPE_BASE + "/wasm");
    const base = { runningMode: "VIDEO", numHands: 2 };
    try {
      return await vision.HandLandmarker.createFromOptions(fileset, { baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" }, ...base });
    } catch {
      // Phones/older browsers without the GPU delegate still track fine on CPU.
      return await vision.HandLandmarker.createFromOptions(fileset, { baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" }, ...base });
    }
  };

  const startCamera = async () => {
    if (camRunning) return;
    camRunning = true;
    const epoch = camEpoch;
    camNote.textContent = "starting camera…";
    camNote.style.display = "flex";
    if (!window.isSecureContext) {
      // getUserMedia is dead on plain LAN http — say so, point at the fix.
      let httpsUrl = null;
      try {
        const info = await (await fetch("/api/hands/info", { headers: { accept: "application/json" } })).json();
        httpsUrl = info.httpsUrl;
      } catch { /* keep the generic message */ }
      if (typeof httpsUrl === "string" && /^https:\\/\\//.test(httpsUrl)) {
        camFail("Browsers only allow camera access on a secure page. Open ", httpsUrl,
          " instead (accept the one-time certificate warning) — or use the trackpad.");
      } else {
        camFail("Browsers only allow camera access on a secure page. Start the room with run-room.sh to get an https guest URL — or use the trackpad.");
      }
      camRunning = false; // the Camera tab may retry (e.g. after opening https)
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: "user" } });
    } catch {
      if (epoch === camEpoch) {
        camFail("Camera unavailable or permission denied — the trackpad still works.");
        camRunning = false; // granting permission later + re-tapping Camera works
      }
      return;
    }
    if (epoch !== camEpoch) {
      // The guest switched away while the permission prompt was up — release
      // the just-granted camera immediately, never hold it in the background.
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    camStream = stream;
    video.srcObject = camStream;
    await video.play().catch(() => undefined);
    if (landmarker === null) {
      camNote.textContent = "loading hand tracker…";
      try {
        landmarkerLoading = landmarkerLoading ?? loadLandmarker();
        landmarker = await landmarkerLoading;
      } catch {
        landmarkerLoading = null; // regained internet + re-tapping Camera retries
        if (epoch === camEpoch) {
          camFail("Could not load the hand tracker (it downloads from a CDN — no internet on this device?). The trackpad still works.");
          stopCameraStream();
          camRunning = false;
        }
        return;
      }
      if (epoch !== camEpoch) return; // stopCamera already released the stream
    }
    camNote.style.display = "none";
    camStatus.hidden = false;
    camLoop();
  };

  const stopCameraStream = () => {
    if (camStream !== null) {
      for (const track of camStream.getTracks()) track.stop();
      camStream = null;
    }
    video.srcObject = null;
  };

  const camLoop = () => {
    if (!camRunning) return;
    camRaf = requestAnimationFrame(camLoop);
    if (video.readyState < 2 || landmarker === null) return;
    const aspect = (video.videoWidth || 640) / (video.videoHeight || 480);
    let result;
    try { result = landmarker.detectForVideo(video, performance.now()); } catch { return; }

    const cursors = [];   // wire frames — {id,x,y,engaged} only, protocol unchanged
    const marks = [];     // local draw state (adds the pinch-ratio feedback ring)
    const seen = new Set();
    const lists = result.landmarks || [];
    const tMs = performance.now(), tSec = tMs / 1000;
    for (let i = 0; i < lists.length && cursors.length < 2; i += 1) {
      const lm = lists[i];
      if (!lm || lm.length < 21) continue;
      let id;
      if (lists.length === 1 && prevFrameIds.length === 1) {
        // Sticky id: with one hand tracked, a handedness-label flip must not
        // change the cursor id (it resets wall dwell and spawns ghost dots).
        id = prevFrameIds[0];
      } else {
        // Stable local id per physical hand via handedness (fallback: list index).
        const label = result.handednesses?.[i]?.[0]?.categoryName ?? null;
        id = label === "Left" ? 0 : label === "Right" ? 1 : i % 2;
        if (seen.has(id)) id = id === 0 ? 1 : 0;
      }
      seen.add(id);
      const st = handState(id);
      st.lost = 0;
      let cx = 0, cy = 0;
      for (const p of PALM) { cx += lm[p].x; cy += lm[p].y; }
      cx /= PALM.length; cy /= PALM.length;
      // Mirror x (selfie view) BEFORE the inset so the zone is symmetric, then
      // map the interaction zone to the full wall and clamp.
      const zx = clamp01(((1 - cx) - INSET_X_MIN) / (INSET_X_MAX - INSET_X_MIN));
      const zy = clamp01((cy - INSET_Y_MIN) / (INSET_Y_MAX - INSET_Y_MIN));
      // Pre-filter palm speed feeds the engage velocity gate.
      let speed = 0;
      if (st.prevRaw !== null && tSec > st.prevRaw.t) {
        speed = Math.hypot(zx - st.prevRaw.x, zy - st.prevRaw.y) / (tSec - st.prevRaw.t);
      }
      st.prevRaw = { x: zx, y: zy, t: tSec };
      const x = st.fx(zx, tSec), y = st.fy(zy, tSec);
      st.history.push({ x, y, t: tMs });
      if (st.history.length > CURSOR_HISTORY) st.history.shift();
      const ratio = st.fr(pinchRatio(lm, aspect), tSec);
      // HARD freeze: while engaged, st.frozen IS the cursor — the live
      // filtered position keeps advancing underneath but never goes out on
      // the wire until the pinch releases (which nulls st.frozen below).
      if (st.engaged) {
        st.offVotes = ratio > PINCH_OFF ? st.offVotes + 1 : 0;
        if (st.offVotes >= PINCH_OFF_FRAMES) {
          st.engaged = false; st.frozen = null; st.offVotes = 0;
        }
      } else if (ratio < PINCH_ON && speed <= ENGAGE_MAX_SPEED) {
        if (st.onVotes === 0) st.voteStartAt = tMs;
        st.onVotes += 1;
        if (st.onVotes >= PINCH_ON_FRAMES) {
          st.engaged = true; st.onVotes = 0; st.offVotes = 0;
          // Heisenberg fix: click where the hand was before the pinch began —
          // newest history entry at least BACKTRACK_MS older than the first vote.
          let snap = st.history[0];
          for (const h of st.history) { if (h.t <= st.voteStartAt - BACKTRACK_MS) snap = h; }
          st.frozen = { x: snap.x, y: snap.y };
        }
      } else {
        st.onVotes = 0;   // a fast or non-pinching frame breaks the streak
      }
      const outX = st.frozen !== null ? st.frozen.x : x;
      const outY = st.frozen !== null ? st.frozen.y : y;
      cursors.push({ id, x: outX, y: outY, engaged: st.engaged });
      marks.push({ id, x: outX, y: outY, engaged: st.engaged, ratio, lm });
    }
    prevFrameIds = [...seen];
    // Dropout tolerance (extends hands_mediapipe.py's retain()): a mid-pinch
    // hand often vanishes for a frame — keep its state; gone HAND_LOST_FRAMES
    // → force release + full reset so a re-entering half-closed hand never
    // inherits engaged=true or stale filter state.
    for (const [id, st] of [...hands]) {
      if (seen.has(id)) continue;
      st.lost += 1;
      if (st.lost >= HAND_LOST_FRAMES) hands.delete(id);
    }
    sendCursors(cursors);
    drawPreview(marks);
  };

  // MediaPipe hand skeleton bone pairs (wall HandSkeletonHud parity).
  const HAND_LINKS = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];

  const drawPreview = (marks) => {
    const w = cam.clientWidth, h = cam.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (camCanvas.width !== Math.round(w * dpr) || camCanvas.height !== Math.round(h * dpr)) {
      camCanvas.width = Math.round(w * dpr);
      camCanvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // SKELETON VIEW, not a camera feed: the video only feeds the tracker —
    // what the guest sees is their hand skeleton on a dark stage, plus the
    // interaction-zone rectangle so the wall-reachable area is learnable.
    ctx.fillStyle = "#0e1320";
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "rgba(91, 140, 255, 0.28)";
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 5]);
    ctx.strokeRect(INSET_X_MIN * w, INSET_Y_MIN * h, (INSET_X_MAX - INSET_X_MIN) * w, (INSET_Y_MAX - INSET_Y_MIN) * h);
    ctx.setLineDash([]);
    const sx = (p) => (1 - p.x) * w;   // mirrored, matching the cursor mapping
    const sy = (p) => p.y * h;
    for (const m of marks) {
      const hue = myIds !== null ? idToHue(myIds[m.id]) : 220;
      // Bones + joints in the hand's wall hue; the thumb–index pinch pair
      // recolors with the pinch state so the gesture is legible at a glance.
      ctx.strokeStyle = "hsla(" + hue + ", 80%, 62%, 0.75)";
      ctx.lineWidth = 2;
      for (const [a, b] of HAND_LINKS) {
        ctx.beginPath(); ctx.moveTo(sx(m.lm[a]), sy(m.lm[a])); ctx.lineTo(sx(m.lm[b]), sy(m.lm[b])); ctx.stroke();
      }
      ctx.fillStyle = "hsla(" + hue + ", 85%, 70%, 0.9)";
      for (const p of m.lm) {
        ctx.beginPath(); ctx.arc(sx(p), sy(p), 2.5, 0, Math.PI * 2); ctx.fill();
      }
      const pinchColor = m.engaged ? "rgba(126, 226, 168, 0.95)"
        : m.ratio < ARMED_RATIO ? "hsla(" + hue + ", 95%, 75%, 0.95)" : null;
      if (pinchColor !== null) {
        ctx.strokeStyle = pinchColor;
        ctx.lineWidth = m.engaged ? 4 : 2.5;
        ctx.beginPath(); ctx.moveTo(sx(m.lm[4]), sy(m.lm[4])); ctx.lineTo(sx(m.lm[8]), sy(m.lm[8])); ctx.stroke();
      }
      // Pinch-state ring on the palm: open = dot, armed = tightening ring,
      // engaged = filled — same vocabulary as the wall's dwell feedback.
      const px = (m.lm[0].x + m.lm[5].x + m.lm[9].x + m.lm[13].x + m.lm[17].x) / 5;
      const py = (m.lm[0].y + m.lm[5].y + m.lm[9].y + m.lm[13].y + m.lm[17].y) / 5;
      const x = (1 - px) * w, y = py * h;
      if (m.engaged) {
        ctx.fillStyle = "rgba(126, 226, 168, 0.95)";
        ctx.strokeStyle = "rgba(126, 226, 168, 0.9)";
        ctx.beginPath(); ctx.arc(x, y, 12, 0, Math.PI * 2); ctx.fill();
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(x, y, 18, 0, Math.PI * 2); ctx.stroke();
      } else {
        ctx.fillStyle = "hsla(" + hue + ", 95%, 62%, 0.5)";
        ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fill();
        if (m.ratio < ARMED_RATIO) {
          const f = clamp01((m.ratio - PINCH_ON) / (ARMED_RATIO - PINCH_ON));
          ctx.strokeStyle = "hsla(" + hue + ", 95%, 72%, 0.9)";
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(x, y, 10 + 12 * f, 0, Math.PI * 2); ctx.stroke();
        }
      }
    }
  };

  const stopCamera = () => {
    camRunning = false;
    camEpoch += 1; // cancels any startCamera still awaiting the camera/tracker
    cancelAnimationFrame(camRaf);
    stopCameraStream();
    hands.clear();
    prevFrameIds = [];
    camStatus.hidden = true;
    sendCursors([]);
  };

  // ── mode tabs ──────────────────────────────────────────────────────────────
  const setMode = (mode) => {
    localStorage.setItem("vibersyn.guest-mode", mode);
    modeHands.setAttribute("aria-pressed", String(mode === "hands"));
    modePad.setAttribute("aria-pressed", String(mode === "pad"));
    pad.hidden = mode !== "pad";
    cam.hidden = mode !== "hands";
    if (mode === "hands") { padState = null; sendCursors([]); void startCamera(); }
    else stopCamera();
  };
  modeHands.addEventListener("click", () => setMode("hands"));
  modePad.addEventListener("click", () => setMode("pad"));
  // Trackpad is the zero-permission default; a returning guest keeps their pick.
  setMode(localStorage.getItem("vibersyn.guest-mode") === "hands" ? "hands" : "pad");

  window.addEventListener("pagehide", () => {
    stopped = true;
    releaseAllKeys();
    stopCamera();
    try { ws?.close(); } catch {}
  });
  // Back/forward-cache restore revives the page with stopped=true and a dead
  // socket — without this the page would show "reconnecting…" forever.
  window.addEventListener("pageshow", (event) => {
    if (event.persisted && stopped) {
      stopped = false;
      connect();
      setMode(localStorage.getItem("vibersyn.guest-mode") === "hands" ? "hands" : "pad");
    }
  });
})();
</script>
</body>
</html>`;
}
