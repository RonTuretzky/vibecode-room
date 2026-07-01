# Gesture Wall — Multi-Camera / Multi-Wall / Multi-User Design (PLAN)

Coarse mid-air **select/deselect** on **projected walls** via **webcam pose +
dwell**. This document is the engineering design for growing the single-camera
single-wall prototype (Stack A) into a room with **N walls**, **M cameras**, and
**multiple simultaneous users**. It is the buildable spec behind the slideshow
`web/multiwall-setup.html` (which fixes the concrete "two walls, three cameras"
deployment); see [§13 Mapping to the slideshow](#13-mapping-to-the-slideshow).

The guiding idea (slide 2): **separate sensing from display**. Cameras produce
pointer observations; walls render cursors; a homography per (camera, wall) pair
glues them; a central fusion step decides which wall a hand means and routes one
cursor there. Everything below is consistent with that split and with the
existing reusable pieces in `gesturewall/` — nothing here re-implements the
homography, filter, zone, or dwell logic that already ships.

---

## 1. Layered architecture

```
 ┌──────────┐   ┌──────────┐   ┌──────────┐        cameras: USB webcams, one
 │  cam0    │   │  cam1    │   │  cam2    │  ...    capture+pose thread each
 └────┬─────┘   └────┬─────┘   └────┬─────┘
      │ Persons[]    │ Persons[]    │ Persons[]     people_from_landmarks()
      ▼              ▼              ▼               (pure, mediapipe-free logic)
 ┌─────────────────────────────────────────────┐
 │  SENSING SERVER  (gesturewall/server.py)     │
 │                                              │
 │  per-camera latest Persons[] + timestamp     │
 │                ▼                             │
 │  room-mapping: anchor → room_xy  (RoomObs)   │  room_homography(cam)
 │                ▼                             │
 │  Tracker (tracking.py)  cross-cam identity   │  → list[Track]  (stable ids)
 │                ▼                             │
 │  FusionEngine (fusion.py)  per-wall cursors  │  cam_to_wall(cam, wall) + seam
 │                ▼                             │
 │  step_pipeline() → dict[wall, list[Cursor]]  │  ← camera-free, unit-testable
 └──────────────────┬───────────────────────────┘
       WS broadcast │  (one stream per wall, filtered to that wall)
      ┌─────────────┼─────────────┐
      ▼                           ▼
 ┌──────────┐               ┌──────────┐
 │ wall.html│  (Wall A)     │ wall.html│  (Wall B)   browser, fullscreen,
 │  + core  │               │  + core  │             one per projector
 └──────────┘               └──────────┘
   per-cursor: Point2DFilter + DwellSelector against SHARED zones
   shared per-zone lock prevents double-toggle by two users on one tile
```

Five layers, each independently testable:

1. **Cameras / sensing** — one capture+pose worker per camera. Blocking
   `cv2`/`mediapipe` work runs on threads. Each worker reduces a frame to a
   `list[Person]` (normalized image coords, mirror already applied).
2. **Room mapping** — each `Person.anchor` (hip midpoint) is mapped into a shared
   **room frame** via that camera's `room_homography`, producing `RoomObs`.
   Cameras with a `null` room_homography fall back to using the anchor as
   `room_xy`.
3. **Identity fusion (Tracker)** — clusters `RoomObs` across cameras (one obs per
   camera per person), matches clusters to persistent `Track`s by nearest
   neighbour, ages out stale tracks. Produces stable integer ids.
4. **Wall fusion (FusionEngine)** — per track, maps each member observation's
   **wrist** through `cam_to_wall` for the walls its cameras serve, gates to
   `[0,1]²`, picks the highest-confidence candidate per wall, then applies
   **seam handoff hysteresis** so a cursor near a corner doesn't flicker between
   walls. Emits one `Cursor` per chosen wall.
5. **Wall clients** — a networked browser client per wall. Each maintains a
   `Point2DFilter` + `DwellSelector` **per cursor id**, runs them against the
   wall's **shared** zone grid, and enforces a **shared per-zone lock** so two
   users dwelling the same tile can't double-toggle it.

Design invariants (slide 2, slide 10):

- A camera never *owns* a wall — it only reports where hands are.
- Sensing+fusion live in **one** server process; walls stay thin renderers.
- Smoothing + dwell + render stay **on the client** (already built, unchanged).
- Everything that touches `cv2`/`mediapipe`/`asyncio` is factored so the
  **pure decision logic is importable and testable headless** (the
  `CRITICAL STYLE RULE`). Lazy imports mirror `sources.PoseSource`.

---

## 2. Data model (Python)

All dataclasses use `from __future__ import annotations` + `@dataclass`, matching
`zones.Zone` / `dwell.DwellEvent`. Coordinates are normalized floats.

```python
@dataclass
class Person:
    """One detected body in ONE camera frame (normalized image coords, mirror applied)."""
    wrist:    tuple[float, float]   # pointing-hand wrist
    shoulder: tuple[float, float]   # that hand's shoulder
    anchor:   tuple[float, float]   # midpoint of hips (landmarks 23,24) — identity/location handle
    engaged:  bool                  # pointing wrist above its shoulder AND visible (PoseSource rule)
    confidence: float               # mean visibility of pointing wrist + both shoulders

@dataclass
class RoomObs:
    """A Person lifted into the shared room/floor frame."""
    camera_id: str
    person:    Person
    room_xy:   tuple[float, float]  # anchor mapped via camera room_homography (or anchor itself if null)

@dataclass
class Track:
    """A real person fused across cameras + time."""
    id:       int                   # stable, incrementing from 1, never reused
    room_xy:  tuple[float, float]   # mean of cluster member room_xy
    engaged:  bool                  # any member engaged
    last_seen: float
    members:  list[RoomObs]         # the cluster of obs backing this track this frame

@dataclass
class Cursor:
    """What a wall renders (one per person, on that wall)."""
    person_id:  int
    x:          float               # wall-normalized, gated to [0,1]
    y:          float
    engaged:    bool
    confidence: float
```

`Person.engaged` and `Person.confidence` are computed by the **pure** function
`people_from_landmarks` ([§5](#5-multi-pose-sensing)); the engage rule is the
same one `PoseSource` already uses (raised hand above shoulder, visibility ≥ 0.5).

---

## 3. WebSocket protocol (restated from the CONTRACT — do not deviate)

JSON **text** frames. One TCP connection per wall client.

**Client → server**, first message after connect:

```json
{ "type": "hello", "wall": "A" }
```

**Server → that client**, once per tick (~`server.fps`), containing **only that
wall's** cursors:

```json
{
  "type": "cursors",
  "wall": "A",
  "t": 1234.567,
  "cursors": [
    { "id": 7, "x": 0.42, "y": 0.31, "engaged": true, "conf": 0.88 }
  ]
}
```

- `t` is float seconds (the server's monotonic tick time).
- `cursors` keys are exactly `id, x, y, engaged, conf` (`conf` = `Cursor.confidence`).
- A client subscribed to wall `A` receives **only** A's stream; B's cursors never
  appear on A.
- The client **drops/forgets** a cursor id when it stops appearing (the server is
  free to simply omit it; see the client TTL in [§9](#9-wall-client-webwallhtml--webwalljs)).

No other message types are required. The server may ignore unknown client
messages; a `hello` with an unknown wall id should be answered with empty
`cursors` frames (or the connection closed) rather than crashing.

---

## 4. Room config — `gesturewall/room.py` + `room.example.json`

One declarative file describes the whole room (slide 8). The single-wall app is
just the 1×1 case of this schema.

### 4.1 JSON schema (`room.example.json` is a valid instance)

```json
{
  "walls": {
    "A": { "display": 1, "grid": { "rows": 2, "cols": 3 } },
    "B": { "display": 2, "grid": { "rows": 2, "cols": 3 } }
  },
  "adjacency": [
    { "left": "A", "right": "B", "seam_margin": 0.06 }
  ],
  "cameras": {
    "cam0": { "device": 0, "serves": ["A"],      "room_homography": null },
    "cam1": { "device": 1, "serves": ["A", "B"], "room_homography": [[..],[..],[..]] },
    "cam2": { "device": 2, "serves": ["B"],      "room_homography": null }
  },
  "calibration": {
    "cam0->A": { "matrix": [[..],[..],[..]] },
    "cam1->A": { "matrix": [[..],[..],[..]] },
    "cam1->B": { "matrix": [[..],[..],[..]] },
    "cam2->B": { "matrix": [[..],[..],[..]] }
  },
  "fusion": { "mode": "highest_confidence", "merge_radius": 0.35, "track_max_age": 0.5 },
  "server": {
    "ws_port": 8770, "http_port": 8000, "fps": 30, "num_poses": 4,
    "mirror": true, "min_confidence": 0.5, "model": "models/pose_landmarker_lite.task"
  }
}
```

Each `matrix` is exactly what the 4-corner calibration already produces
(`Homography.to_dict()["matrix"]`) — now stored **per (camera, wall) pair**
instead of one global `calibration.json`. `cam0->B` and `cam2->A` are
intentionally absent (those cameras don't cover the far wall): **valid**.

### 4.2 Dataclasses and API

```python
@dataclass
class WallCfg:    display: int; rows: int; cols: int
@dataclass
class CameraCfg:  device: int; serves: list[str]; room_homography: list[list[float]] | None
@dataclass
class Adjacency:  left: str; right: str; seam_margin: float
@dataclass
class FusionCfg:  mode: str; merge_radius: float; track_max_age: float
@dataclass
class ServerCfg:  ws_port: int; http_port: int; fps: int; num_poses: int
                  mirror: bool; min_confidence: float; model: str
@dataclass
class RoomConfig:
    walls: dict[str, WallCfg]
    cameras: dict[str, CameraCfg]
    adjacency: list[Adjacency]
    calibration: dict[str, dict]      # "<cam>-><wall>" -> {"matrix": 3x3}
    fusion: FusionCfg
    server: ServerCfg

    @classmethod
    def load(cls, path) -> "RoomConfig": ...        # parse + validate; ValueError w/ clear message
    def cam_to_wall(self, camera_id, wall_id) -> Homography: ...  # KeyError if absent
    def room_homography(self, camera_id) -> Homography | None: ...
    def serves(self, camera_id, wall_id) -> bool: ...  # helper: W in serves AND calibration exists
```

- `cam_to_wall(cam, wall)` builds a `Homography` from
  `calibration["<cam>-><wall>"]` via `Homography.from_dict`; raises `KeyError`
  when that key is absent.
- `room_homography(cam)` returns `Homography.from_dict({"matrix": ...})` when the
  camera's `room_homography` is non-null, else `None`.
- A camera **serves** wall W **iff** `W in camera.serves` **and** the calibration
  key `"<cam>->W"` exists. (Both `serves()` and `FusionEngine` use this rule.)

### 4.3 Validation rules (raise `ValueError` with a clear message)

- Every camera named in a `calibration` key (`"<cam>->..."`) exists in `cameras`.
- Every wall referenced (in a calibration key, in `camera.serves`, in
  `adjacency`) exists in `walls`.
- Each `camera.serves` wall has a matching `calibration` entry `"<cam>-><wall>"`.
  (Absent calibration for a non-served wall is fine; absent calibration for a
  *served* wall is an error.)
- Adjacency `left`/`right` walls exist; `seam_margin ∈ [0, 0.5)` (same bound as
  `zones.build_grid` padding and `dwell` hysteresis).
- Sane ints/floats: `display ≥ 0`, `rows ≥ 1`, `cols ≥ 1`, `device ≥ 0`,
  `merge_radius > 0`, `track_max_age > 0`, `ws_port`/`http_port` in port range,
  `fps ≥ 1`, `num_poses ≥ 1`, `0 ≤ min_confidence ≤ 1`, each `matrix` is 3×3 of
  numbers.

`cam0->B` / `cam2->A` absent is **valid** — a camera need not serve every wall.

---

## 5. Multi-pose sensing — `gesturewall/multipose.py`

Mirrors `sources.PoseSource`: `cv2` + `mediapipe` imported **lazily** in
`__init__`; the parsing/decision logic is a standalone **pure** function that
tests drive with duck-typed landmarks (namedtuples / simple objects exposing
`.x`, `.y`, `.visibility`).

### 5.1 Pure function

```python
NOSE = 0
LEFT_SHOULDER, RIGHT_SHOULDER = 11, 12
LEFT_WRIST,    RIGHT_WRIST    = 15, 16
LEFT_HIP,      RIGHT_HIP      = 23, 24

def people_from_landmarks(pose_landmarks_list, mirror: bool) -> list[Person]:
    """Convert MediaPipe's list-of-pose-landmark-lists into Persons.

    Per pose (each item is a list of 33 landmarks with .x/.y/.visibility):
      * pointing hand = the higher wrist (smaller y, image y grows downward);
      * engaged       = visible(>=0.5) AND wrist.y < shoulder.y  (PoseSource rule);
      * anchor        = midpoint of hips (23, 24);
      * confidence    = mean visibility of pointing wrist + both shoulders;
      * mirror        => x -> 1-x for ALL stored coords (wrist, shoulder, anchor).
    """
```

Notes:
- Landmarks are **duck-typed**: `getattr(lm, "visibility", 1.0)` so test fixtures
  need only `.x`/`.y`.
- The "higher wrist" / engage rule is byte-for-byte the rule in `PoseSource.read`
  and `web/gesturewall.js`, extended with `anchor` and `confidence`.
- Mirroring is applied to **stored** coords (so downstream code never re-mirrors),
  exactly as the browser port mirrors the wrist x.

### 5.2 `MultiPoseSource` class

```python
class MultiPoseSource:
    def __init__(self, camera=0, video=None, num_poses=4, mirror=True,
                 min_confidence=0.5, model_path=DEFAULT_MODEL_PATH): ...
    def read(self) -> tuple["np.ndarray|None", list[Person], dict]: ...
    def close(self) -> None: ...
```

- Lazy `import cv2` / `import mediapipe`; reuses `sources.ensure_pose_model`.
- `RunningMode.VIDEO`, strictly-increasing integer-ms timestamps (copy
  `_next_timestamp_ms`), mirror via `cv2.flip(frame, 1)` then BGR→RGB.
- `num_poses` passed straight to `PoseLandmarkerOptions(num_poses=...)`.
- `read()` returns `(frame_bgr_or_None, people, info_dict)` where
  `people = people_from_landmarks(result.pose_landmarks, self._mirror)` and
  `info` carries `{"status": ..., "n": len(people)}`.
- Importable without a camera; only `__init__`/`read` touch hardware.

---

## 6. Cross-camera identity — `gesturewall/tracking.py` (PURE)

No `cv2`/`mediapipe`. Small pure geometry helpers + a deterministic `Tracker`.

```python
def distance(a: tuple[float,float], b: tuple[float,float]) -> float: ...
def cluster_observations(obs: list[RoomObs], radius: float) -> list[list[RoomObs]]:
    """Greedily group obs whose room_xy are within `radius`, AT MOST one obs per
    camera per cluster (a person is seen at most once per camera)."""

class Tracker:
    def __init__(self, merge_radius: float, max_age: float): ...
    def update(self, obs: list[RoomObs], t: float) -> list[Track]: ...
```

`Tracker.update` algorithm (deterministic, ids stable, never reused):

1. **Cluster** the frame's observations across cameras with
   `cluster_observations(obs, merge_radius)` — greedy, closest-first, at most one
   obs per camera per cluster.
2. **Match** clusters to existing tracks by nearest `track.room_xy` within
   `merge_radius` (greedy, closest pair first). A matched cluster **updates** its
   track:
   - `room_xy = mean(member.room_xy)`,
   - `engaged = any(member.person.engaged)`,
   - `members = cluster`, `last_seen = t`.
3. **Unmatched clusters** → a new `Track` with a fresh incrementing id (start at
   1, monotonic across the tracker's lifetime; ids are never reused).
4. **Age out** tracks with `t - last_seen > max_age`.
5. Return active tracks **sorted by id**.

Determinism comes from: greedy matching by ascending distance with stable
tie-breaks (e.g. by `(camera_id, index)` then `track.id`), and monotonic id
allocation. `merge_radius` / `max_age` come from `FusionCfg`.

---

## 7. Per-wall per-person fusion — `gesturewall/fusion.py` (PURE)

Depends only on `room.py` + `calibration.Homography`. No `cv2`/`mediapipe`.

```python
class FusionEngine:
    def __init__(self, config: RoomConfig): ...
    def update(self, tracks: list[Track], t: float) -> dict[str, list[Cursor]]:
        """Returns one entry per wall id (possibly empty list)."""
```

Per track (slide 6 "map · gate · arbitrate · fuse"):

1. **Skip** if `not track.engaged`.
2. For each wall the track could map onto, gather member observations from
   cameras that **serve** that wall (`config.serves(cam, wall)`).
3. **Map** each such `member.person.wrist` through
   `config.cam_to_wall(camera_id, wall).apply(x, y)`.
4. **Gate**: keep only mapped points inside `[0,1]²`.
5. Among the in-bounds points, pick the **highest-confidence** member →
   candidate `(wall, x, y, conf)`. A track may produce candidates on **>1 wall**
   near the seam.
6. **Seam handoff (hysteresis)** — see §7.1. Choose exactly one wall.
7. **Emit** one `Cursor(person_id=track.id, x, y, engaged=True, confidence=conf)`
   on the chosen wall. A track with **no** in-bounds candidate emits nothing.

`update` always returns a dict keyed by **every** wall id (empty list when no
cursor lands there) so the server can broadcast empty frames and clients clear
stale cursors.

### 7.1 Seam handoff helper (pure, documented in the docstring)

Mirrors `DwellSelector`'s sticky-zone hysteresis. `FusionEngine` keeps a
per-track **current wall**.

```python
def choose_wall(candidates: list[Candidate], current_wall: str | None,
                seam_margin: float) -> str | None:
    """Pick the wall a track's cursor belongs to, with seam hysteresis.

    Sticky rule: if the track has a candidate on `current_wall` AND that point is
    still inside the wall's sticky band (expanded by seam_margin on the seam edge,
    i.e. the [0,1] box grown/contracted appropriately), KEEP current_wall.
    Otherwise SWITCH to the best candidate: highest confidence, tie-broken by
    most-central (smallest distance from (0.5, 0.5)). Returns None if no candidate.
    """
```

- The `seam_margin` comes from the relevant `Adjacency` entry. On the seam edge
  (A's right `x=1` ↔ B's left `x=0`) the sticky band extends past the nominal
  boundary by `seam_margin`, so the cursor "holds" the current wall through a
  small overlap before committing to the other — preventing A↔B flicker
  (slide 6 step 3, slide 10 "flicker at the seam").
- Switching uses the same arbitration as multi-camera fusion: **highest
  confidence**, tie-break **most central**. (`FusionCfg.mode` reserved for future
  averaging; `highest_confidence` is the implemented default.)
- The helper is pure and unit-tested directly (sticky-keeps, clean-switch,
  no-candidate cases).

---

## 8. Sensing server — `gesturewall/server.py` (asyncio + threads)

`asyncio` + the `websockets` library + a threaded `http.server`. The module
**imports without a camera** (no top-level `cv2`/`mediapipe`).

### 8.1 Camera-free pipeline core (the testable seam)

```python
def step_pipeline(persons_by_camera: dict[str, list[Person]], t: float,
                  config: RoomConfig, tracker: Tracker,
                  fusion: FusionEngine) -> dict[str, list[Cursor]]:
    """Map anchors -> room (RoomObs), run Tracker, run FusionEngine. NO cv2/asyncio."""
```

- For each `(camera_id, persons)`: map each `person.anchor` via
  `config.room_homography(camera_id)`; if `None`, `room_xy = person.anchor`
  (fallback). Build `RoomObs(camera_id, person, room_xy)`.
- `tracks = tracker.update(all_obs, t)`; then **emit only for tracks seen this
  frame** — `fresh = [tr for tr in tracks if tr.last_seen >= t - 1e-9]`;
  `return fusion.update(fresh, t)`.

This function is the unit-test target — it exercises room-mapping + Tracker +
FusionEngine with **no camera, no sockets, no event loop**.

> **Why the freshness filter (Midas-touch safety):** the `Tracker` keeps a track
> alive for `max_age` after its last sighting so a returning person keeps their
> id (identity bridging). But if *no* camera sees the body this frame, fusing its
> stale members would coast a **frozen cursor**, and the client's dwell would keep
> accumulating on that fixed point and could ghost-complete a selection. Dropping
> not-seen-this-frame tracks before fusion prevents that. The multi-camera
> occlusion fallback is unaffected: while *any* camera still sees the person the
> track is fresh (`last_seen == t`). Covered by
> `tests/test_server_pipeline.py::test_full_dropout_does_not_coast_a_frozen_cursor`.

### 8.2 Runtime wiring

- **Capture workers**: one thread per camera running `MultiPoseSource`; each
  writes its latest `list[Person]` + timestamp into a shared, lock-guarded
  `persons_by_camera` dict (drop observations older than `track_max_age` so a
  stalled camera can't freeze a wall — slide 10 "latency/sync").
- **Tick loop**: an `asyncio` task at ~`server.fps` snapshots
  `persons_by_camera`, calls `step_pipeline(...)`, and broadcasts each wall's
  cursors to that wall's subscribers as a `cursors` frame.
- **WS server** (`websockets`): on connect, read the `hello`, record the
  client's wall, stream only that wall's frames; clean up on disconnect.
- **HTTP server**: serve `web/` over `http.server` in a thread (same origin), so
  wall clients load `wall.html` + `core.js` from the server.
- **`FakeSource`**: a camera-free source returning scripted `list[Person]` for
  tests / demos, so the full server path can run headless.

### 8.3 Entry point + CLI

```
.venv/bin/python -m gesturewall.server --config room.json
```

`argparse`: `--config` (required), plus overrides `--ws-port`, `--http-port`,
`--fps`, `--num-poses` (override the matching `ServerCfg` fields). Importing
`gesturewall.server` must **not** require a camera.

---

## 9. Wall client — `web/wall.html` + `web/wall.js`

A **networked** wall client, separate from `index.html` (which stays the local
single-camera demo). Imports the shared pure core from `./core.js` ([§10](#10-web-shared-core--webcorejs)).

- **URL params**: `?wall=A&server=ws://localhost:8770&rows=2&cols=3`.
- **Connect**: open the WS, send `{ "type": "hello", "wall": <wall> }`.
- **Per-cursor state**: a `Map<id, { filter: Point2DFilter, dwell: DwellSelector,
  hue: number, lastSeen: number }>`. On each `cursors` frame:
  - smooth `(x, y)` with that cursor's own `Point2DFilter`;
  - run that cursor's own `DwellSelector` against the **shared** zone grid;
  - update `lastSeen`.
- **Shared per-zone lock (conflict rule)**: a `Map<zoneId, lockedUntil>`. When
  **any** cursor commits a toggle on a zone, lock that zone for **~0.4 s**; while
  locked it is ignored by **all** dwellers (filtered out of the zones passed to
  each `DwellSelector.update`, or the commit is suppressed). This prevents two
  users dwelling the same tile from double-toggling it.
- **Render** (full-screen canvas): the zone grid; every active cursor in a
  distinct color (`hue` from id) with its dwell ring + a small id badge; a HUD
  with **user count** + **connection state**.
- **Drop** a cursor's state when its id hasn't appeared for **> 0.5 s**.
- **Mouse-test fallback**: inject a local cursor `id = -1` driven by the mouse,
  so a wall can be exercised with no server.
- **Fullscreen** toggle on `f`. **Auto-reconnect** the WS with backoff.

Reuse note: `DwellSelector` already toggles `zone.selected` and applies a
cooldown; the shared per-zone lock is an **additional** cross-user guard layered
on top, not a replacement for the per-cursor cooldown.

---

## 10. Web shared core — `web/core.js`

Extract the pure classes from `web/gesturewall.js` into an ES module with
**named exports**, so both `gesturewall.js` and `wall.js` share one
implementation:

```js
export { OneEuroFilter, Point2DFilter,
         Zone, buildGrid,
         DwellSelector,
         Homography, WALL_CORNERS, CORNER_NAMES };
```

- Move `LowPassFilter`, `OneEuroFilter`, `Point2DFilter`, `Zone`, `buildGrid`,
  `DwellSelector`, `Homography` (+ its `getPerspectiveTransform`/`solveLinear`
  helpers) and `WALL_CORNERS` / `CORNER_NAMES` verbatim from `gesturewall.js`.
- `web/gesturewall.js` then **imports** them from `./core.js` instead of defining
  them — **no behavior change**. The MediaPipe import, `PoseSource`,
  `MouseSource`, `App`, and the `DOMContentLoaded` bootstrap stay in
  `gesturewall.js`.
- **Verification** (node check): strip the mediapipe import + `DOMContentLoaded`
  bootstrap, import `core.js`, and assert: a `Homography.fromCornerPoints` corner
  round-trip to ~`1e-12`; 1-Euro steady-state convergence; a `DwellSelector`
  toggle (enter zone → advance time past `dwellSeconds` → `selected` flips).

---

## 11. Calibration CLI — `gesturewall/calibrate.py`

Produce/store homographies into `room.json`. `cv2`/`mediapipe` imported lazily;
the **pure math** is factored out and unit-tested without a camera.

```
.venv/bin/python -m gesturewall.calibrate --config room.json --camera cam0 --wall A
.venv/bin/python -m gesturewall.calibrate --config room.json --floor  cam0
```

- `--camera <cam> --wall <wall>`: run the **4-corner point-and-press-SPACE**
  capture for that pair (reuse `app.calibrate_pose`'s approach, but with
  `MultiPoseSource` picking the **most-engaged** person — highest `confidence`
  among engaged — as the calibrator). Writes
  `calibration["<cam>-><wall>"] = {"matrix": ...}`.
- `--floor <cam>`: capture **4 floor reference points** to build that camera's
  `room_homography`, written to `cameras[<cam>].room_homography`.

Factored pure functions (the unit-test targets):

```python
def homography_from_captures(corners: list[tuple[float,float]]) -> Homography:
    """4 captured points -> Homography via Homography.from_corner_points."""

def write_cam_wall_calibration(config: dict, cam: str, wall: str,
                               matrix: list[list[float]]) -> dict:
    """Merge calibration['<cam>-><wall>'] = {'matrix': matrix} into the config dict."""

def write_room_homography(config: dict, cam: str,
                          matrix: list[list[float]]) -> dict:
    """Merge cameras[cam]['room_homography'] = matrix into the config dict."""
```

These operate on plain dicts (load/merge/save the `room.json` round-trip) so they
are tested with no camera: capture-list → matrix, and dict-merge correctness
(including not clobbering sibling keys). The interactive capture loop is the only
camera-touching part and is kept thin.

The **seam check** (slide 9) is a manual procedure: after calibrating both
seam-side pairs, sweep a hand across the join; the cursor should leave A's right
edge and enter B's left edge at the same height. If it jumps, re-capture the
seam-side corners.

---

## 12. File-by-file map

New / changed files (all paths absolute under the repo root
`/Users/wk/conductor/workspaces/gesture-wall/asuncion`):

| Path | Kind | Purpose |
|---|---|---|
| `PLAN.md` | doc | this design |
| `gesturewall/room.py` | new | `WallCfg/CameraCfg/Adjacency/FusionCfg/ServerCfg/RoomConfig`; load+validate; `cam_to_wall`, `room_homography`, `serves` |
| `room.example.json` | new | valid instance of the schema (two walls, three cameras) |
| `gesturewall/multipose.py` | new | `people_from_landmarks` (pure) + `MultiPoseSource` (lazy cv2/mediapipe) |
| `gesturewall/tracking.py` | new | pure: `distance`, `cluster_observations`, `Tracker` |
| `gesturewall/fusion.py` | new | pure: `FusionEngine`, `choose_wall` seam helper; `Person/RoomObs/Track/Cursor` dataclasses |
| `gesturewall/server.py` | new | asyncio+threads server; `step_pipeline`, `FakeSource`, WS+HTTP, CLI |
| `gesturewall/calibrate.py` | new | calibration CLI; pure `homography_from_captures`, `write_*` helpers |
| `web/core.js` | new | named-export ES module of the pure JS classes |
| `web/gesturewall.js` | edit | import the pure classes from `./core.js` (no behavior change) |
| `web/wall.html` | new | networked multi-cursor wall client page |
| `web/wall.js` | new | WS client; per-cursor filter+dwell; shared per-zone lock; render |
| `tests/test_room.py` | new | schema parse/validate, `cam_to_wall`, `room_homography`, `serves` |
| `tests/test_multipose.py` | new | `people_from_landmarks` (duck-typed landmarks, mirror, engage, anchor, confidence) |
| `tests/test_tracking.py` | new | clustering, id stability/reuse, ageing, sort order |
| `tests/test_fusion.py` | new | per-wall mapping/gate/arbitrate, seam hysteresis (`choose_wall`) |
| `tests/test_server.py` | new | `step_pipeline` end-to-end with `FakeSource`/scripted Persons, no camera/asyncio |
| `tests/test_calibrate.py` | new | `homography_from_captures`, `write_*` dict-merge |

Where the dataclasses live: `Person/RoomObs/Track/Cursor` are defined once (in
`fusion.py`, or a small shared module imported by `tracking.py`/`server.py`) and
imported everywhere else — no duplication. Add the new public types to
`gesturewall/__init__.py`'s re-exports for convenience, keeping the lazy-import
discipline (only pure types/functions at import time).

Reused unchanged: `gesturewall/calibration.py` (`Homography`),
`gesturewall/filters.py`, `gesturewall/zones.py`, `gesturewall/dwell.py`,
`gesturewall/sources.py` (single-cam `PoseSource`), `gesturewall/app.py` (the
original single-wall app), `web/index.html`.

---

## 13. Build / run commands

```bash
# Python interpreter is the project venv:
.venv/bin/python ...

# Validate the room config:
.venv/bin/python -c "from gesturewall.room import RoomConfig; RoomConfig.load('room.example.json')"

# Calibrate (camera; one per served pair) + floor homographies:
.venv/bin/python -m gesturewall.calibrate --config room.json --camera cam0 --wall A
.venv/bin/python -m gesturewall.calibrate --config room.json --camera cam1 --wall A
.venv/bin/python -m gesturewall.calibrate --config room.json --camera cam1 --wall B
.venv/bin/python -m gesturewall.calibrate --config room.json --camera cam2 --wall B
.venv/bin/python -m gesturewall.calibrate --config room.json --floor  cam1

# Run the sensing server (serves web/ over HTTP + WS cursor streams):
.venv/bin/python -m gesturewall.server --config room.json
# overrides: --ws-port 8770 --http-port 8000 --fps 30 --num-poses 4

# Open the wall clients (one fullscreen per projector):
#   http://localhost:8000/wall.html?wall=A&server=ws://localhost:8770&rows=2&cols=3
#   http://localhost:8000/wall.html?wall=B&server=ws://localhost:8770&rows=2&cols=3

# Tests (headless, no camera/mediapipe/websockets needed at runtime):
.venv/bin/python -m pytest -q                       # full suite (must stay green; 44 pre-existing)
.venv/bin/python -m pytest -q tests/test_room.py
.venv/bin/python -m pytest -q tests/test_tracking.py
.venv/bin/python -m pytest -q tests/test_fusion.py
.venv/bin/python -m pytest -q tests/test_server.py
.venv/bin/python -m pytest -q tests/test_multipose.py
.venv/bin/python -m pytest -q tests/test_calibrate.py

# JS checks (Node 20):
node --check web/core.js
node --check web/wall.js
node web/_core_check.mjs        # Homography round-trip / 1-euro / dwell assertions
```

Testing rules (restated): every new Python module ships `tests/test_<module>.py`,
runs headless, and exercises pure standalone functions (mediapipe-using classes
are imported only because their imports are lazy). Do **not** break the existing
44 passing tests. For JS, validate that modules parse and exports import.

---

## 14. Build order (incremental bring-up — slides 4–11)

1. **`room.py` + `room.example.json`** — config + validation; tests green.
2. **`web/core.js`** extraction + `gesturewall.js` re-import; node check passes
   (the only change to existing web behavior is *where* the classes live).
3. **`multipose.py`** — `people_from_landmarks` (pure) + `MultiPoseSource`.
4. **`tracking.py`** then **`fusion.py`** — pure; the heart of multi-user/multi-wall.
5. **`server.py`** — `step_pipeline` first (testable), then asyncio/threads/WS/HTTP
   + `FakeSource`.
6. **`wall.html` + `wall.js`** — networked client; mouse-test fallback proves it
   end-to-end with `FakeSource` before real cameras.
7. **`calibrate.py`** — pure math + interactive capture; calibrate all four pairs.
8. **Seam check** + tune `seam_margin`/hysteresis on the real room.

This is the slideshow's checklist (slide 11): align projectors → add a remote
pointer path → one wall → two walls → fusion + seam handoff → calibrate four
pairs → seam check. The crucial ordering — **geometry → projector alignment →
camera calibration → run** — holds because cameras are calibrated to the
*projected* corners (slide 4b).

---

## 15. Known limitations & future work

- **2D absolute pointing, not 3D ray-casting.** We map the wrist position in the
  image onto the wall via a homography (as today). Robust for coarse tiles; not
  metric. Upgrade path: a depth camera + true eye→hand ray intersected with the
  wall plane (a new source feeding `Person`).
- **Identity fusion is position-only.** The `Tracker` matches by `room_xy`
  proximity; it has no appearance model, so two people who cross within
  `merge_radius` can swap ids. Mitigations/future: tighter `merge_radius`,
  velocity prediction, or a lightweight re-ID embedding.
- **Room homography may be `null`.** With no floor calibration, `room_xy` falls
  back to the raw anchor, so cross-camera fusion only works cleanly when cameras
  share a frame. Floor calibration (`--floor`) is what makes overlapping cameras
  agree on identity (slide 3 "room frame").
- **Fusion `mode`.** Only `highest_confidence` is implemented; `average` (blend
  two agreeing views) is reserved in `FusionCfg.mode` for future work
  (slide 6 step 4).
- **Latency / stalled cameras.** Observations older than `track_max_age` are
  dropped so a frozen camera can't freeze a wall, but there is no clock-sync
  across cameras beyond per-observation timestamps (slide 10).
- **Occlusion.** Handled structurally by overlapping cameras (cam1 is the corner
  fallback, slide 5/10), not by skeletal inpainting — a fully occluded body in
  all cameras simply drops out until re-seen (then ages back in with a **new**
  id after `max_age`).
- **Conflict semantics are per-zone, not per-cursor priority.** The shared
  ~0.4 s zone lock stops double-toggles but doesn't arbitrate *who* "won" a
  contested tile beyond first-commit-wins; richer ownership is future work.
- **Single host.** All cameras + both projectors on one machine (slide 7). A
  distributed multi-host sensing mesh is out of scope here.

---

## 16. Mapping to the slideshow (`web/multiwall-setup.html`)

The slideshow is the narrative; this PLAN is its implementation. Slide ↔ artifact:

| Slide | Topic | This design |
|---|---|---|
| 1 — Two walls, three cameras | concrete room | `room.example.json` (walls A/B, cam0/1/2) |
| 2 — Separate sensing from display | core principle | the 5-layer split (§1); cameras emit `Person`, walls render `Cursor` |
| 3 — Three coordinate frames | image / wall / room | image=`Person.*`, wall=`Cursor.*` via `cam_to_wall`, room=`RoomObs.room_xy` via `room_homography`; 4 homographies not 6 (cam0→B, cam2→A absent) |
| 4 — Two connected walls | one continuous surface | two `wall.html` clients; seam = A.x=1 ≡ B.x=0; `adjacency` |
| 4b — Align projectors | make the seam invisible | order: geometry→align→calibrate→run (§14) |
| 5 — Three cameras | sides + corner | one capture+pose thread per camera; cam1 owns handoff + occlusion fallback |
| 6 — Fusion layer | 3 obs → 1 cursor/wall | `FusionEngine.update`: map · gate · arbitrate · **seam handoff** (§7) |
| 7 — Deployment architecture | server + clients | `server.py` (pose·H·fuse over WS) + thin browser walls |
| 8 — One config file | room.json | `room.py` schema (§4); single-wall is the 1×1 subset |
| 9 — Calibrate the room | four pairs, same routine | `calibrate.py` per `<cam>-><wall>` + `--floor`; seam check |
| 10 — Failure modes | jumps/flicker/occlusion/latency/multi-user | hysteresis (`choose_wall`), `seam_margin`, overlapping cams, `track_max_age` drop, `num_poses` + `Tracker` |
| 11 — Build order / hardware | checklist | §14 incremental bring-up |

One deliberate refinement over the slideshow: slide 8 shows
`"fusion": "highest_confidence"` and `"server": {"ws_port": 8770}` in shorthand;
the CONTRACT (and this PLAN) use the fuller objects
`"fusion": { "mode": "highest_confidence", "merge_radius": ..., "track_max_age": ... }`
and a fuller `"server"` block. The slideshow's compact form is a valid mental
model; `room.example.json` is the authoritative, fully-specified instance.

---

## Depth-ray pointing (Kinect v2, roaming users)

Everything above (§1–§16) is the **2D-homography path**: a camera maps a wrist's
*image position* onto a wall through a per-(camera, wall) perspective transform.
That path stays the default and keeps all 159 tests green. This section adds a
**second, opt-in path** — eye→hand **ray casting** against a wall **plane in the
room frame**, fed by a **Kinect v2 depth camera** — so that pointing becomes
**invariant to where the user stands**. A person can roam the room and still
point at a tile; the 2D path can't do that. The two paths coexist: a room config
is in **depth mode** or **homography mode** (RoomConfig.mode, §D.2), and the same
`step_pipeline`, the same `Track`/`Cursor`, the same wall clients serve both.

### A. Why absolute homography is location-locked (and the fix)

A homography `H: image → wall` is a *fixed* 2-D→2-D map. It was solved once, by
asking one person standing in one spot to point at the four wall corners. It
encodes a single answer to "where on the wall does *this* image pixel mean?" —
an answer that is **only correct for a body in roughly that calibration pose and
place**. Move the pointer two metres sideways and the same arm gesture lands on a
different image pixel, which `H` faithfully maps to the *wrong* tile. The map has
no notion of the person's 3-D position, so it cannot compensate for it. In the
multi-wall design this is exactly the "2D absolute pointing, not 3D ray-casting"
limitation called out in §15: *robust for coarse tiles, not metric, location-locked.*

The fix is the natural one a laser-pointer already implements: cast a **ray**
from the **eye through the hand** and intersect it with the **physical wall
plane**. Where the ray pierces the wall is where the person is pointing — and
that is invariant to standing position, because both endpoints (eye, hand) are
measured in the **same room-frame metric space** as the wall. Walk anywhere; as
long as the eye→hand line still crosses the wall rectangle, the hit `(u, v)` is
the tile you mean. This needs **3-D positions of the eye and the hand**, which a
plain RGB camera does not give — but a **depth camera** does.

```
  homography path (location-locked)        depth-ray path (roaming-invariant)
  ───────────────────────────────         ──────────────────────────────────
   wrist image px ──H──▶ wall (u,v)         eye_room ─┐
        ▲                                             ├─ Ray ──▶ WallPlane.intersect ──▶ (u,v,t)
   one fixed 2D map, valid only             hand_room ┘         (u,v) on the physical wall,
   near the calibration spot                          same room metric as the wall =>
                                                       answer independent of where you stand
```

### B. The macOS Kinect v2 reality (what we actually get)

From the libfreenect2 reference (`.context/attachments/31U6Q8/...`) and the
upstream project: on macOS there is **no Microsoft skeleton/body-tracking SDK**.
What `libfreenect2` *does* give us, reliably, over USB 3.0:

- **Registered color + undistorted depth, pixel-aligned at 512×424.**
  `libfreenect2::Registration::apply` produces a `registered` color image and an
  `undistorted` depth image that are **the same size and pixel-for-pixel
  aligned**: depth pixel `(px, py)` and color pixel `(px, py)` look at the same
  point in the scene. This is the single most important property we rely on.
- **IR camera intrinsics** via `getIrCameraParams()` → `fx, fy, cx, cy` for the
  512×424 depth/registered frame. These are the pinhole parameters we deproject
  with.
- Depth in **millimetres** (`float32`), native to libfreenect2. We convert to
  **metres** at the Python boundary (§F) so all geometry is metric.

What we therefore have to build ourselves — and do:

- **Pose from color, depth from the aligned map.** No skeleton on macOS, so we
  run **MediaPipe PoseLandmarker on the registered color** (exactly the existing
  pose path, just on a 512×424 BGR frame) to get 2-D body keypoints, then read
  each keypoint's **depth from the aligned depth map at the same pixel** and
  **deproject** it to a 3-D camera-frame point. MediaPipe-on-color + depth-sample
  *is* our "3-D skeleton".
- **A tiny C++ bridge.** Per the reference's recommended architecture (native
  driver → small C++ bridge → child process → app), `native/kinect_v2_bridge.cc`
  opens the Kinect (CPU pipeline for portability), runs `Registration::apply`,
  and emits a **binary protocol on stdout** (intrinsics frame + per-frame
  color+depth); Python spawns it and parses frames. This cannot be compiled or
  tested without libfreenect2 + the actual sensor (noted in the source).

### C. Full data flow (Kinect frame → Cursor)

```
 Kinect v2  ──libfreenect2 Registration::apply──▶  registered color 512×424 BGR
   (USB3)                                           undistorted depth 512×424 (mm)
      │                                                    │
      ▼  native/kinect_v2_bridge.cc  (K2IN once, then K2RG per frame, stdout)
 ┌────────────────────────────────────────────────────────────────────────────┐
 │ gesturewall/kinect.py : KinectV2Source                                       │
 │   parse_frames(buffer) → (color uint8 512×424×3 BGR,                          │
 │                           depth_m float32 512×424 = mm/1000,                  │
 │                           intr CameraIntrinsics)                              │
 └────────────────────────────────────────────────────────────────────────────┘
      │ (color, depth_m, intr)            + fixed extr (from room.json, per cam)
      ▼  gesturewall/depth.py : KinectPoseSource (LAZY mediapipe)
   MediaPipe PoseLandmarker(VIDEO, num_poses) on color  ──▶ per-pose landmarks
      │
      ▼  keypoints_from_landmarks(landmarks, 512, 424)  → pixel (px,py,vis) dict
      ▼  build_person3d(kps, depth_m, intr, extr, mirror)               [PURE]
          for each of {eye-origin, wrist, hip-centroid, shoulder}:
             sample_depth(depth_m, px, py)  → metres
             intr.deproject(px, py, d)      → (X,Y,Z) CAMERA frame
             extr.apply(p3)                 → ROOM frame 3-D point
          ray      = Ray(origin = eye_room (fallback shoulder_room),
                         direction = wrist_room − origin)
          room_xy  = floor_xy(hip_centroid_room) = (x, z)
          Person(... , ray=ray, room_xy=room_xy)            ← new optional fields
      │ list[Person]  (each carrying ray + room_xy)
      ▼  gesturewall/server.py : step_pipeline (MODE-AWARE)
   persons_to_room_obs:  prefer person.room_xy (already room floor coords)
   Tracker.update                                 → list[Track]  (stable ids)
   DepthFusionEngine.update  (subclass of FusionEngine):
        _candidates_for_track: for each wall, intersect each member.person.ray
            with config.wall_plane(wall)  → (u,v,t);  in-bounds if 0≤u,v≤1
        choose_wall (INHERITED hysteresis) · clamp · emit                → Cursor
      │ dict[wall, list[Cursor]]
      ▼  WS broadcast (unchanged protocol)  →  wall.html?wall=A / wall=B
```

The only genuinely new geometry is `build_person3d` (pixel+depth → room ray) and
`WallPlane.intersect` (ray → wall hit). Everything downstream of `Track` —
clustering, identity, seam hysteresis, clamping, `Cursor` emission, the WS
protocol, the wall clients — is **reused unchanged**.

### D. Math conventions (LOCKED — same as the CONTRACT)

These are fixed so every new module agrees and cannot drift:

- **3-D points/vectors** are Python `tuple[float, float, float]`.
- **CAMERA frame = OpenCV**: `+Z` forward into the scene, `+X` right, `+Y` down;
  depth is `+Z`.
- **ROOM frame = right-handed, `+Y` up**, floor = the `XZ` plane;
  `floor_xy(p) = (p[0], p[2])`.
- **Depth handed to geometry is in METRES** (the Kinect source converts mm→m).
- **Pinhole deproject**: `X = (px−cx)·d/fx`, `Y = (py−cy)·d/fy`, `Z = d`.
- **Pinhole project** (the inverse): `px = fx·X/Z + cx`, `py = fy·Y/Z + cy`,
  defined only for `Z > 0` (raise/None otherwise).

#### D.1 `WallPlane` / ray intersection (the load-bearing geometry)

A wall is a **finite rectangle** parameterised by a corner and two edge vectors:
`WallPlane(origin, u_vec, v_vec)` where `origin` is the `(u=0, v=0)` corner,
`u_vec` spans to `(u=1, v=0)`, `v_vec` spans to `(u=0, v=1)`, and
`normal() = normalize(cross(u_vec, v_vec))`. Intersecting a `Ray(origin, dir)`:

```
 n      = normal()
 denom  = dot(ray.dir, n)
 if |denom| < 1e-9:            return None        # ray parallel to the wall
 t      = dot(origin − ray.origin, n) / denom
 if t <= 0:                    return None        # wall is behind the eye→hand
 hit    = ray.origin + t·ray.dir
 u      = dot(hit − origin, u_vec) / dot(u_vec, u_vec)
 v      = dot(hit − origin, v_vec) / dot(v_vec, v_vec)
 return (u, v, t)             # inside the wall  ⟺  u,v ∈ [0,1]
```

`(u, v)` are exactly the wall-normalized cursor coords the rest of the pipeline
already speaks (`Cursor.x`/`.y`), so a depth hit drops straight into the existing
`WallCandidate`/`Cursor` machinery. `plane_from_corners(top_left, top_right,
bottom_left)` builds a `WallPlane` from three measured corners (origin = top-left,
`u_vec = top_right − top_left`, `v_vec = bottom_left − top_left`) — that is the
calibration entry point.

### E. New files (and what they add / reuse)

All paths absolute under `/Users/wk/conductor/workspaces/gesture-wall/asuncion`.
Every Python module ships `tests/test_<module>.py` (headless, no camera). The
**lazy-import rule** holds: `cv2`/`mediapipe`/`websockets` are imported only
inside functions/`__init__`; `numpy` may be top-level.

| Path | Kind | Adds / reuses |
|---|---|---|
| `gesturewall/geometry.py` | new, **PURE** (numpy ok, no cv2/mediapipe) | vector helpers; `CameraIntrinsics` (deproject/project); `Extrinsic` (4×4 CAMERA→ROOM, `identity`/`from_rt`/`apply`/`apply_dir`/`inverse`); `Ray`; `WallPlane` (+`intersect`); `sample_depth`; `plane_from_corners`; `rigid_transform_from_points` (Kabsch/Umeyama via numpy SVD) |
| `gesturewall/room.py` | **extend** | optional depth fields with defaults (§D.2); `wall_plane`/`intrinsics`/`extrinsic` accessors; mode-aware `serves`; `mode` property. **No existing signature changes**; homography configs + `room.example.json` still load |
| `room.example.depth.json` | new | a valid 2-wall (A,B) / 2-camera (cam0,cam1 `kinect_v2`) **depth-mode** instance: Kinect IR intrinsics (`fx=fy≈365, cx=256, cy=212, 512×424`), cam0 identity extrinsic + cam1 translated/rotated, wall planes in room frame, `num_poses` 4 |
| `gesturewall/multipose.py` | **extend** | `Person` gains two optional fields **appended last**: `ray: geometry.Ray | None = None`, `room_xy: tuple[float,float] | None = None`. `people_from_landmarks` behavior unchanged; existing positional/keyword construction still works |
| `gesturewall/depth.py` | new, **PURE** except a lazy `KinectPoseSource` | `keypoints_from_landmarks` (normalized→pixel); `build_person3d` (pixel+depth+intr+extr → `Person` with ray+room_xy, pure); `KinectPoseSource` (lazy mediapipe; wraps a frame source + fixed extr); `FakeFrameSource` for tests |
| `gesturewall/depth_fusion.py` | new | `DepthFusionEngine(FusionEngine)`: **overrides only** `_candidates_for_track` to build `WallCandidate`s by ray/plane intersection. **Inherits** `choose_wall` hysteresis, `update`, `Cursor` emission, clamping. Reuses `WallCandidate`/`Cursor`/`choose_wall` from `fusion.py` |
| `gesturewall/calibrate.py` | **extend** | pure config-writers `merge_wall_plane`, `merge_camera_pose`, and `extrinsic_from_correspondences` (wraps `geometry.rigid_transform_from_points`); cv2/mediapipe stay lazy |
| `native/kinect_v2_bridge.cc` + `native/build_kinect_v2.sh` | new, **Hardware** | libfreenect2 bridge: open default Kinect (CPU pipeline), `Registration::apply`, emit `K2IN`+`K2RG` binary protocol on stdout, logs to stderr; build script via `pkg-config freenect2`; header comment with full macOS prereqs. *Cannot be built/tested without libfreenect2 + hardware* |
| `gesturewall/kinect.py` | new, **Hardware** (LAZY) | `KinectV2Source`: spawn `bin/kinect-v2-bridge`, parse `K2IN`/`K2RG` → `(color, depth_m, intr)`; pure `parse_frames(buffer) → (frames, left)`; `FakeFrameSource` for tests |
| `gesturewall/server.py` | **extend** | `Pipeline` becomes mode-aware (`DepthFusionEngine` when `config.mode=="depth"`); `persons_to_room_obs` prefers `person.room_xy` when set, else falls back to `room_homography(anchor)`. `step_pipeline` stays signature-compatible for **both** modes. Real runtime builds `KinectPoseSource` per camera in depth mode (lazy, off the import path). Importing the module still needs no camera |
| `KINECT.md` | new, **Hardware** | the full macOS path: install/build libfreenect2, build the bridge, write the depth `room.json`, calibrate (corners→plane, 2nd cam→extrinsic), run; why ray pointing enables roaming |

Reused **unchanged**: `calibration.py` (`Homography`), `filters.py`, `zones.py`,
`dwell.py`, `tracking.py` (`Tracker`/`RoomObs`/`Track`/`cluster_observations`),
`fusion.py` (`FusionEngine`/`WallCandidate`/`choose_wall`/`Cursor`), the WS
protocol (§3), `web/wall.html` + `web/wall.js` + `web/core.js`.

#### D.2 `room.py` depth extensions (optional fields, defaults — nothing breaks)

`WallCfg`, `CameraCfg` gain optional depth fields that **default to `None`** so
every existing homography config, `room.example.json`, and the 29
`test_room.py` cases stay valid:

```python
@dataclass
class WallCfg:
    display: int; rows: int; cols: int
    plane: WallPlane | None = None        # JSON: "plane": {"origin":[x,y,z],
                                          #         "u_vec":[..], "v_vec":[..]}

@dataclass
class CameraCfg:
    device: int; serves: list[str]
    room_homography: Matrix | None = None
    kind: str = "rgb"                     # "rgb" | "kinect_v2"
    intrinsics: CameraIntrinsics | None = None   # {"fx","fy","cx","cy","width","height"}
    extrinsic:  Extrinsic | None = None          # {"matrix": 4x4} OR {"R": 3x3, "t": 3}
```

New `RoomConfig` API (all raising clear errors on absence/malformed input):

```python
def wall_plane(self, wall_id) -> WallPlane:          # KeyError/ValueError if absent
def intrinsics(self, cam_id)  -> CameraIntrinsics:
def extrinsic(self, cam_id)   -> Extrinsic:

@property
def mode(self) -> str:        # "depth" iff every camera that serves a wall has
                              # intrinsics+extrinsic AND every served wall has a
                              # plane; else "homography"
```

`serves(cam, wall)` becomes **mode-aware** (and is the single rule both
`serves()` and the fusion engines consult):

- **homography mode** (unchanged): `wall in cam.serves` **and** calibration
  `"<cam>-><wall>"` exists.
- **depth mode**: `wall in cam.serves` **and** the camera has intrinsics+extrinsic
  **and** the wall has a plane. **No `cam->wall` homography is required** — in
  depth mode the `"calibration"` block may be empty/absent and that is **valid**.

**Validation**: depth fields are optional; when present, shapes are checked
(intrinsics = 6 numbers; extrinsic = a 4×4 matrix *or* `R` 3×3 + `t` 3; plane =
three 3-vectors). **All existing homography-mode validation and messages are
kept verbatim.** `test_room.py` is extended (never reduced) with: depth-mode load
of `room.example.depth.json`; the `mode` property both ways; the new accessors;
`serves()` in depth mode; and malformed-intrinsics/extrinsic/plane failures.

### F. Depth room.json schema

A **depth-mode** config differs from the homography schema (§4.1) only in: each
camera declares `kind: "kinect_v2"` + `intrinsics` + `extrinsic`; each wall
declares a `plane`; and the `calibration` block may be omitted. `room.example.depth.json`
is the authoritative instance.

```json
{
  "walls": {
    "A": { "display": 1, "grid": { "rows": 2, "cols": 3 },
           "plane": { "origin": [-2.0, 0.0, 3.0],
                      "u_vec":  [ 2.0, 0.0, 0.0],
                      "v_vec":  [ 0.0, 1.5, 0.0] } },
    "B": { "display": 2, "grid": { "rows": 2, "cols": 3 },
           "plane": { "origin": [ 0.1, 0.0, 3.0],
                      "u_vec":  [ 2.0, 0.0, 0.0],
                      "v_vec":  [ 0.0, 1.5, 0.0] } }
  },
  "adjacency": [ { "left": "A", "right": "B", "seam_margin": 0.06 } ],
  "cameras": {
    "cam0": { "device": 0, "serves": ["A"], "kind": "kinect_v2",
              "intrinsics": { "fx": 365.0, "fy": 365.0, "cx": 256.0, "cy": 212.0,
                              "width": 512, "height": 424 },
              "extrinsic": { "matrix": [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]] } },
    "cam1": { "device": 1, "serves": ["B"], "kind": "kinect_v2",
              "intrinsics": { "fx": 365.0, "fy": 365.0, "cx": 256.0, "cy": 212.0,
                              "width": 512, "height": 424 },
              "extrinsic": { "R": [[..],[..],[..]], "t": [2.0, 0.0, 0.0] } }
  },
  "calibration": {},
  "fusion": { "mode": "highest_confidence", "merge_radius": 0.35, "track_max_age": 0.5 },
  "server": { "ws_port": 8770, "http_port": 8000, "fps": 30, "num_poses": 4,
              "mirror": true, "min_confidence": 0.5,
              "model": "models/pose_landmarker_lite.task" }
}
```

- `plane` corners/edges and `extrinsic.t` are **metres in the room frame**;
  `intrinsics` are the Kinect IR pinhole params for the 512×424 registered frame.
- `extrinsic` accepts either a full `4×4 matrix` (CAMERA→ROOM, row-major) or the
  `R` (3×3) + `t` (3) pair, which `Extrinsic.from_rt` assembles.
- cam0's identity extrinsic means cam0's frame *is* the room frame; cam1 carries a
  translated/rotated pose so two Kinects agree on one room.

### G. Server wiring (both modes through one seam)

`Pipeline` (and `step_pipeline`) stay **signature-compatible** and serve both
modes:

1. **Engine selection**: `Pipeline.__init__` picks `DepthFusionEngine(config)`
   when `config.mode == "depth"`, else `FusionEngine(config)`. Both expose the
   same `update(tracks, t) -> dict[wall, list[Cursor]]`.
2. **Room mapping**: `persons_to_room_obs` **prefers `person.room_xy`** when it is
   set (the depth path already produces room-frame floor coords from the hip
   centroid), and otherwise falls back to `room_homography(anchor)` (the existing
   2-D path, untouched). This is the one behavioural seam, and it is additive.
3. **Candidates**: in depth mode `DepthFusionEngine._candidates_for_track`
   intersects each member `person.ray` with `config.wall_plane(wall)`; an in-bounds
   hit becomes a `WallCandidate(wall, x=u, y=v, confidence=person.confidence,
   in_bounds=0≤u≤1 ∧ 0≤v≤1)`, highest-confidence kept per wall. Hysteresis,
   clamping and emission are inherited.
4. **Runtime source**: in depth mode `serve()` builds a `KinectPoseSource` per
   camera (extrinsic from config) instead of `MultiPoseSource` — kept **lazy/off
   the import path**, so `import gesturewall.server` still needs no camera.

`test_server_pipeline.py` is extended (its dropout test and all others stay
green) with a depth-mode config + scripted `Person`s carrying rays driven through
`step_pipeline`, asserting correct per-wall cursors and stable ids. The Midas-touch
freshness filter (§8.1) is mode-agnostic and still applies.

### H. Calibration procedure (depth mode)

Two measurements per room, both reducing to pure helpers that round-trip through
`room.json` and are unit-tested without a camera (`test_calibrate.py`, extended):

1. **Wall plane** — capture the three room-frame 3-D corners of each wall
   (top-left, top-right, bottom-left) with a depth probe, build a `WallPlane` via
   `geometry.plane_from_corners`, and write it with
   `merge_wall_plane(config_dict, wall_id, plane)` → wall `"plane"`. Round-trips
   back through `RoomConfig.wall_plane`.
2. **Camera pose** — the first Kinect is the room origin (identity extrinsic).
   Register each additional Kinect by capturing point correspondences (a few 3-D
   points seen by both, expressed in the room frame and in that camera's frame)
   and solving `extrinsic_from_correspondences(src_room_pts, observed_cam_pts)`
   = `geometry.rigid_transform_from_points` (Kabsch/Umeyama). Write intrinsics +
   extrinsic with `merge_camera_pose(config_dict, cam_id, intrinsics, extrinsic,
   kind="kinect_v2")`; both round-trip through `RoomConfig.intrinsics` /
   `RoomConfig.extrinsic`.

The unit tests assert: a plane round-trips through JSON into
`RoomConfig.wall_plane`; `merge_camera_pose` makes `RoomConfig.intrinsics`/
`extrinsic` work; and `extrinsic_from_correspondences` recovers a known `R, t`.

### I. Limitations / how this updates §15

This **resolves** the first §15 limitation ("2D absolute pointing, not 3D
ray-casting"): depth mode *is* the eye→hand-ray + wall-plane upgrade named there
as the future path. Remaining caveats specific to the depth path:

- **No skeleton on macOS** — pose comes from MediaPipe-on-color, so depth quality
  rides on color-pose quality; missing/zeroed depth at a keypoint reduces
  confidence and, if the wrist or eye origin has no valid depth, drops the
  `Person` (no ray rather than a wrong ray).
- **Extrinsic accuracy gates multi-Kinect agreement** — two sensors only share a
  room frame as well as their registered extrinsics; a sloppy 2nd-camera
  registration shifts its rays. (Same spirit as the homography-mode floor-calibration
  caveat.)
- **Sensor reality** — Kinect v2 needs USB 3.0 and is bandwidth-delicate
  (reference §16); the CPU pipeline trades frame-rate for portability. The bridge
  cannot be built or tested without libfreenect2 + hardware (called out in its
  header).
- **Identity is still position-only** — the `Tracker` is unchanged, so the
  appearance-model and Midas-touch notes in §15 carry over verbatim.
