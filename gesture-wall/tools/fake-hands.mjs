// Camera-free preview of the TouchDesigner hands server's WebSocket protocol.
//
// It speaks the EXACT hands protocol of gesture-wall/touchdesigner/
// hands_stream.py (hello → hands frames) but emits a scripted synthetic pinch
// choreography, so the Vibersyn pinch-camera layer can be seen and tuned
// WITHOUT TouchDesigner / MediaPipe / a webcam. This is a dev preview SOURCE,
// not a stub of any product logic — the real path is the TD network;
// run-room.sh uses this only with `--fake-hands`.
//
// Run:  bun gesture-wall/tools/fake-hands.mjs        (WS on :9980)
// Env:  FAKE_HANDS_PORT (default 9980), FAKE_HANDS_FPS (30)
//
// Protocol (matches touchdesigner/hands_stream.py):
//   client -> server:  {"type":"hello","client":"vibersyn-pinch","wall":"A"}
//   server -> client:  {"type":"hands","t":..,"aspect":1.7778,"hands":[
//                         {"id":1,"hand":"Right","x":0.42,"y":0.31,
//                          "pinch":0.2143,"pinching":true,"conf":1}]}

const PORT = Number(process.env.FAKE_HANDS_PORT || 9980);
const FPS = Number(process.env.FAKE_HANDS_FPS || 30);
const ASPECT = 1.7778; // round(16/9, 4) — same rounding as hands_stream.py
const started = performance.now();

const r4 = (v) => Math.round(v * 1e4) / 1e4;
const clamp01 = (v) => Math.max(0, Math.min(1, v));
// pinch ≈0.2 latched / ≈0.9 open so the browser's RATIO hysteresis (0.30/0.45)
// is the path exercised; `pinching` mirrors TD's latch (browser fallback only).
const mk = (id, x, y, pinch) => ({
  id,
  hand: id === 1 ? "Right" : "Left",
  x: r4(clamp01(x)),
  y: r4(clamp01(y)),
  pinch: r4(pinch),
  pinching: pinch < 0.3,
  conf: 1,
});
const ramp = (p, from) => (p < from + 0.2 ? 0.9 - 3.5 * (p - from) : 0.2); // 0.9→0.2 over 0.2 s

// 12 s looping choreography — every branch of the browser's pinch state
// machine, visible on the wall:
//   [0,1)   one OPEN hand drifting                  → camera must NOT move
//   [1,4)   hand 1 pinches, sweeps, opens AT SPEED  → orbit + flick coast
//   [4,5)   no hands (empty frames keep flowing)    → idle (liveness contract)
//   [5,8)   both pinch: spread/close 2 s, then midpoint drift → zoom, then pan
//   [8,9)   hand 2 opens; survivor keeps moving     → seamless 2→1 handoff
//   [9,10)  survivor holds STILL 0.5 s, then opens  → release with zero flick
//   [10,12) all open, drifting                      → idle
function handsAt(t) {
  const p = t % 12;
  if (p < 1) return [mk(1, 0.3 + 0.1 * p, 0.5, 0.9)];
  if (p < 4) {
    // Constant-speed sweep; opens at p=3.9 while the motion is fresh, so the
    // release carries velocity → the flick coast fires.
    const u = clamp01((p - 1.2) / 2.7);
    return [mk(1, 0.2 + 0.6 * u, 0.5 + 0.06 * Math.sin(u * 2 * Math.PI), p < 3.9 ? ramp(p, 1) : 0.9)];
  }
  if (p < 5) return [];
  if (p < 8) {
    // Held midpoint + oscillating separation = pure ratio zoom (in then out);
    // then the pair drifts at fixed separation = visible pan.
    const sep = p < 7 ? 0.365 - 0.185 * Math.cos(Math.PI * (p - 5)) : 0.18;
    const midX = p < 7 ? 0.5 : 0.5 + 0.12 * (p - 7);
    const midY = p < 7 ? 0.45 : 0.45 + 0.05 * (p - 7);
    const pinch = ramp(p, 5);
    return [mk(1, midX - sep / 2, midY, pinch), mk(2, midX + sep / 2, midY, pinch)];
  }
  if (p < 9) return [mk(1, 0.53 + 0.15 * (p - 8), 0.5 + 0.04 * (p - 8), 0.2), mk(2, 0.71, 0.5, 0.9)];
  if (p < 10) return [mk(1, 0.68, 0.54, p < 9.5 ? 0.2 : 0.9)];
  const u = (p - 10) / 2;
  return [mk(1, 0.68 - 0.2 * u, 0.54 - 0.1 * u, 0.9), mk(2, 0.3 + 0.15 * u, 0.35, 0.9)];
}

if (typeof Bun === "undefined") {
  console.error("[fake-hands] this preview tool runs under Bun: `bun gesture-wall/tools/fake-hands.mjs`");
  process.exit(1);
}

const server = Bun.serve({
  port: PORT,
  fetch(req, srv) {
    if (srv.upgrade(req)) {
      return undefined;
    }
    return new Response("gesture-wall fake-hands (camera-free pinch preview). Connect via WebSocket.\n", { status: 200 });
  },
  websocket: {
    open(ws) {
      ws.subscribe("hands"); // one broadcast topic — the hands stream is not per-wall (TD parity)
    },
    message(_ws, raw) {
      // Browser hello — informational only (TD ignores it too); log and drop.
      try {
        const msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
        if (msg && msg.type === "hello") {
          console.log(`[fake-hands] hello: client=${msg.client ?? "?"} wall=${msg.wall ?? "-"}`);
        }
      } catch {
        // ignore malformed
      }
    },
    close() {},
  },
});

setInterval(() => {
  const t = (performance.now() - started) / 1000;
  server.publish("hands", JSON.stringify({ type: "hands", t: r4(t), aspect: ASPECT, hands: handsAt(t) }));
}, 1000 / FPS);

console.log(`[fake-hands] ws://localhost:${PORT}  ${FPS}fps  (camera-free 12 s pinch choreography loop)`);
