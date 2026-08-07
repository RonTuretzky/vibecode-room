// Guest-hands relay hub: LAN guests open /hands on their own computer, track
// their hands in-browser (or use the trackpad fallback), and stream normalized
// cursors here over WS (/hands/ws). The hub assigns each guest an exclusive
// cursor-id block and relays frames to every subscribed wall window
// (/api/hands/room) speaking the EXACT gesture-wall fusion protocol
// ({"type":"cursors","wall":…}) — so the wall consumes guests through the same
// GestureWallClient + dwell pipeline it already runs for camera cursors.
//
// Pure by design: no sockets, no timers — peers are (send, close) callbacks and
// the clock is injectable, so the whole hub is unit-testable with fake peers.
//
// Wall routing: each wall window subscribes with a {"type":"hello","wall":"A"}
// (GestureWallClient's existing handshake) and each guest picks a wall the same
// way (defaulting to the first subscribed wall). A guest's CURSOR frames go
// ONLY to matching-wall subscribers — both wall windows render the same full
// room, so mirroring one guest onto both would double-fire every dwell. Key
// HOLDS are the exception: they broadcast to every window (see #relayKeys).

import { GUEST_ID_STRIDE, guestCursorId } from "../ui/gesture/remote";
import { Point2DFilter } from "../ui/gesture/core";
import { networkInterfaces } from "node:os";
import { preferredLanIPv4, type InterfaceAddresses } from "./project-import";

// A guest frame is tiny (≤2 cursors); anything bigger than this is not ours.
export const MAX_GUEST_MESSAGE_CHARS = 8_192;
// numHands=2 everywhere upstream — a guest has at most two hands on camera.
export const MAX_CURSORS_PER_FRAME = 2;

export interface RemoteGuestCursor {
  id: number; // guest-local hand id, 0..GUEST_ID_STRIDE-1
  x: number; // normalized [0,1]
  y: number; // normalized [0,1]
  engaged: boolean;
}

// The wall-camera keys a guest may hold remotely (the wall's own WASD
// fly-through — W/S walk, A/D strafe). A closed set: anything else is dropped.
export const GUEST_KEYS = ["w", "a", "s", "d"] as const;
export type GuestKey = (typeof GUEST_KEYS)[number];

// Flat-pair pose sync bounds. The scene's own envelopes are yaw unbounded,
// height [1.4,30], dist [6,45] — these are slightly WIDER so a legitimate
// edge-of-envelope pose survives the relay bit-exact-ish while anything wild
// (or a float that walked off) still comes back to sanity. Yaw is clamped too:
// it is unbounded locally, but an unbounded relay would let one bad frame
// spin the pair forever.
export const FLAT_POSE_YAW_LIMIT = 50; // rad
export const FLAT_POSE_HEIGHT_MIN = 1;
export const FLAT_POSE_HEIGHT_MAX = 31;
export const FLAT_POSE_DIST_MIN = 5;
export const FLAT_POSE_DIST_MAX = 46;

export type GuestMessage =
  | { kind: "hello"; wall: string | null }
  | { kind: "cursors"; cursors: RemoteGuestCursor[] }
  | { kind: "keys"; held: GuestKey[] }
  | { kind: "flatpose"; yaw: number; height: number; dist: number };

// Pure parser for guest → hub frames. Returns null for anything malformed —
// unauthenticated LAN input never throws, it just gets dropped.
export function parseGuestMessage(raw: string): GuestMessage | null {
  if (raw.length > MAX_GUEST_MESSAGE_CHARS) {
    return null;
  }
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(msg)) {
    return null;
  }
  if (msg.type === "hello") {
    const wall = typeof msg.wall === "string" && msg.wall.trim().length > 0 ? msg.wall.trim() : null;
    return { kind: "hello", wall };
  }
  if (msg.type === "keys") {
    if (!Array.isArray(msg.held)) {
      return null;
    }
    const held: GuestKey[] = [];
    for (const key of msg.held) {
      if ((GUEST_KEYS as readonly string[]).includes(key as string) && !held.includes(key as GuestKey)) {
        held.push(key as GuestKey);
      }
    }
    return { kind: "keys", held };
  }
  if (msg.type === "flatpose") {
    // The flat pair's shared panorama pose (sent by WALL windows on the room
    // socket — see RemoteHandsHub.addRoom). Finite-or-drop, then clamped into
    // the sane envelope: unauthenticated LAN input never throws AND never
    // relays a pose that could fling the pair.
    if (!isFiniteNumber(msg.yaw) || !isFiniteNumber(msg.height) || !isFiniteNumber(msg.dist)) {
      return null;
    }
    return {
      kind: "flatpose",
      yaw: clampRange(msg.yaw, -FLAT_POSE_YAW_LIMIT, FLAT_POSE_YAW_LIMIT),
      height: clampRange(msg.height, FLAT_POSE_HEIGHT_MIN, FLAT_POSE_HEIGHT_MAX),
      dist: clampRange(msg.dist, FLAT_POSE_DIST_MIN, FLAT_POSE_DIST_MAX),
    };
  }
  if (msg.type !== "cursors" || !Array.isArray(msg.cursors)) {
    return null;
  }
  const cursors: RemoteGuestCursor[] = [];
  for (const entry of msg.cursors) {
    if (cursors.length === MAX_CURSORS_PER_FRAME) {
      break;
    }
    const cursor = coerceGuestCursor(entry);
    if (cursor !== null && !cursors.some((existing) => existing.id === cursor.id)) {
      cursors.push(cursor);
    }
  }
  return { kind: "cursors", cursors };
}

