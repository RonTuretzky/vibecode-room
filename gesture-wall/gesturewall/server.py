"""Multi-wall gesture server: cameras -> tracks -> per-wall cursors -> clients.

This ties the multi-wall pipeline together and streams each wall its own cursor
list over websockets:

  * One **capture+pose worker thread per camera** (cv2/mediapipe are blocking)
    feeds a shared "latest Persons per camera" dict, each entry stamped with the
    time it was produced.
  * A ``~fps`` async loop snapshots those Persons, maps every person's hip
    ``anchor`` into the shared room frame via that camera's ``room_homography``
    (cameras with a null room map fall back to using the raw anchor as
    ``room_xy``), runs the :class:`~gesturewall.tracking.Tracker` to fuse bodies
    into persistent :class:`~gesturewall.tracking.Track` objects, then runs the
    :class:`~gesturewall.fusion.FusionEngine` to get per-wall
    :class:`~gesturewall.fusion.Cursor` lists.
  * Each subscriber registered a wall in its ``hello`` message and receives only
    that wall's cursors every tick.
  * A threaded ``http.server`` serves the ``web/`` directory so wall clients can
    be loaded from the same origin as the websocket.

The whole camera-free part of the pipeline is factored into
:func:`step_pipeline` (room-mapping + Tracker + FusionEngine, no cv2/asyncio) so
it is unit-testable, and a :class:`FakeSource` returns scripted frames for tests.
cv2/mediapipe are only touched inside the camera worker (via
:class:`~gesturewall.multipose.MultiPoseSource`), so **importing this module
never requires a camera**.

WS protocol (JSON text frames)::

    client -> server (first):  {"type": "hello", "wall": "A"}
    server -> client (tick):   {"type": "cursors", "wall": "A", "t": 12.3,
                                "cursors": [{"id": 7, "x": 0.42, "y": 0.31,
                                             "engaged": true, "conf": 0.88}, ...]}
"""

from __future__ import annotations

import argparse
import asyncio
import json
import threading
import time
from dataclasses import dataclass, field, replace

from .depth_fusion import DepthFusionEngine
from .filters import OneEuroFilter, Point2DFilter
from .fusion import Cursor, FusionEngine
from .geometry import Ray
from .multipose import Person
from .room import DEPTH_KINDS, RoomConfig
from .tracking import RoomObs, Track, Tracker


# --------------------------------------------------------------------------- #
# pointer smoothing — emit a clean (x, y) stream for ANY frontend             #
# --------------------------------------------------------------------------- #
class CursorSmoother:
    """Per-(wall, person) 1-Euro smoothing of the emitted cursor (x, y).

    Smoothing lives here, in the server, so the broadcast pointer stream is
    already steady — every frontend (the bundled wall client or any other you
    attach) consumes ready-to-use ``(x, y)`` and never has to reimplement a
    filter. The 1-Euro filter (Casiez et al.) removes hand-tremor jitter when
    the hand is still but stays responsive on fast moves; per-person state is
    kept across ticks and dropped when a cursor disappears. Pure: no cv2/asyncio.
    """

    def __init__(self, freq: float = 30.0, min_cutoff: float = 1.0,
                 beta: float = 0.02):
        self._params = (freq, min_cutoff, beta)
        self._filters: dict[tuple[str, int], Point2DFilter] = {}

    def apply(self, cursors_by_wall: dict[str, list[Cursor]],
              t: float) -> dict[str, list[Cursor]]:
        live: set[tuple[str, int]] = set()
        out: dict[str, list[Cursor]] = {}
        for wall, cursors in cursors_by_wall.items():
            smoothed: list[Cursor] = []
            for c in cursors:
                key = (wall, c.person_id)
                live.add(key)
                f = self._filters.get(key)
                if f is None:
                    f = Point2DFilter(*self._params)
                    self._filters[key] = f
                sx, sy = f(c.x, c.y, t)
                smoothed.append(replace(c, x=sx, y=sy))
            out[wall] = smoothed
        for key in [k for k in self._filters if k not in live]:
            del self._filters[key]
        return out


class _Vec3Smoother:
    """1-Euro smoothing of a 3D point (one filter per axis)."""

    def __init__(self, freq: float, min_cutoff: float, beta: float):
        self._f = tuple(OneEuroFilter(freq, min_cutoff, beta) for _ in range(3))

    def __call__(self, p, t: float):
        return (self._f[0](p[0], t), self._f[1](p[1], t), self._f[2](p[2], t))


