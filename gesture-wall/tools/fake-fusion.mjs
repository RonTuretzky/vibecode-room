// Camera-free preview of the gesture-wall fusion server's WebSocket protocol.
//
// It speaks the EXACT wire protocol of `gesturewall.server` (hello → cursors
// frames) but emits synthetic MOVING cursors, so the Vibersyn gesture overlay can
// be seen and driven WITHOUT cameras / OpenCV / a calibrated room. This is a dev
// preview SOURCE, not a stub of any product logic — the real path is the Python
// camera server; run-room.sh uses this only with `--fake`.
//
// Run:  bun gesture-wall/tools/fake-fusion.mjs        (WS on :8770, walls A + B)
// Env:  FAKE_WS_PORT (default 8770), FAKE_WALLS (default "A,B"), FAKE_FPS (30)
//
// Protocol (matches gesturewall/server.py):
//   client -> server:  {"type":"hello","wall":"A"}
//   server -> client:  {"type":"cursors","wall":"A","t":..,"cursors":[
//                         {"id":1,"x":0.4,"y":0.3,"engaged":true,"conf":0.9}]}

const PORT = Number(process.env.FAKE_WS_PORT || 8770);
const FPS = Number(process.env.FAKE_FPS || 30);
const WALLS = (process.env.FAKE_WALLS || "A,B").split(",").map((w) => w.trim()).filter(Boolean);
const started = performance.now();

// Two slow Lissajous cursors per wall (phase-shifted so walls differ), sweeping
// across [0,1]^2 so they pass over the UI's bubbles and controls.
function cursorsForWall(wall, t) {
  const phase = wall.charCodeAt(0) * 0.7;
  const clamp = (v) => Math.max(0.03, Math.min(0.97, v));
  const mk = (id, ax, ay, sx, sy) => ({
    id,
    x: clamp(0.5 + 0.34 * Math.sin(sx * t + ax + phase)),
    y: clamp(0.5 + 0.32 * Math.sin(sy * t + ay + phase)),
    engaged: true,
    conf: 0.9,
  });
  return [mk(1, 0, Math.PI / 2, 0.55, 0.9), mk(2, Math.PI / 3, 0, 0.9, 0.5)];
}

if (typeof Bun === "undefined") {
  console.error("[fake-fusion] this preview tool runs under Bun: `bun gesture-wall/tools/fake-fusion.mjs`");
  process.exit(1);
}

const server = Bun.serve({
  port: PORT,
  fetch(req, srv) {
    if (srv.upgrade(req)) {
      return undefined;
    }
    return new Response("gesture-wall fake-fusion (camera-free preview). Connect via WebSocket.\n", { status: 200 });
  },
  websocket: {
    open(ws) {
      ws.data = { wall: null };
    },
    message(ws, raw) {
      try {
        const msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
        if (msg && msg.type === "hello" && typeof msg.wall === "string") {
          ws.data.wall = msg.wall;
          ws.subscribe(`wall:${msg.wall}`);
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
  for (const wall of WALLS) {
    const frame = JSON.stringify({ type: "cursors", wall, t, cursors: cursorsForWall(wall, t) });
    server.publish(`wall:${wall}`, frame);
  }
}, 1000 / FPS);

console.log(`[fake-fusion] ws://localhost:${PORT}  walls=${WALLS.join(",")}  ${FPS}fps  (camera-free preview cursors)`);
