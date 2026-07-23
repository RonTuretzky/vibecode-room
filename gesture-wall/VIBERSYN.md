# Vibersyn integration (2-wall setup)

> This gesture-wall software is **vendored into the Vibersyn repo** (`gesture-wall/`).
> It was built expressly to drive the Vibersyn room UI via gestures on walls, so
> both now live in one repo. "The Vibersyn repo" below just means the repo ROOT,
> one level up from `gesture-wall/`.

This wires the **Vibersyn** idea projector into the gesture wall's two-wall setup.
There are two integrations:

- **Primary — the gesture layer on the real UI** (`./run-room.sh --gesture`): both
  walls show the Vibersyn UI itself (wall A ideas, wall B builds), and dwelling
  ~0.8 s clicks the REAL bubble/button beneath the cursor. One Orbbec **Gemini
  335** depth camera in the room's far corner serves BOTH walls from a single
  shared frame — hardware setup, placement, and calibration live in
  [GEMINI.md](GEMINI.md).
- **Legacy — the `wall.html` tile bridge**: wall A is the gesture wall's own
  coarse tile grid (`web/wall.html`) whose dwells POST mapped actions to
  Vibersyn; wall B iframes Vibersyn (`web/vibersyn.html`). Still works — see
  [the legacy section](#legacy-wallhtml--tile-bridge) below.

Vibersyn is a Bun-served React app with an HTTP API, run from the repo root.
Because this gesture wall assigns projectors *manually* (open a URL, fullscreen
it — `display` in `room.json` is decorative, see README), Vibersyn slots in
simply as "the page for a wall". Nothing in the Python pipeline changes.

## Run it

From the repo **ROOT**:

```
./run-room.sh --gesture      # the room, gesture-controlled: one Gemini 335 serves BOTH walls
./run-room.sh --calibrate    # projector auto-calibration (re-run after moving anything)
./run-room.sh --fake         # gesture mode with synthetic cursors (no camera needed)
./run-room.sh --fake-hands   # hand-pinch camera with synthetic hands (no TouchDesigner — see below)
```

`--gesture` starts the gesture server (`python -m gesturewall.server --config
gesture-wall/room.json`) alongside Vibersyn and opens both wall windows with
`&gesture=1&fusion=ws://localhost:8770`, so the UI mounts its gesture layer.
Ports: Vibersyn on **:8788**, fusion WebSocket on **:8770**, the gesture
server's own static http on **:8781** (kept off :8000; the walls display the
Vibersyn UI, not `web/wall.html`). `--calibrate` runs the joint autocal
(`python -m gesturewall.autocal --config room.json --width A=2.3 --width B=2.5
--port 8801` — autocal pages on **:8801**, then `POST /calib/start`); see
[GEMINI.md](GEMINI.md) §5 for the full flow.

Two operational notes (details in [GEMINI.md](GEMINI.md)):