class RaySmoother:
    """Per-track 1-Euro smoothing of the pointing RAY's 3D joints.

    In depth mode the cursor is where an eye->wrist ray hits the wall. The
    eye->wrist baseline (~0.5 m) is short relative to the throw to the wall
    (~2-4 m), so any wrist-position jitter is amplified ~5x at the wall — the
    single biggest reason raw pointing is twitchy. Smoothing the two 3D joints
    (the ray's origin and its wrist endpoint = origin+direction) HERE, before the
    fusion engine casts the ray, removes that jitter at the source; a downstream
    2D-cursor filter cannot recover what the amplification already blew up.

    Keyed by stable track id (from the Tracker, after identity is known) and
    camera, so each person's ray is smoothed independently; stale keys are
    dropped. Pure: no cv2/asyncio.
    """

    # Filter state survives a key going missing for this long. A single-frame
    # wrist depth hole drops the Person for one tick; deleting the 1-Euro
    # state instantly would make the returning cursor JUMP and re-converge —
    # exactly the jitter this smoother exists to remove. Held state longer
    # than a couple of ticks would instead bridge a genuine departure.
    HOLD_S = 0.25

    def __init__(self, freq: float = 30.0, min_cutoff: float = 1.0,
                 beta: float = 0.4):
        self._params = (freq, min_cutoff, beta)
        self._origin: dict[tuple[int, str], _Vec3Smoother] = {}
        self._end: dict[tuple[int, str], _Vec3Smoother] = {}
        self._last_seen: dict[tuple[int, str], float] = {}

    def apply(self, tracks: list[Track], t: float) -> list[Track]:
        live: set[tuple[int, str]] = set()
        out: list[Track] = []
        for tr in tracks:
            new_members = []
            for m in tr.members:
                ray = getattr(m.person, "ray", None)
                if ray is None:
                    new_members.append(m)
                    continue
                key = (tr.id, m.camera_id)
                live.add(key)
                of = self._origin.get(key)
                if of is None:
                    of = _Vec3Smoother(*self._params)
                    self._origin[key] = of
                    self._end[key] = _Vec3Smoother(*self._params)
                ef = self._end[key]
                o = ray.origin
                d = ray.direction
                end = (o[0] + d[0], o[1] + d[1], o[2] + d[2])
                so = of(o, t)
                se = ef(end, t)
                new_ray = Ray(origin=so,
                              direction=(se[0] - so[0], se[1] - so[1], se[2] - so[2]))
                new_person = replace(m.person, ray=new_ray)
                new_members.append(replace(m, person=new_person))
            out.append(replace(tr, members=new_members))
        for key in live:
            self._last_seen[key] = t
        # Evict only after HOLD_S of absence, not on the first missed tick.
        for key in [k for k, seen in self._last_seen.items()
                    if k not in live and t - seen > self.HOLD_S]:
            del self._origin[key]
            del self._end[key]
            del self._last_seen[key]
        return out


# --------------------------------------------------------------------------- #
# camera-free pipeline step (room-mapping + Tracker + FusionEngine)            #
# --------------------------------------------------------------------------- #
def persons_to_room_obs(persons_by_camera: dict[str, list[Person]],
                        config: RoomConfig) -> list[RoomObs]:
    """Lift each camera's Persons into the shared room frame as RoomObs.

    A person's room-frame floor position is resolved in priority order:

      1. ``person.room_xy`` when set — the depth path has already lifted the hip
         centroid into the room frame (``floor_xy`` of the 3D hip), so it is the
         authoritative floor position and needs no 2D homography.
      2. otherwise the hip ``anchor`` pushed through the observing camera's
         ``room_homography`` (the 2D homography path).
      3. otherwise (a camera with a null room map and no depth ``room_xy``) the
         raw ``anchor`` as ``room_xy``.

    Persons from a camera id the config does not know are skipped (defensive: a
    stray worker should not crash the fuser).
    """
    obs: list[RoomObs] = []
    cross = config.fusion.cross_camera
    for camera_id, persons in persons_by_camera.items():
        if camera_id not in config.cameras:
            continue
        room_hom = config.room_homography(camera_id)
        # Decoupled rooms (cross_camera=False): each camera's coordinates live
        # in its OWN unregistered frame, so name the frame after the camera and
        # the tracker will never compare positions across cameras.
        frame_id = "room" if cross else camera_id
        for person in persons:
            depth_room_xy = getattr(person, "room_xy", None)
            if depth_room_xy is not None:
                # Depth path already has room-frame floor coords; prefer them.
                room_xy = depth_room_xy
            else:
                ax, ay = person.anchor
                room_xy = (room_hom.apply(ax, ay)
                           if room_hom is not None else (ax, ay))
            obs.append(RoomObs(camera_id=camera_id, person=person,
                               room_xy=room_xy, frame_id=frame_id))
    return obs