function coerceGuestCursor(entry: unknown): RemoteGuestCursor | null {
  if (
    !isRecord(entry) ||
    typeof entry.id !== "number" ||
    !Number.isInteger(entry.id) ||
    entry.id < 0 ||
    entry.id >= GUEST_ID_STRIDE ||
    typeof entry.x !== "number" ||
    !Number.isFinite(entry.x) ||
    typeof entry.y !== "number" ||
    !Number.isFinite(entry.y)
  ) {
    return null;
  }
  return {
    id: entry.id,
    x: clamp01(entry.x),
    y: clamp01(entry.y),
    engaged: entry.engaged === true,
  };
}

// A connected peer as the hub sees it: just a way to push text frames.
export type PeerSend = (raw: string) => void;

export interface HubConnection {
  // Feed an incoming text frame from this peer's socket.
  message(raw: string): void;
  // The peer's socket closed — release everything it held.
  close(): void;
}

interface RoomPeer {
  send: PeerSend;
  wall: string | null; // set by the GestureWallClient hello
}

// Guest-cursor One Euro tuning: mincutoff low enough to kill hand tremor on a
// still cursor, beta high enough that deliberate sweeps stay responsive —
// the same tradeoff the Kinect path ships (gesturewall server.py CursorSmoother).
const GUEST_SMOOTH_MINCUTOFF = 1.0;
const GUEST_SMOOTH_BETA = 0.02;

interface GuestPeer {
  send: PeerSend;
  seq: number;
  wall: string | null; // chosen by the guest page; null = follow the room
  // The last frame relayed for this guest — replayed DISENGAGED on disconnect
  // so a dwell in progress cancels immediately instead of ghost-firing during
  // the wall's 0.5s stale-cursor grace window.
  lastCursors: RemoteGuestCursor[];
  // The wall-camera keys this guest currently holds (WASD buttons on the guest
  // page) — released explicitly on disconnect so the camera never keeps walking.
  lastHeld: GuestKey[];
  // Per-hand One Euro smoothing (same filter family as the Kinect cursor path
  // — gesturewall's CursorSmoother): the guest page ships raw palm centroids,
  // and unsmoothed cursors shiver at wall scale, resetting dwell on small
  // targets. Keyed by the guest-local hand id; dropped when the hand vanishes
  // so a re-appearing hand starts fresh instead of gliding from stale state.
  filters: Map<number, Point2DFilter>;
}

export interface RemoteHandsHubOptions {
  // Seconds clock stamped onto relayed frames (consumers run their own clocks;
  // the stamp only needs to be monotonic-ish). Injectable for tests.
  now?: () => number;
}

// The relayed shape of a flat-pair pose (see #relayFlatPose).
interface FlatPoseWire {
  type: "flatpose";
  yaw: number;
  height: number;
  dist: number;
  t: number;
}

export class RemoteHandsHub {
  readonly #now: () => number;
  readonly #rooms = new Set<RoomPeer>();
  readonly #guests = new Set<GuestPeer>();
  #nextSeq = 0;
  // The last flat-pair pose any wall published (hub-global — the flat rig has
  // exactly one shared pose). Replayed to every freshly subscribing wall so a
  // refreshed window snaps to its partner's pose immediately instead of
  // waiting for the partner's next input.
  #lastFlatPose: FlatPoseWire | null = null;

  constructor(options: RemoteHandsHubOptions = {}) {
    this.#now = options.now ?? (() => performance.now() / 1000);
  }

  guestCount(): number {
    return this.#guests.size;
  }

  // Distinct walls currently subscribed, sorted — what the guest page's wall
  // picker offers, and what /api/hands/info reports.
  walls(): string[] {
    const walls = new Set<string>();
    for (const room of this.#rooms) {
      if (room.wall !== null) {
        walls.add(room.wall);
      }
    }
    return [...walls].sort();
  }