- **macOS + camera = `sudo -E`.** Opening the Gemini needs elevated
  permissions (an un-sudo'd process dies with `uvc_open` error -3), so the
  camera-touching Python processes must run under `sudo -E` — have your
  password ready when the script starts them.
- **Keep some ambient light on people.** Depth is IR and immune to lighting,
  but pose runs on the *color* image — a dark projected room starves it.

## TouchDesigner pinch camera (hands protocol, :9980)

An optional SECOND gesture input, fully independent of the fusion pipeline
above: a TouchDesigner network (webcam + MediaPipe hand tracking — install and
network layout in [touchdesigner/README.md](touchdesigner/README.md)) runs a
WebSocket **server** on **:9980** streaming per-hand pinch frames at 30 Hz
(tolerated 10–60 Hz). A wall opened with `&hands=ws://<td-host>:9980` (or
`?hands=1` for `ws://<page-host>:9980`) mounts the pinch-camera layer:
pinch-hold-drag one hand = orbit (release with a flick = coast through the
rig's existing inertia); both hands pinched, spread/squeeze = ratio-preserving
zoom + gentle midpoint pan. Port **9980** is clear of :8770 (fusion WS), :8781
(gesture-wall http), :8788 (Vibersyn), :8801 (autocal) and the MediaPipe
plugin's internal server.

Wire protocol (JSON text frames only):

```
client -> server, first frame after open (informational; servers log/ignore it):

  {"type":"hello","client":"vibersyn-pinch","wall":"A"}

server -> client, one frame per tick at 30 Hz. An EMPTY hands array IS sent
every tick — liveness contract, same as the fusion server's empty cursors:

  {"type":"hands",
   "t": 123.456,          // float seconds (TD absTime.seconds). Informational —
                          //   the browser uses ITS OWN clock for staleness
   "aspect": 1.7778,      // camera frame w/h so the browser aspect-corrects
                          //   inter-hand distance; optional, default 16/9
   "hands": [
     {"id": 1,            // int detection slot (1|2). NOT stable identity across
                          //   re-entry; the browser defends against swaps
      "hand": "Left",     // "Left" | "Right" | null (informational)
      "x": 0.42, "y": 0.31, // normalized [0,1], y DOWN (raw MediaPipe screen
                          //   convention — never flipped in TD). x IS mirrored
                          //   in TD (MIRROR_X=True): moving your hand to YOUR
                          //   right increases x
      "pinch": 0.2143,    // continuous ratio dist(thumb_tip,index_tip) /
                          //   dist(wrist,middle_mcp), aspect-corrected, 4 dp.
                          //   THE BROWSER'S HYSTERESIS RUNS ON THIS — feel
                          //   tuning lives in one place
      "pinching": true,   // TD-side hysteresis-latched bool (ON<0.30, OFF>0.45).
                          //   Browser FALLBACK only when pinch is absent/null
      "conf": 0.95        // optional, default 1
     }]}
```

Contracts (browser side: `src/ui/gesture/hands-client.ts` + `pinch-cam.ts`):

- **Liveness & staleness.** Empty `hands` frames flow every tick. The browser
  enforces staleness with its OWN clock: a latched hand unseen for **0.25 s**
  is a pinch CANCEL (release WITHOUT flick), and the layer's **250 ms** idle
  tick releases everything if the whole stream stalls. A flick is suppressed
  when the last real motion sample is older than **0.15 s** — loss of tracking
  never launches the camera.
- **Smoothing split.** The browser's 1-Euro filter owns positional smoothing;
  an upstream Lag CHOP (~0.05 s) in TD is optional belt+braces, never required.
- **Camera-control only.** This stream drives ONLY the camera rig and is fully
  independent of the :8770 cursors/dwell stream — both may run at once. Known
  interaction: a person pinching near a wall could also dwell-fire via the
  fusion stream; fix sketched as a shared idle-flag gate, not built.
- **Optional `wall` field.** A hands frame carrying a string `wall` that
  mismatches the client's configured wall is dropped; absent = accepted. TD
  omits it — this field (and the hello's `wall`) exists so a future fusion
  server emitting hands frames can route per-wall.
- **Frames with any other `type`** are silently ignored (future multiplexing).
- **Concurrent rig writers.** A camera reset / fit / focus landing mid-pinch
  snaps the camera once and self-heals — external input keeps writing and wins
  (the rig's latest-writer-wins contract).

## Legacy: wall.html + tile bridge

> **What still applies.** The bridge (`web/vibersyn-bridge.js` + the
> `wall.js` dwell seam) and the pages below still ship and work — but only in
> this standalone flow, where wall A is `web/wall.html`. Under
> `./run-room.sh --gesture` the walls are the Vibersyn UI itself and the tile
> bridge is not involved. The camera side *has* changed for everyone: the
> gesture server now drives the single Gemini 335 (so it needs `sudo -E`,
> and `room.json` is the calibrated single-camera config — see
> [GEMINI.md](GEMINI.md)).

```
./run-2wall-vibersyn.sh          # prints the two URLs + the services to start
```

Which is:

1. Gesture server (from `gesture-wall/`, under sudo — see above):
   `sudo -E .venv/bin/python -m gesturewall.server --config room.json`
   (serves `web/` on :8000 — `room.json`'s `server.http_port` default, used
   as-is in this standalone flow — fusion WS on :8770).
2. Vibersyn (from the repo ROOT), with CORS allowing this web origin so wall A's
   dwells can POST cross-origin:
   ```
   VIBERSYN_CORS_ORIGIN=http://localhost:8000 VIBERSYN_PORT=8788 bun run start
   ```
3. Open each URL fullscreen on its projector:
   - Wall A: `http://localhost:8000/wall.html?wall=A&server=ws://localhost:8770&rows=2&cols=3&vibersyn=http://localhost:8788`
   - Wall B: `http://localhost:8000/vibersyn.html?src=http://localhost:8788/?live=1`

## Gesture → Vibersyn bridge (legacy flow only)

`web/vibersyn-bridge.js` maps a completed **dwell** (the wall's deliberate,
Midas-touch-resistant "select" gesture) to a Vibersyn HTTP action. It is **opt-in
and non-breaking**: `wall.js` calls `window.__vibersynBridge.onDwell(event, wall)`
at its dwell seam, but the bridge does nothing unless the wall is opened with
`?vibersyn=<url>`.

Default zone → action map (a 2×3 control grid; zone ids are `r{row}c{col}`):

| tile   | action         | kind    | Vibersyn endpoint            |
|--------|----------------|---------|------------------------------|
| `r0c0` | Idea Capture   | toggle  | `POST /api/capture`          |
| `r0c1` | Build idea     | oneshot | `POST /api/suggestion/accept`|
| `r0c2` | Auto-Build     | toggle  | `POST /api/auto-accept`      |
| `r1c2` | Emergency stop | oneshot | `POST /api/emergency-stop`   |

- **toggle** tiles send `{ on: <dwell-selected> }`; **oneshot** tiles fire only on
  the select edge (never on deselect).
- Override the map with `&vibersynmap=r0c0:emergency,r0c1:capture` (actions:
  `capture`, `accept`/`build`, `autobuild`, `emergency`).

**Idea Capture mode** is Vibersyn's explicit "start the creation loop" mode — the
`r0c0` tile toggles it, so someone at the wall can start/stop idea capture with a
gesture, with the Vibersyn projector (wall B) showing the captured idea building.

## Tests

Pure bridge logic is checked headless (matches the repo's `_*_check.mjs` convention):

```
node web/_vibersyn_bridge_check.mjs
node --check web/vibersyn-bridge.js
```