class Pipeline:
    """The camera-free heart of the server: room-map -> track -> fuse.

    Holds the stateful :class:`~gesturewall.tracking.Tracker` and
    :class:`~gesturewall.fusion.FusionEngine` (both carry hysteresis/identity
    state across ticks), so a single :class:`Pipeline` instance must be advanced
    in time order. No cv2/asyncio dependency, so it is unit-testable on its own.
    """

    def __init__(self, config: RoomConfig):
        self.config = config
        self.tracker = Tracker(
            merge_radius=config.fusion.merge_radius,
            max_age=config.fusion.track_max_age,
        )
        # Mode-aware fusion: depth-mode rooms land tracks via 3D ray/plane
        # pointing (DepthFusionEngine), homography-mode rooms via the 2D
        # cam->wall homography (FusionEngine). Both are pure (no cv2/mediapipe),
        # so importing them off the module top level needs no camera.
        # Smoothing is applied where it matters most for each mode, so the
        # broadcast (x, y) is a clean pointer for ANY frontend (selection logic —
        # tiles, dwell, etc. — stays in the frontend). DEPTH mode smooths the 3D
        # ray joints UPSTREAM of the wall intersection (before ~5x amplification);
        # HOMOGRAPHY mode (no rays) smooths the final 2D cursor. One stage each.
        fps = float(config.server.fps)
        # server.smoothing scales BOTH 1-Euro cutoffs down (min_cutoff and
        # beta), so one config number means "this much steadier": jitter at
        # rest AND speed-adaptivity shrink together. 1.0 = historical tuning.
        s = float(config.server.smoothing)
        if config.mode == "depth":
            self.fusion = DepthFusionEngine(config)
            self.ray_smoother: RaySmoother | None = RaySmoother(
                freq=fps, min_cutoff=1.0 / s, beta=0.4 / s)
            self.smoother: CursorSmoother | None = None
        else:
            self.fusion = FusionEngine(config)
            self.ray_smoother = None
            self.smoother = CursorSmoother(
                freq=fps, min_cutoff=1.0 / s, beta=0.02 / s)

    def step(self, persons_by_camera: dict[str, list[Person]],
             t: float) -> dict[str, list[Cursor]]:
        """Advance one tick; return per-wall cursors (every wall key present).

        Output is a per-wall list of :class:`~gesturewall.fusion.Cursor`
        (``person_id, x, y, engaged, confidence``) with ``x, y`` in normalized
        wall coordinates ``[0, 1]^2`` and already smoothed — a frontend-agnostic
        pointer. What a cursor *means* (which tile, how to select) is up to the
        consuming frontend.
        """
        obs = persons_to_room_obs(persons_by_camera, self.config)
        tracks = self.tracker.update(obs, t)
        # Only emit cursors for tracks actually detected THIS frame. The tracker
        # keeps a track alive for max_age after its last sighting so a returning
        # person keeps their id (identity bridging) -- but if NO camera sees the
        # body this frame, fusing its stale members would coast a frozen cursor
        # that a frontend's dwell could ghost-complete (the Midas touch this
        # design fights). The multi-camera occlusion fallback is unaffected:
        # while ANY camera still sees the person the track is fresh (last_seen==t).
        fresh = [tr for tr in tracks if tr.last_seen >= t - 1e-9]
        if self.ray_smoother is not None:        # depth mode: smooth 3D ray joints
            fresh = self.ray_smoother.apply(fresh, t)
            return self.fusion.update(fresh, t)
        cursors = self.fusion.update(fresh, t)   # homography mode: smooth 2D cursor
        return self.smoother.apply(cursors, t)

    @property
    def tracks(self) -> list[Track]:
        """The tracker's currently-live tracks (without advancing time)."""
        return self.tracker.tracks