  // A wall window subscribed (WS /api/hands/room). It speaks GestureWallClient's
  // protocol: a {"type":"hello","wall":…} first, then it listens — and under
  // the flat lock it may also publish {"type":"flatpose",…} pose frames, which
  // relay to every OTHER wall window (see #relayFlatPose).
  addRoom(send: PeerSend): HubConnection {
    const peer: RoomPeer = { send, wall: null };
    this.#rooms.add(peer);
    return {
      message: (raw: string) => {
        const parsed = parseGuestMessage(raw);
        if (parsed?.kind === "hello") {
          peer.wall = parsed.wall;
          this.#broadcastWallsToGuests();
          // Replay the pair's last shared pose to the fresh subscriber so a
          // refreshed window snaps into lockstep without waiting for the
          // partner's next input. Harmless elsewhere: non-flat windows never
          // register a flatpose consumer, so the frame just drops client-side.
          if (this.#lastFlatPose !== null) {
            safeSend(peer.send, this.#lastFlatPose);
          }
          return;
        }
        if (parsed?.kind === "flatpose") {
          this.#relayFlatPose(peer, parsed);
        }
      },
      close: () => {
        if (this.#rooms.delete(peer)) {
          this.#broadcastWallsToGuests();
        }
      },
    };
  }

  // Flat-pair pose sync: one wall window published its shared-panorama pose —
  // store it (for replay-on-subscribe) and relay it to every OTHER wall
  // window. Never back to the sender (its pose is already right, and echoes
  // would fight the very input that produced them) and never to guests (the
  // pose is projector-rig internals, not a guest-facing stream).
  #relayFlatPose(sender: RoomPeer, pose: { yaw: number; height: number; dist: number }): void {
    const frame: FlatPoseWire = {
      type: "flatpose",
      yaw: pose.yaw,
      height: pose.height,
      dist: pose.dist,
      t: this.#now(),
    };
    this.#lastFlatPose = frame;
    for (const room of this.#rooms) {
      if (room !== sender) {
        safeSend(room.send, frame);
      }
    }
  }

  // A guest connected (WS /hands/ws from their own computer).
  addGuest(send: PeerSend): HubConnection {
    const peer: GuestPeer = { send, seq: this.#nextSeq, wall: null, lastCursors: [], lastHeld: [], filters: new Map() };
    this.#nextSeq += 1;
    this.#guests.add(peer);
    this.#sendWelcome(peer);
    return {
      message: (raw: string) => {
        const parsed = parseGuestMessage(raw);
        if (parsed === null) {
          return;
        }
        if (parsed.kind === "hello") {
          peer.wall = parsed.wall;
          this.#sendWelcome(peer);
          return;
        }
        if (parsed.kind === "keys") {
          this.#relayKeys(peer, parsed.held);
          return;
        }
        if (parsed.kind === "flatpose") {
          // Only wall windows (addRoom) may steer the flat pair's shared
          // pose — a guest-sent flatpose is dropped, not relayed.
          return;
        }
        this.#relay(peer, parsed.cursors);
      },
      close: () => {
        if (!this.#guests.delete(peer)) {
          return;
        }
        // The socket dropping is a DEFINITIVE "this guest is gone" (unlike a
        // camera losing a hand): disengage their cursors on the wall now so a
        // dwell in flight cancels instead of completing during the eviction
        // grace window, and release any held camera keys so the wall never
        // keeps walking. The stale-cursor eviction then clears the dots.
        if (peer.lastCursors.length > 0) {
          this.#relay(peer, peer.lastCursors.map((cursor) => ({ ...cursor, engaged: false })));
        }
        if (peer.lastHeld.length > 0) {
          this.#relayKeys(peer, []);
        }
      },
    };
  }

  // Welcome tells the page its assigned global cursor ids (so it can show the
  // guest "your dot is this color" via the shared idToHue math), the wall its
  // frames currently route to, and which walls exist to pick from.
  #sendWelcome(peer: GuestPeer): void {
    safeSend(peer.send, {
      type: "welcome",
      ids: [guestCursorId(peer.seq, 0), guestCursorId(peer.seq, 1)],
      wall: this.#resolveWall(peer),
      walls: this.walls(),
    });
  }

