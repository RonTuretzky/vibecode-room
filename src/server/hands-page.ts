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
//      Cursor = palm-knuckle centroid (mirrored, so moving right moves right),
//      engage = pinch with the SAME ratio math + hysteresis as the room's
//      standalone bridge (gesture-wall/touchdesigner/hands_mediapipe.py):
//      |thumb_tip−index_tip| / |wrist−middle_MCP|, aspect-corrected,
//      ON below 0.30 / OFF above 0.45. Needs a secure context (the TLS
//      listener's https URL, or localhost on the host machine) — browsers
//      refuse getUserMedia on plain LAN http. Tracking runs entirely on the
//      guest's machine; only tiny cursor frames cross the network.
//   🖱 Trackpad — always works, everywhere: the pad maps 1:1 onto the wall
//      (16:9). Hover to aim (dimmed dot), press-and-hold still to dwell-click.
//
// MediaPipe loads from the jsdelivr CDN on the GUEST's device (the room server
// stays local-first; a guest without internet still has the trackpad — the
// page says so honestly instead of failing silent).

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
    No wall is listening for guests right now — start the room with <code>--guests</code>
    (or add <code>&amp;remote=1</code> to a wall URL) and this page connects by itself.
  </div>

  <div class="tabs" role="tablist">
    <button type="button" id="mode-hands" data-testid="guest-mode-hands" aria-pressed="false">✋ Camera hands</button>
    <button type="button" id="mode-pad" data-testid="guest-mode-pad" aria-pressed="true">🖱 Trackpad</button>
    <span class="walls" id="walls" data-testid="guest-walls"></span>
  </div>

  <div class="surface" id="pad" data-testid="guest-pad">
    <div id="pad-hint">hover to aim · press and hold still to click</div>
    <div id="pad-dot"></div>
  </div>

  <div class="surface" id="cam" hidden>
    <canvas id="cam-canvas"></canvas>
    <div id="cam-note">starting camera…</div>
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
    hold your cursor still on it until the ring around it completes (~1s).
    Camera mode: point by moving your open hand, click by <strong>pinching</strong> thumb+index
    and holding still. Hand tracking runs entirely in your browser — only cursor positions are sent.
  </p>
</main>
<script type="module">
(() => {
  const SEND_MIN_MS = 33;          // ≤30 Hz on the wire
  const HEARTBEAT_MS = 100;        // keep a still cursor alive (wall evicts at 0.5s)
  const PINCH_ON = 0.30;           // hands_mediapipe.py parity
  const PINCH_OFF = 0.45;
  const PALM = [0, 5, 9, 13, 17];  // wrist + finger-base knuckles: pinching never drags the cursor
  const MEDIAPIPE_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22";
  const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task";

  const el = (id) => document.getElementById(id);
  const statusEl = el("status"), youEl = el("you"), youDot = el("you-dot");
  const wallsEl = el("walls"), noWallBanner = el("no-wall-banner");
  const pad = el("pad"), padDot = el("pad-dot"), cam = el("cam"), camNote = el("cam-note");
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
  const latched = new Map();   // hand id -> pinch latch (hysteresis state)

  const dist = (a, b, aspect) => Math.hypot((a.x - b.x) * aspect, a.y - b.y);
  const pinchRatio = (lm, aspect) => {
    const scale = dist(lm[0], lm[9], aspect);
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
  };

  const loadLandmarker = async () => {
    const vision = await import(MEDIAPIPE_CDN);
    const fileset = await vision.FilesetResolver.forVisionTasks(MEDIAPIPE_CDN + "/wasm");
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
        camFail("Browsers only allow camera access on a secure page. Start the room with --guests to get an https guest URL — or use the trackpad.");
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

    const cursors = [];
    const seen = new Set();
    const lists = result.landmarks || [];
    for (let i = 0; i < lists.length && cursors.length < 2; i += 1) {
      const lm = lists[i];
      if (!lm || lm.length < 21) continue;
      // Stable local id per physical hand via handedness (fallback: list index).
      const label = result.handednesses?.[i]?.[0]?.categoryName ?? null;
      let id = label === "Left" ? 0 : label === "Right" ? 1 : i % 2;
      if (seen.has(id)) id = id === 0 ? 1 : 0;
      seen.add(id);
      let cx = 0, cy = 0;
      for (const p of PALM) { cx += lm[p].x; cy += lm[p].y; }
      cx /= PALM.length; cy /= PALM.length;
      const ratio = pinchRatio(lm, aspect);
      const engaged = latched.get(id) === true ? ratio < PINCH_OFF : ratio < PINCH_ON;
      latched.set(id, engaged);
      // Mirror x (selfie view): moving your hand right moves the wall cursor right.
      cursors.push({ id, x: Math.max(0, Math.min(1, 1 - cx)), y: Math.max(0, Math.min(1, cy)), engaged });
    }
    // Prune latches for hands that left the frame (hands_mediapipe.py's
    // retain() parity): a hand re-entering half-closed must NOT inherit
    // pinching=true — it would be stuck engaged until it fully opened.
    for (const id of [...latched.keys()]) {
      if (!seen.has(id)) latched.delete(id);
    }
    sendCursors(cursors);
    drawPreview(cursors);
  };

  const drawPreview = (cursors) => {
    const w = cam.clientWidth, h = cam.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (camCanvas.width !== Math.round(w * dpr) || camCanvas.height !== Math.round(h * dpr)) {
      camCanvas.width = Math.round(w * dpr);
      camCanvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Mirrored video underlay, dimmed — feedback, not a video call.
    ctx.save();
    ctx.translate(w, 0); ctx.scale(-1, 1);
    ctx.globalAlpha = 0.45;
    try { ctx.drawImage(video, 0, 0, w, h); } catch { /* not ready yet */ }
    ctx.restore();
    ctx.globalAlpha = 1;
    for (const c of cursors) {
      const hue = myIds !== null ? idToHue(myIds[c.id]) : 220;
      const x = c.x * w, y = c.y * h;
      ctx.strokeStyle = "hsla(" + hue + ", 95%, 62%, 0.9)";
      ctx.fillStyle = "hsla(" + hue + ", 95%, 62%, " + (c.engaged ? 0.95 : 0.5) + ")";
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(x, y, c.engaged ? 14 : 9, 0, Math.PI * 2); ctx.fill();
      if (c.engaged) { ctx.beginPath(); ctx.arc(x, y, 20, 0, Math.PI * 2); ctx.stroke(); }
    }
  };

  const stopCamera = () => {
    camRunning = false;
    camEpoch += 1; // cancels any startCamera still awaiting the camera/tracker
    cancelAnimationFrame(camRaf);
    stopCameraStream();
    latched.clear();
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