def step_pipeline(config: RoomConfig,
                  persons_by_camera: dict[str, list[Person]],
                  t: float,
                  pipeline: Pipeline | None = None) -> dict[str, list[Cursor]]:
    """Run one camera-free pipeline tick: anchors->room, Tracker, FusionEngine.

    Pass a persistent :class:`Pipeline` to keep tracking/fusion state across
    ticks (the normal case); omit it for a one-shot stateless evaluation. No
    camera, cv2, mediapipe or asyncio is touched, so this is the seam tests use
    to drive the whole fusion pipeline with scripted :class:`Person` lists.
    """
    if pipeline is None:
        pipeline = Pipeline(config)
    return pipeline.step(persons_by_camera, t)


# --------------------------------------------------------------------------- #
# sources (real MultiPoseSource is lazy; FakeSource is camera-free for tests)  #
# --------------------------------------------------------------------------- #
@dataclass
class FakeSource:
    """A scripted pose source mirroring :class:`MultiPoseSource.read`'s shape.

    ``frames`` is a list of per-call :class:`Person` lists. Each ``read()``
    returns ``(None, persons, info)`` and advances through the script; once the
    script is exhausted the last frame is repeated (so a slow consumer never
    starves). Lets the camera worker / server be exercised with no webcam.
    """

    frames: list[list[Person]] = field(default_factory=list)
    _i: int = 0
    closed: bool = False

    def read(self):
        if not self.frames:
            return None, [], {"status": "no_frame"}
        i = min(self._i, len(self.frames) - 1)
        persons = self.frames[i]
        self._i += 1
        return None, list(persons), {"status": "ok", "count": len(persons)}

    def close(self) -> None:
        self.closed = True


def make_pose_source(config: RoomConfig, camera_id: str):
    """Construct the real pose source for a configured camera (mode-aware).

    In depth mode each camera is a depth sensor (Kinect v2, Orbbec Gemini 335)
    lifted into the room frame: its ``kind`` picks the frame source via
    :func:`~gesturewall.framesource.make_frame_source`, wrapped in a
    :class:`~gesturewall.depth.KinectPoseSource` (color+depth -> 3D-ray
    Persons) using the camera's extrinsic from the config. In homography mode we
    build the 2D :class:`~gesturewall.multipose.MultiPoseSource`. Either way the
    heavy cv2/mediapipe import happens lazily inside the source's ``__init__``,
    so *calling* this is what (intentionally) requires a camera/model — not
    importing this module.
    """
    srv = config.server
    if config.mode == "depth":
        from .depth import KinectPoseSource       # lazy: pulls in cv2/mediapipe
        from .framesource import make_frame_source  # lazy: picks the sensor

        cam = config.cameras[camera_id]
        # Pre-kind Kinect configs parse kind as the "rgb" default; the depth
        # path historically always built a Kinect source, so keep that fallback
        # (autocal/calibrate do the same).
        kind = "kinect_v2" if cam.kind == "rgb" else cam.kind
        frame_source = make_frame_source(kind, cam.device)
        return KinectPoseSource(
            frame_source=frame_source,
            extrinsic=config.extrinsic(camera_id),
            num_poses=srv.num_poses,
            mirror=srv.mirror,
            min_confidence=srv.min_confidence,
            model_path=srv.model,
            pointing=srv.pointing,
        )

    from .multipose import MultiPoseSource  # lazy: pulls in cv2/mediapipe

    cam = config.cameras[camera_id]
    if cam.kind in DEPTH_KINDS:
        # A depth camera on the 2D webcam path means the config is not depth-
        # complete (usually serves=[] before calibration) — cv2.VideoCapture
        # would treat the serial as a filename and fail with no cursors ever.
        print(f"[gesturewall] WARNING: camera {camera_id!r} is a depth camera "
              f"({cam.kind}) but the room resolved to homography mode — run "
              f"the calibration (or fix 'serves') so depth mode engages")
    return MultiPoseSource(
        camera=cam.device,
        num_poses=srv.num_poses,
        mirror=srv.mirror,
        min_confidence=srv.min_confidence,
        model_path=srv.model,
    )