  // Wall subscriptions changed — keep every guest's picker (and "no wall is
  // listening" banner) live without polling.
  #broadcastWallsToGuests(): void {
    const walls = this.walls();
    for (const guest of this.#guests) {
      safeSend(guest.send, { type: "walls", walls });
    }
  }

  // A guest with no explicit wall follows the room: first subscribed wall wins
  // (the single-window desk case has exactly one). An explicit pick only holds
  // while that wall is actually subscribed — when it vanishes (window closed,
  // stale localStorage on the guest), frames FOLLOW a live wall instead of
  // silently controlling nothing. "A" only as a last resort before any wall
  // subscribes.
  #resolveWall(peer: GuestPeer): string {
    const walls = this.walls();
    if (peer.wall !== null && walls.includes(peer.wall)) {
      return peer.wall;
    }
    return walls[0] ?? peer.wall ?? "A";
  }

  #relay(peer: GuestPeer, cursors: RemoteGuestCursor[]): void {
    peer.lastCursors = cursors;
    const wall = this.#resolveWall(peer);
    const t = this.#now();
    // Smooth here, not on the page: one fix covers every guest device, and the
    // filter sees real arrival times (heartbeats re-send identical positions,
    // which a One Euro simply converges on). Filters for hands absent from
    // this frame are dropped so a re-tracked hand starts clean.
    for (const key of peer.filters.keys()) {
      if (!cursors.some((cursor) => cursor.id === key)) {
        peer.filters.delete(key);
      }
    }
    const frame = {
      type: "cursors" as const,
      wall,
      t,
      cursors: cursors.map((cursor) => {
        let filter = peer.filters.get(cursor.id);
        if (filter === undefined) {
          filter = new Point2DFilter(30, GUEST_SMOOTH_MINCUTOFF, GUEST_SMOOTH_BETA);
          peer.filters.set(cursor.id, filter);
        }
        const [x, y] = filter.call(cursor.x, cursor.y, t);
        return {
          id: guestCursorId(peer.seq, cursor.id),
          x,
          y,
          engaged: cursor.engaged,
          conf: 1,
        };
      }),
    };
    for (const room of this.#rooms) {
      if (room.wall === wall) {
        safeSend(room.send, frame);
      }
    }
  }

  // Remote WASD: relay a guest's held camera keys to EVERY subscribed window,
  // tagged with the guest seq so each wall can merge holds across guests and
  // time out a silent one. UNLIKE cursors (wall-routed — mirroring a guest's
  // dot onto both windows would double-fire every dwell), key HOLDS must reach
  // every window: the flat pair shares ONE camera rig that only stays in
  // lockstep if both windows integrate the identical hold timeline, and on the
  // desk rig each window owns an independent camera, so both of them walking
  // is acceptable — expected, even. Each frame is stamped with the RECEIVING
  // room's wall because the wall client's parser drops frames stamped for
  // another wall.
  #relayKeys(peer: GuestPeer, held: GuestKey[]): void {
    peer.lastHeld = held;
    const t = this.#now();
    for (const room of this.#rooms) {
      if (room.wall === null) {
        continue; // not helloed yet — its client has no wall to match on
      }
      safeSend(room.send, { type: "keys" as const, wall: room.wall, guest: peer.seq, held, t });
    }
  }
}

// A peer whose socket is mid-close can throw on send; the hub never lets one
// dying peer take the relay loop down.
function safeSend(send: PeerSend, payload: unknown): void {
  try {
    send(JSON.stringify(payload));
  } catch {
    // Dropped frame to a dying peer — its close() will clean up.
  }
}

// ── /api/hands/info — where guests must point their browsers ────────────────
export interface HandsInfo {
  // The plain-http guest URL (trackpad always works there; camera hand-tracking
  // needs a secure context, i.e. httpsUrl or localhost).
  url: string;
  // The TLS listener's guest URL when bound (self-signed — browsers warn once),
  // null when the TLS listener is off. Camera access requires this off-host.
  httpsUrl: string | null;
  host: string;
  lanReachable: boolean;
  guestCount: number;
  walls: string[];
}

// Mirrors resolveImportInfo's listener topology (dedicated 0.0.0.0 LAN listener
// preferred; else derive reachability from the main bind) with the /hands path.
export function resolveHandsInfo(options: {
  host: string;
  port: number;
  phonePort?: number | null;
  tlsPort?: number | null;
  interfaces?: () => InterfaceAddresses;
  guestCount: number;
  walls: string[];
}): HandsInfo {
  const interfaces = options.interfaces ?? networkInterfaces;
  const phonePort = options.phonePort ?? null;
  const tlsPort = options.tlsPort ?? null;
  const lan = preferredLanIPv4(interfaces);

  let host: string;
  let port: number;
  let lanReachable: boolean;
  if (phonePort !== null) {
    host = lan ?? "127.0.0.1";
    port = phonePort;
    lanReachable = lan !== null;
  } else if (options.host === "127.0.0.1" || options.host === "localhost" || options.host === "::1") {
    host = "127.0.0.1";
    port = options.port;
    lanReachable = false;
  } else {
    const wildcard = options.host === "0.0.0.0" || options.host === "::";
    const resolved = wildcard ? lan : options.host;
    host = resolved ?? "127.0.0.1";
    port = options.port;
    lanReachable = resolved !== null;
  }

  return {
    url: `http://${host}:${port}/hands`,
    httpsUrl: tlsPort !== null ? `https://${host}:${tlsPort}/hands` : null,
    host,
    lanReachable,
    guestCount: options.guestCount,
    walls: options.walls,
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampRange(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
