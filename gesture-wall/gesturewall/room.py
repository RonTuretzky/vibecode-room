"""Room configuration: walls, cameras, calibration, fusion and server settings.

A multi-wall gesture room is described by a single JSON file (see
``room.example.json``). It declares:

  * **walls** - each projected wall, its display index and its zone grid.
  * **adjacency** - which walls are physically side-by-side, with a seam margin
    used by the fusion engine's hand-off hysteresis.
  * **cameras** - each webcam, its device index, the walls it *serves*, and an
    optional 3x3 ``room_homography`` mapping that camera's image into the shared
    room/floor frame (null when the camera isn't floor-calibrated).
  * **calibration** - one ``"<cam>-><wall>"`` entry per (camera, wall) pair,
    each a 3x3 perspective matrix mapping that camera's image onto that wall.
  * **fusion** / **server** - tuning knobs for the cross-camera fuser and the
    websocket/http server.

This module is pure configuration: it parses and *validates* the JSON, then
hands out :class:`~gesturewall.calibration.Homography` objects so the rest of
the pipeline never touches raw matrices. It has no camera/cv2/mediapipe
dependency and is fully unit-testable headless.

A camera **serves** a wall ``W`` iff ``W`` is in ``camera.serves`` *and* a
calibration entry ``"<cam>->W"`` exists. A camera need not serve every wall:
e.g. ``cam0`` may serve only wall ``A`` even though wall ``B`` exists.

Depth mode (3D ray pointing)
----------------------------
A second, optional mode replaces the location-locked 2D homography mapping with
a depth-ray that is invariant to where a person stands. Walls may carry a 3D
``plane`` (a :class:`~gesturewall.geometry.WallPlane`), and cameras may carry
``intrinsics`` (:class:`~gesturewall.geometry.CameraIntrinsics`) plus an
``extrinsic`` (:class:`~gesturewall.geometry.Extrinsic`, CAMERA->ROOM). All of
these fields are **optional** and default to ``None`` so existing
homography-mode configs (and ``room.example.json``) stay valid unchanged.

Depth cameras declare a ``kind`` from :data:`DEPTH_KINDS` — ``"kinect_v2"``
(Kinect v2 via the libfreenect2 bridge) or ``"gemini_335"``/``"orbbec"``
(an Orbbec Gemini 335); plain webcams are ``"rgb"`` (the default). The kind
picks the frame source via :func:`gesturewall.framesource.make_frame_source`.

The :attr:`RoomConfig.mode` property is ``"depth"`` iff *every* camera that
serves a wall has both intrinsics and an extrinsic **and** every served wall has
a plane; otherwise it is ``"homography"``. In depth mode :meth:`serves` no
longer needs a ``"<cam>-><wall>"`` homography — a camera serves a wall when the
wall is listed in ``serves`` and the camera+wall carry the depth geometry. The
``calibration`` homography block may therefore be empty/absent in depth mode.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

from .calibration import Homography
from .geometry import CameraIntrinsics, Extrinsic, WallPlane

Matrix = list[list[float]]

# Camera kinds that produce pixel-aligned color+depth frames (the 3D-ray
# path); anything else is the plain 2D webcam path ("rgb"). Frame sources for
# these kinds are built by gesturewall.framesource.make_frame_source, so a new
# depth camera means: add its kind here and teach that one factory about it.
DEPTH_KINDS = {"kinect_v2", "gemini_335", "orbbec"}


# --------------------------------------------------------------------------- #
# dataclasses                                                                  #
# --------------------------------------------------------------------------- #
@dataclass
class WallCfg:
    """One projected wall: its display index and zone grid dimensions.

    ``plane`` is an optional 3D :class:`~gesturewall.geometry.WallPlane`
    (depth mode); ``None`` for pure homography-mode walls.
    """

    display: int
    rows: int
    cols: int
    plane: WallPlane | None = None


@dataclass
class CameraCfg:
    """One camera: capture device, the walls it serves, optional room map.

    Depth-mode cameras additionally carry ``kind`` (one of :data:`DEPTH_KINDS`;
    plain webcams are ``"rgb"``), pinhole ``intrinsics`` and a CAMERA->ROOM
    ``extrinsic``. All default so homography-mode cameras are unchanged.
    """

    # int = enumeration index; str = a stable serial (Kinect v2: 12 digits,
    # e.g. "072843433747"; Orbbec: alphanumeric, e.g. "CP0E8530002Y").
    device: int | str
    serves: list[str]
    room_homography: Matrix | None = None
    kind: str = "rgb"
    intrinsics: CameraIntrinsics | None = None
    extrinsic: Extrinsic | None = None


@dataclass
class Adjacency:
    """A physical seam between two side-by-side walls."""

    left: str
    right: str
    seam_margin: float = 0.06


@dataclass
class FusionCfg:
    """Cross-camera fusion tuning.

    ``cross_camera=False`` declares the cameras' room frames UNREGISTERED
    (each camera's extrinsic is identity in its own frame — the decoupled
    per-camera-per-wall architecture). Tracking then never merges or matches
    observations across cameras, since inter-frame distances are meaningless.
    """

    mode: str = "highest_confidence"
    merge_radius: float = 0.35
    track_max_age: float = 0.5
    cross_camera: bool = True


@dataclass
class ServerCfg:
    """Websocket/http server + capture tuning."""

    ws_port: int = 8770
    http_port: int = 8000
    fps: int = 30
    num_poses: int = 4
    mirror: bool = True
    min_confidence: float = 0.5
    model: str = "models/pose_landmarker_lite.task"
    # Depth-mode pointing model: how the ray origin is chosen (direction is always
    # toward the wrist). 'eye_hand' | 'forearm' | 'shoulder_hand'.
    pointing: str = "eye_hand"


@dataclass
class RoomConfig:
    """The parsed, validated room description."""

    walls: dict[str, WallCfg]
    adjacency: list[Adjacency]
    cameras: dict[str, CameraCfg]
    calibration: dict[str, Matrix]
    fusion: FusionCfg = field(default_factory=FusionCfg)
    server: ServerCfg = field(default_factory=ServerCfg)

    # --- loading / parsing ------------------------------------------------ #
    @classmethod
    def load(cls, path: str | Path) -> "RoomConfig":
        """Parse and validate a room JSON file.

        Raises :class:`ValueError` with a clear message on any structural or
        semantic problem.
        """
        try:
            data = json.loads(Path(path).read_text())
        except FileNotFoundError as e:
            raise ValueError(f"room config not found: {path}") from e
        except json.JSONDecodeError as e:
            raise ValueError(f"room config is not valid JSON: {e}") from e
        return cls.from_dict(data)

    @classmethod
    def from_dict(cls, data: dict) -> "RoomConfig":
        if not isinstance(data, dict):
            raise ValueError("room config must be a JSON object")

        walls = _parse_walls(data.get("walls"))
        cameras = _parse_cameras(data.get("cameras"))
        adjacency = _parse_adjacency(data.get("adjacency", []))
        calibration = _parse_calibration(data.get("calibration", {}))
        fusion = _parse_fusion(data.get("fusion", {}))
        server = _parse_server(data.get("server", {}))

        cfg = cls(
            walls=walls,
            adjacency=adjacency,
            cameras=cameras,
            calibration=calibration,
            fusion=fusion,
            server=server,
        )
        cfg._validate()
        return cfg

    # --- validation ------------------------------------------------------- #
    def _validate(self) -> None:
        if not self.walls:
            raise ValueError("room config must declare at least one wall")
        if not self.cameras:
            raise ValueError("room config must declare at least one camera")

        wall_ids = set(self.walls)

        # Every calibration key "<cam>-><wall>" must reference a known camera
        # and a known wall (no dangling references).
        for key in self.calibration:
            cam_id, wall_id = _split_calib_key(key)
            if cam_id not in self.cameras:
                raise ValueError(
                    f"calibration key {key!r} references unknown camera "
                    f"{cam_id!r}")
            if wall_id not in wall_ids:
                raise ValueError(
                    f"calibration key {key!r} references unknown wall "
                    f"{wall_id!r}")

        # Every wall a camera lists in `serves` must exist, and must be backed
        # by a mapping: either a homography calibration entry (homography mode)
        # OR depth geometry (camera intrinsics+extrinsic AND wall plane).
        for cam_id, cam in self.cameras.items():
            for wall_id in cam.serves:
                if wall_id not in wall_ids:
                    raise ValueError(
                        f"camera {cam_id!r} serves unknown wall {wall_id!r}")
                key = _calib_key(cam_id, wall_id)
                has_homography = key in self.calibration
                has_depth = (
                    cam.intrinsics is not None
                    and cam.extrinsic is not None
                    and self.walls[wall_id].plane is not None)
                if not has_homography and not has_depth:
                    raise ValueError(
                        f"camera {cam_id!r} serves wall {wall_id!r} but has no "
                        f"calibration entry {key!r} (homography mode) and no "
                        f"depth geometry (camera intrinsics+extrinsic + wall "
                        f"plane)")

        # Adjacency walls must exist; seam_margin in [0, 0.5).
        for adj in self.adjacency:
            for side in (adj.left, adj.right):
                if side not in wall_ids:
                    raise ValueError(
                        f"adjacency references unknown wall {side!r}")
            if not (0.0 <= adj.seam_margin < 0.5):
                raise ValueError(
                    f"adjacency {adj.left!r}->{adj.right!r} seam_margin must be "
                    f"in [0, 0.5), got {adj.seam_margin}")

        # Fusion / server sanity.
        if self.fusion.merge_radius <= 0:
            raise ValueError("fusion.merge_radius must be > 0")
        if self.fusion.track_max_age <= 0:
            raise ValueError("fusion.track_max_age must be > 0")
        if not self.fusion.cross_camera:
            # Unregistered per-camera frames: a wall's plane lives in exactly
            # one camera's frame, so a second server for the same wall would
            # intersect rays with a plane from an alien frame — garbage.
            for wall_id in wall_ids:
                servers = [cid for cid, cam in self.cameras.items()
                           if wall_id in cam.serves]
                if len(servers) > 1:
                    raise ValueError(
                        f"fusion.cross_camera is false (unregistered frames) "
                        f"but wall {wall_id!r} is served by {servers}; each "
                        f"wall must have exactly one serving camera")
        if self.server.ws_port <= 0 or self.server.http_port <= 0:
            raise ValueError("server ports must be positive")
        if self.server.fps <= 0:
            raise ValueError("server.fps must be > 0")
        if self.server.num_poses < 1:
            raise ValueError("server.num_poses must be >= 1")
        if not (0.0 <= self.server.min_confidence <= 1.0):
            raise ValueError("server.min_confidence must be in [0, 1]")

    # --- mode ------------------------------------------------------------- #
    @property
    def mode(self) -> str:
        """``"depth"`` if every served (cam, wall) carries full depth geometry.

        Specifically: every camera that serves at least one wall has both
        intrinsics and an extrinsic, AND every wall that is served by some
        camera has a plane. Otherwise ``"homography"`` (the default 2D path).
        """
        served_walls: set[str] = set()
        serving_cams: list[CameraCfg] = []
        for cam in self.cameras.values():
            if cam.serves:
                serving_cams.append(cam)
                served_walls.update(cam.serves)
        if not serving_cams or not served_walls:
            return "homography"
        for cam in serving_cams:
            if cam.intrinsics is None or cam.extrinsic is None:
                return "homography"
        for wall_id in served_walls:
            if self.walls[wall_id].plane is None:
                return "homography"
        return "depth"

    # --- accessors -------------------------------------------------------- #
    def serves(self, camera_id: str, wall_id: str) -> bool:
        """True iff `camera_id` serves `wall_id`.

        Mode-aware: in homography mode the wall must be listed in ``serves``
        *and* a ``"<cam>-><wall>"`` calibration entry must exist; in depth mode
        the wall must be listed *and* the camera must carry intrinsics+extrinsic
        *and* the wall must carry a plane (no cam->wall homography needed).
        """
        cam = self.cameras.get(camera_id)
        if cam is None or wall_id not in cam.serves:
            return False
        if self.mode == "depth":
            return (cam.intrinsics is not None
                    and cam.extrinsic is not None
                    and self.walls[wall_id].plane is not None)
        return _calib_key(camera_id, wall_id) in self.calibration

    def cam_to_wall(self, camera_id: str, wall_id: str) -> Homography:
        """Return the homography mapping `camera_id`'s image onto `wall_id`.

        Raises :class:`KeyError` if no ``"<cam>-><wall>"`` calibration exists.
        """
        key = _calib_key(camera_id, wall_id)
        try:
            matrix = self.calibration[key]
        except KeyError as e:
            raise KeyError(
                f"no calibration for {camera_id!r} -> {wall_id!r} "
                f"(expected key {key!r})") from e
        return Homography(matrix=[[float(v) for v in row] for row in matrix])

    def room_homography(self, camera_id: str) -> Homography | None:
        """Return `camera_id`'s room/floor homography, or None if unset.

        Raises :class:`KeyError` if the camera itself is unknown.
        """
        cam = self.cameras[camera_id]
        if cam.room_homography is None:
            return None
        return Homography(
            matrix=[[float(v) for v in row] for row in cam.room_homography])

    # --- depth-mode accessors -------------------------------------------- #
    def wall_plane(self, wall_id: str) -> WallPlane:
        """Return `wall_id`'s 3D :class:`WallPlane`.

        Raises :class:`KeyError` if the wall is unknown, :class:`ValueError`
        if the wall has no plane configured.
        """
        wall = self.walls[wall_id]
        if wall.plane is None:
            raise ValueError(f"wall {wall_id!r} has no 3D plane configured")
        return wall.plane

    def intrinsics(self, camera_id: str) -> CameraIntrinsics:
        """Return `camera_id`'s :class:`CameraIntrinsics`.

        Raises :class:`KeyError` if the camera is unknown, :class:`ValueError`
        if the camera has no intrinsics configured.
        """
        cam = self.cameras[camera_id]
        if cam.intrinsics is None:
            raise ValueError(f"camera {camera_id!r} has no intrinsics configured")
        return cam.intrinsics

    def extrinsic(self, camera_id: str) -> Extrinsic:
        """Return `camera_id`'s CAMERA->ROOM :class:`Extrinsic`.

        Raises :class:`KeyError` if the camera is unknown, :class:`ValueError`
        if the camera has no extrinsic configured.
        """
        cam = self.cameras[camera_id]
        if cam.extrinsic is None:
            raise ValueError(f"camera {camera_id!r} has no extrinsic configured")
        return cam.extrinsic


# --------------------------------------------------------------------------- #
# calibration-key helpers                                                      #
# --------------------------------------------------------------------------- #
_CALIB_SEP = "->"


def _calib_key(camera_id: str, wall_id: str) -> str:
    return f"{camera_id}{_CALIB_SEP}{wall_id}"


def _split_calib_key(key: str) -> tuple[str, str]:
    if _CALIB_SEP not in key:
        raise ValueError(
            f"calibration key {key!r} must look like \"<cam>->{'<wall>'}\"")
    cam_id, wall_id = key.split(_CALIB_SEP, 1)
    if not cam_id or not wall_id:
        raise ValueError(
            f"calibration key {key!r} must look like \"<cam>->{'<wall>'}\"")
    return cam_id, wall_id


# --------------------------------------------------------------------------- #
# section parsers (raise ValueError on malformed input)                        #
# --------------------------------------------------------------------------- #
def _require(cond: bool, msg: str) -> None:
    if not cond:
        raise ValueError(msg)


def _as_int(value: object, what: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{what} must be an integer, got {value!r}")
    return value


def _as_number(value: object, what: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{what} must be a number, got {value!r}")
    return float(value)


def _as_bool(value: object, what: str) -> bool:
    if not isinstance(value, bool):
        raise ValueError(f"{what} must be a boolean, got {value!r}")
    return value


def _validate_matrix(value: object, what: str) -> Matrix:
    _require(isinstance(value, list) and len(value) == 3,
             f"{what} must be a 3x3 list of lists")
    matrix: Matrix = []
    for row in value:
        _require(isinstance(row, list) and len(row) == 3,
                 f"{what} must be a 3x3 list of lists")
        matrix.append([_as_number(v, f"{what} entry") for v in row])
    return matrix


# --- depth-mode field parsers (all optional; validate shapes when present) -- #
def _vec3(value: object, what: str) -> tuple[float, float, float]:
    _require(isinstance(value, list) and len(value) == 3,
             f"{what} must be a list of 3 numbers")
    nums = [_as_number(v, f"{what} entry") for v in value]
    return (nums[0], nums[1], nums[2])


def _parse_plane(raw: object, what: str) -> WallPlane | None:
    if raw is None:
        return None
    _require(isinstance(raw, dict),
             f"{what} must be an object with \"origin\", \"u_vec\", \"v_vec\"")
    for k in ("origin", "u_vec", "v_vec"):
        _require(k in raw, f"{what} must have a \"{k}\" 3-vector")
    return WallPlane(
        origin=_vec3(raw["origin"], f"{what} origin"),
        u_vec=_vec3(raw["u_vec"], f"{what} u_vec"),
        v_vec=_vec3(raw["v_vec"], f"{what} v_vec"),
    )


def _parse_intrinsics(raw: object, what: str) -> CameraIntrinsics | None:
    if raw is None:
        return None
    _require(isinstance(raw, dict),
             f"{what} must be an object with fx, fy, cx, cy, width, height")
    for k in ("fx", "fy", "cx", "cy", "width", "height"):
        _require(k in raw, f"{what} must have \"{k}\"")
    return CameraIntrinsics(
        fx=_as_number(raw["fx"], f"{what} fx"),
        fy=_as_number(raw["fy"], f"{what} fy"),
        cx=_as_number(raw["cx"], f"{what} cx"),
        cy=_as_number(raw["cy"], f"{what} cy"),
        width=_as_int(raw["width"], f"{what} width"),
        height=_as_int(raw["height"], f"{what} height"),
    )


def _validate_matrix4(value: object, what: str) -> list[list[float]]:
    _require(isinstance(value, list) and len(value) == 4,
             f"{what} must be a 4x4 list of lists")
    matrix: list[list[float]] = []
    for row in value:
        _require(isinstance(row, list) and len(row) == 4,
                 f"{what} must be a 4x4 list of lists")
        matrix.append([_as_number(v, f"{what} entry") for v in row])
    return matrix


def _parse_extrinsic(raw: object, what: str) -> Extrinsic | None:
    if raw is None:
        return None
    _require(isinstance(raw, dict),
             f"{what} must be an object with \"matrix\" (4x4) or \"R\"+\"t\"")
    if "matrix" in raw:
        return Extrinsic(matrix=_validate_matrix4(raw["matrix"], f"{what} matrix"))
    if "R" in raw and "t" in raw:
        R = _validate_matrix(raw["R"], f"{what} R")
        t = _vec3(raw["t"], f"{what} t")
        return Extrinsic.from_rt(R, list(t))
    raise ValueError(
        f"{what} must provide either a 4x4 \"matrix\" or both \"R\" (3x3) "
        f"and \"t\" (3-vector)")


def _parse_walls(raw: object) -> dict[str, WallCfg]:
    _require(isinstance(raw, dict) and len(raw) > 0,
             "\"walls\" must be a non-empty object")
    walls: dict[str, WallCfg] = {}
    for wall_id, wraw in raw.items():
        _require(isinstance(wraw, dict), f"wall {wall_id!r} must be an object")
        display = _as_int(wraw.get("display"), f"wall {wall_id!r} display")
        grid = wraw.get("grid")
        _require(isinstance(grid, dict),
                 f"wall {wall_id!r} must have a \"grid\" object")
        rows = _as_int(grid.get("rows"), f"wall {wall_id!r} grid.rows")
        cols = _as_int(grid.get("cols"), f"wall {wall_id!r} grid.cols")
        _require(rows >= 1 and cols >= 1,
                 f"wall {wall_id!r} grid rows/cols must be >= 1")
        plane = _parse_plane(wraw.get("plane"), f"wall {wall_id!r} plane")
        walls[wall_id] = WallCfg(
            display=display, rows=rows, cols=cols, plane=plane)
    return walls


def _parse_cameras(raw: object) -> dict[str, CameraCfg]:
    _require(isinstance(raw, dict) and len(raw) > 0,
             "\"cameras\" must be a non-empty object")
    cameras: dict[str, CameraCfg] = {}
    for cam_id, craw in raw.items():
        _require(isinstance(craw, dict),
                 f"camera {cam_id!r} must be an object")
        raw_device = craw.get("device")
        if isinstance(raw_device, str):
            _require(len(raw_device) > 0,
                     f"camera {cam_id!r} device serial must be a non-empty string")
            device = raw_device  # stable device serial (index-independent)
        else:
            device = _as_int(raw_device, f"camera {cam_id!r} device")
        serves = craw.get("serves", [])
        _require(isinstance(serves, list)
                 and all(isinstance(s, str) for s in serves),
                 f"camera {cam_id!r} \"serves\" must be a list of wall ids")
        rh = craw.get("room_homography")
        room_homography = None if rh is None else _validate_matrix(
            rh, f"camera {cam_id!r} room_homography")
        kind = craw.get("kind", "rgb")
        _require(isinstance(kind, str),
                 f"camera {cam_id!r} \"kind\" must be a string")
        _require(kind in {"rgb"} | DEPTH_KINDS,
                 f"camera {cam_id!r} kind {kind!r} is not supported: use "
                 f"\"rgb\" (2D webcam) or one of {sorted(DEPTH_KINDS)} "
                 f"(depth cameras)")
        intrinsics = _parse_intrinsics(
            craw.get("intrinsics"), f"camera {cam_id!r} intrinsics")
        extrinsic = _parse_extrinsic(
            craw.get("extrinsic"), f"camera {cam_id!r} extrinsic")
        cameras[cam_id] = CameraCfg(
            device=device, serves=list(serves),
            room_homography=room_homography,
            kind=kind, intrinsics=intrinsics, extrinsic=extrinsic)
    return cameras


def _parse_adjacency(raw: object) -> list[Adjacency]:
    _require(isinstance(raw, list), "\"adjacency\" must be a list")
    out: list[Adjacency] = []
    for araw in raw:
        _require(isinstance(araw, dict), "each adjacency must be an object")
        left = araw.get("left")
        right = araw.get("right")
        _require(isinstance(left, str) and isinstance(right, str),
                 "adjacency must have string \"left\" and \"right\" wall ids")
        seam_margin = _as_number(
            araw.get("seam_margin", 0.06), "adjacency seam_margin")
        out.append(Adjacency(left=left, right=right, seam_margin=seam_margin))
    return out


def _parse_calibration(raw: object) -> dict[str, Matrix]:
    _require(isinstance(raw, dict),
             "\"calibration\" must be an object of \"<cam>-><wall>\" entries")
    calibration: dict[str, Matrix] = {}
    for key, entry in raw.items():
        _split_calib_key(key)  # shape check on the key itself
        _require(isinstance(entry, dict) and "matrix" in entry,
                 f"calibration {key!r} must be an object with a \"matrix\"")
        calibration[key] = _validate_matrix(
            entry["matrix"], f"calibration {key!r} matrix")
    return calibration


def _parse_fusion(raw: object) -> FusionCfg:
    _require(isinstance(raw, dict), "\"fusion\" must be an object")
    defaults = FusionCfg()
    mode = raw.get("mode", defaults.mode)
    _require(isinstance(mode, str), "fusion.mode must be a string")
    cross_camera = raw.get("cross_camera", defaults.cross_camera)
    _require(isinstance(cross_camera, bool),
             "fusion.cross_camera must be a boolean")
    return FusionCfg(
        mode=mode,
        merge_radius=_as_number(
            raw.get("merge_radius", defaults.merge_radius),
            "fusion.merge_radius"),
        track_max_age=_as_number(
            raw.get("track_max_age", defaults.track_max_age),
            "fusion.track_max_age"),
        cross_camera=cross_camera,
    )


def _parse_server(raw: object) -> ServerCfg:
    _require(isinstance(raw, dict), "\"server\" must be an object")
    d = ServerCfg()
    return ServerCfg(
        ws_port=_as_int(raw.get("ws_port", d.ws_port), "server.ws_port"),
        http_port=_as_int(raw.get("http_port", d.http_port),
                          "server.http_port"),
        fps=_as_int(raw.get("fps", d.fps), "server.fps"),
        num_poses=_as_int(raw.get("num_poses", d.num_poses),
                          "server.num_poses"),
        mirror=_as_bool(raw.get("mirror", d.mirror), "server.mirror"),
        min_confidence=_as_number(
            raw.get("min_confidence", d.min_confidence),
            "server.min_confidence"),
        model=_check_model(raw.get("model", d.model)),
        pointing=_check_pointing(raw.get("pointing", d.pointing)),
    )


_POINTING_MODELS = ("eye_hand", "forearm", "shoulder_hand")


def _check_pointing(value: object) -> str:
    _require(value in _POINTING_MODELS,
             f"server.pointing must be one of {_POINTING_MODELS}, got {value!r}")
    return str(value)


def _check_model(value: object) -> str:
    _require(isinstance(value, str), "server.model must be a string path")
    return value