# --------------------------------------------------------------------------- #
# camera worker thread: source.read() -> shared latest-Persons store           #
# --------------------------------------------------------------------------- #
class LatestPersons:
    """Thread-safe "latest Persons per camera" store, each entry timestamped.

    Camera workers write; the server loop snapshots. Stale cameras (no fresh
    frame within ``max_age``) drop out of the snapshot so a dead worker stops
    contributing ghost observations.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._by_camera: dict[str, tuple[float, list[Person]]] = {}

    def set(self, camera_id: str, persons: list[Person], t: float) -> None:
        with self._lock:
            self._by_camera[camera_id] = (t, list(persons))

    def snapshot(self, now: float, max_age: float) -> dict[str, list[Person]]:
        """Persons per camera seen within ``max_age`` seconds of ``now``."""
        with self._lock:
            return {cam: persons
                    for cam, (t, persons) in self._by_camera.items()
                    if now - t <= max_age}


class CameraWorker(threading.Thread):
    """Blocking capture+pose loop for one camera, pushing into LatestPersons.

    The ``source_factory`` is called once inside the thread (so the lazy
    cv2/mediapipe construction happens off the asyncio loop). Tests pass a
    factory that returns a :class:`FakeSource`; production passes one that builds
    a :class:`~gesturewall.multipose.MultiPoseSource`.
    """

    def __init__(self, camera_id: str, source_factory, store: LatestPersons,
                 fps: int, clock=time.monotonic):
        super().__init__(name=f"camera-{camera_id}", daemon=True)
        self.camera_id = camera_id
        self._source_factory = source_factory
        self._store = store
        self._period = 1.0 / max(1, fps)
        self._clock = clock
        self._stop = threading.Event()
        self._source = None

    def stop(self) -> None:
        self._stop.set()

    def run(self) -> None:  # pragma: no cover - exercised via integration only
        try:
            self._source = self._source_factory()
        except Exception as e:  # noqa: BLE001 - log & exit; one bad cam != fatal
            print(f"[gesturewall] camera {self.camera_id!r} failed to start: {e}")
            return
        try:
            while not self._stop.is_set():
                start = self._clock()
                try:
                    _frame, persons, _info = self._source.read()
                except Exception as e:  # noqa: BLE001
                    print(f"[gesturewall] camera {self.camera_id!r} read error: "
                          f"{e}")
                    persons = []
                self._store.set(self.camera_id, persons, self._clock())
                rest = self._period - (self._clock() - start)
                if rest > 0:
                    self._stop.wait(rest)
        finally:
            try:
                if self._source is not None:
                    self._source.close()
            except Exception:  # noqa: BLE001
                pass


# --------------------------------------------------------------------------- #
# websocket framing helpers (pure)                                             #
# --------------------------------------------------------------------------- #
def cursor_to_wire(cursor: Cursor) -> dict:
    """Serialize one :class:`Cursor` to the on-the-wire JSON shape."""
    return {
        "id": cursor.person_id,
        "x": cursor.x,
        "y": cursor.y,
        "engaged": cursor.engaged,
        "conf": cursor.confidence,
    }


def cursors_message(wall: str, t: float, cursors: list[Cursor]) -> str:
    """Build the JSON text frame a wall client receives each tick."""
    return json.dumps({
        "type": "cursors",
        "wall": wall,
        "t": t,
        "cursors": [cursor_to_wire(c) for c in cursors],
    })


def parse_hello(raw: str) -> str:
    """Parse a client ``hello`` frame, returning the requested wall id.

    Raises :class:`ValueError` on a malformed message so the caller can reject
    the connection cleanly.
    """
    try:
        msg = json.loads(raw)
    except json.JSONDecodeError as e:
        raise ValueError(f"hello is not valid JSON: {e}") from e
    if not isinstance(msg, dict) or msg.get("type") != "hello":
        raise ValueError("first message must be {'type': 'hello', ...}")
    wall = msg.get("wall")
    if not isinstance(wall, str) or not wall:
        raise ValueError("hello must carry a non-empty string 'wall'")
    return wall


# --------------------------------------------------------------------------- #
# static http server for web/ (threaded)                                       #
# --------------------------------------------------------------------------- #
def start_http_server(directory: str, port: int) -> "object":
    """Serve ``directory`` over HTTP on ``port`` from a daemon thread.

    Returns the ``HTTPServer`` (call ``.shutdown()`` to stop it). Wall clients
    load from this same origin as the websocket so there is no cross-origin
    fuss.
    """
    import functools
    from http.server import HTTPServer, SimpleHTTPRequestHandler

    class _NoCacheHandler(SimpleHTTPRequestHandler):
        """Always revalidate: a stale cached wall.js on a projector silently
        skips new behavior (e.g. the calibration overlay) — an entire failed
        calibration session was traced to exactly that. no-cache still allows
        conditional requests, so unchanged files stay cheap."""

        def end_headers(self):
            self.send_header("Cache-Control", "no-cache")
            super().end_headers()

    handler = functools.partial(_NoCacheHandler, directory=directory)
    httpd = HTTPServer(("", port), handler)
    threading.Thread(target=httpd.serve_forever, name="http", daemon=True).start()
    return httpd


# --------------------------------------------------------------------------- #
# the asyncio server                                                           #
# --------------------------------------------------------------------------- #
class GestureServer:
    """Async websocket server fed by threaded camera workers + the pipeline.

    Subscribers are grouped per wall; each tick the pipeline produces per-wall
    cursor lists and every subscriber gets only its wall's stream.
    """

    def __init__(self, config: RoomConfig, store: LatestPersons,
                 clock=time.monotonic):
        self.config = config
        self.store = store
        self.pipeline = Pipeline(config)
        self._clock = clock
        # wall id -> set of subscriber connections.
        self._subscribers: dict[str, set] = {w: set() for w in config.walls}
        self._start = self._clock()

    # --- subscriber lifecycle (one coroutine per connection) -------------- #
    async def handle_client(self, websocket) -> None:
        """Register a connection to its wall and keep it alive until it closes.

        The connection is otherwise passive: the broadcast loop pushes cursor
        frames. We just await close (and read any further client chatter so the
        socket's recv buffer never stalls).
        """
        try:
            hello = await websocket.recv()
        except Exception:  # noqa: BLE001 - client vanished before saying hello
            return
        try:
            wall = parse_hello(hello)
        except ValueError as e:
            await self._safe_close(websocket, str(e))
            return
        if wall not in self._subscribers:
            await self._safe_close(websocket, f"unknown wall {wall!r}")
            return

        self._subscribers[wall].add(websocket)
        try:
            # Drain anything else the client sends; we don't need it, but reading
            # keeps the connection's state machine happy and detects close.
            async for _ in websocket:
                pass
        except Exception:  # noqa: BLE001 - normal on disconnect
            pass
        finally:
            self._subscribers[wall].discard(websocket)

    @staticmethod
    async def _safe_close(websocket, reason: str) -> None:
        try:
            await websocket.close(code=1008, reason=reason[:120])
        except Exception:  # noqa: BLE001
            pass

    # --- broadcast loop --------------------------------------------------- #
    async def broadcast_tick(self) -> dict[str, list[Cursor]]:
        """Run one pipeline tick and push each wall's cursors to its clients.

        Returns the per-wall cursors produced (handy for tests/inspection).
        """
        now = self.store_time()
        # Snapshot freshness is deliberately TIGHTER than track_max_age: a
        # camera that stops producing (stall, occlusion) leaves cursor fusion
        # within ~2.5 frame periods instead of freezing the cursor at its last
        # ray for the full track lifetime — while track identity still
        # survives track_max_age so the id doesn't churn.
        # Floor at 200 ms: pose inference can run slower than the broadcast
        # fps (heavy model), and a window tighter than the camera's own
        # cadence would flicker healthy detections in and out.
        fresh = min(self.config.fusion.track_max_age,
                    max(2.5 / max(1, self.config.server.fps), 0.2))
        # Snapshot with the RAW clock: workers stamp entries with time.monotonic()
        # directly, while ``now`` above is server-relative (monotonic - start).
        # Mixing epochs made ``now - t`` hugely negative, so staleness never
        # fired and a dead camera's last Persons ghosted forever.
        persons = self.store.snapshot(self._clock(), fresh)
        cursors_by_wall = self.pipeline.step(persons, now)

        for wall, cursors in cursors_by_wall.items():
            subs = self._subscribers.get(wall)
            if not subs:
                continue
            message = cursors_message(wall, now, cursors)
            await asyncio.gather(
                *(self._send(ws, message) for ws in list(subs)),
                return_exceptions=True,
            )
        return cursors_by_wall

    def store_time(self) -> float:
        """Seconds since the server started (the pipeline's monotonic clock)."""
        return self._clock() - self._start

    @staticmethod
    async def _send(websocket, message: str) -> None:
        try:
            await websocket.send(message)
        except Exception:  # noqa: BLE001 - drop is handled by handle_client
            pass

    async def run_broadcast(self, fps: int, stop: "asyncio.Event") -> None:
        """Tick the pipeline at ``fps`` until ``stop`` is set."""
        period = 1.0 / max(1, fps)
        while not stop.is_set():
            tick_start = self._clock()
            await self.broadcast_tick()
            rest = period - (self._clock() - tick_start)
            try:
                await asyncio.wait_for(stop.wait(), timeout=max(0.0, rest))
            except asyncio.TimeoutError:
                pass


# --------------------------------------------------------------------------- #
# top-level serve() wiring it all together                                     #
# --------------------------------------------------------------------------- #
async def serve(config: RoomConfig, web_dir: str,
                source_factory=None) -> None:
    """Run the full server: camera workers + websocket + static http.

    ``source_factory(camera_id) -> source`` builds each camera's pose source;
    it defaults to the real :class:`~gesturewall.multipose.MultiPoseSource`.
    Tests inject a factory returning :class:`FakeSource`. Runs until cancelled
    (Ctrl-C).
    """
    from websockets.asyncio.server import serve as ws_serve

    if source_factory is None:
        def source_factory(camera_id, _config=config):
            return make_pose_source(_config, camera_id)

    store = LatestPersons()
    workers = [
        CameraWorker(
            camera_id=cam_id,
            source_factory=(lambda cid=cam_id: source_factory(cid)),
            store=store,
            fps=config.server.fps,
        )
        for cam_id in config.cameras
    ]
    for w in workers:
        w.start()

    httpd = start_http_server(web_dir, config.server.http_port)
    server = GestureServer(config, store)
    stop = asyncio.Event()

    print(f"[gesturewall] http  serving {web_dir!r} on "
          f"http://localhost:{config.server.http_port}")
    print(f"[gesturewall] ws    listening on "
          f"ws://localhost:{config.server.ws_port}")
    print(f"[gesturewall] walls: {', '.join(config.walls)}  "
          f"cameras: {', '.join(config.cameras)}  mode: {config.mode}")

    try:
        async with ws_serve(server.handle_client, "", config.server.ws_port):
            await server.run_broadcast(config.server.fps, stop)
    finally:
        stop.set()
        for w in workers:
            w.stop()
        httpd.shutdown()


# --------------------------------------------------------------------------- #
# CLI                                                                          #
# --------------------------------------------------------------------------- #
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="gesturewall.server",
        description="Multi-wall gesture server: cameras -> per-wall cursors "
                    "over websockets, with static hosting for the web clients.")
    p.add_argument("--config", required=True,
                   help="path to the room JSON config (see room.example.json)")
    p.add_argument("--web-dir", default="web",
                   help="directory of wall clients to serve over http "
                        "(default: web)")
    p.add_argument("--ws-port", type=int, default=None,
                   help="override server.ws_port from the config")
    p.add_argument("--http-port", type=int, default=None,
                   help="override server.http_port from the config")
    p.add_argument("--fps", type=int, default=None,
                   help="override server.fps from the config")
    p.add_argument("--num-poses", type=int, default=None,
                   help="override server.num_poses from the config")
    return p


def apply_overrides(config: RoomConfig, args) -> RoomConfig:
    """Apply CLI port/fps/num-poses overrides onto the loaded config in place."""
    if args.ws_port is not None:
        config.server.ws_port = args.ws_port
    if args.http_port is not None:
        config.server.http_port = args.http_port
    if args.fps is not None:
        config.server.fps = args.fps
    if args.num_poses is not None:
        config.server.num_poses = args.num_poses
    return config


def main(argv=None) -> None:
    args = build_parser().parse_args(argv)
    config = RoomConfig.load(args.config)
    apply_overrides(config, args)
    try:
        asyncio.run(serve(config, args.web_dir))
    except KeyboardInterrupt:
        print("\n[gesturewall] shutting down.")


if __name__ == "__main__":
    main()
