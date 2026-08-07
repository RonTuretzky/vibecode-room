// Browser client for the gesture-wall fusion server's per-wall cursor stream.
// Protocol (JSON text frames, from gesture-wall/gesturewall/server.py):
//   client -> server (first):  {"type":"hello","wall":"A"}
//   server -> client (tick):   {"type":"cursors","wall":"A","t":12.3,
//                               "cursors":[{"id":7,"x":0.42,"y":0.31,
//                                           "engaged":true,"conf":0.88}, ...]}
// Cursor (x,y) are normalized [0,1] over the wall and already server-side
// 1-Euro smoothed, so consumers can use them directly.

export interface GestureCursor {
  id: number;
  x: number;
  y: number;
  engaged: boolean;
  conf: number;
  // Guest display name (guest-hands relay only — the hub attaches it, already
  // sanitized, to a named guest's cursors; fusion frames never carry one).
  // The wall renders it as a small tag beside the guest's dot.
  name?: string;
}

export interface CursorsFrame {
  t: number;
  cursors: GestureCursor[];
}

// Pure parser: returns the frame for THIS wall, or null (non-cursors frame, wrong
// wall, or malformed). Never throws.
export function parseCursorsFrame(raw: string, wall: string): CursorsFrame | null {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(msg) || msg.type !== "cursors" || msg.wall !== wall || !Array.isArray(msg.cursors)) {
    return null;
  }
  const cursors: GestureCursor[] = [];
  for (const entry of msg.cursors) {
    const cursor = coerceCursor(entry);
    if (cursor !== null) {
      cursors.push(cursor);
    }
  }
  return { t: typeof msg.t === "number" ? msg.t : 0, cursors };
}

function coerceCursor(entry: unknown): GestureCursor | null {
  if (!isRecord(entry) || typeof entry.id !== "number" || typeof entry.x !== "number" || typeof entry.y !== "number") {
    return null;
  }
  return {
    id: entry.id,
    x: clamp01(entry.x),
    y: clamp01(entry.y),
    engaged: entry.engaged !== false, // default engaged unless explicitly false
    conf: typeof entry.conf === "number" ? entry.conf : 1,
    ...(typeof entry.name === "string" && entry.name.length > 0 ? { name: entry.name } : {}),
  };
}

// Remote WASD (guest-hands relay only — the fusion server never sends these):
// {"type":"keys","wall":"A","guest":0,"held":["w","d"],"t":12.3}. Same
// wall-match rule as cursors. Returns null for non-keys/malformed frames.
export interface KeysFrame {
  guest: number;
  held: string[];
}

export function parseKeysFrame(raw: string, wall: string): KeysFrame | null {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(msg) || msg.type !== "keys" || msg.wall !== wall || typeof msg.guest !== "number" || !Array.isArray(msg.held)) {
    return null;
  }
  return { guest: msg.guest, held: msg.held.filter((key): key is string => typeof key === "string") };
}

// Flat-pair pose sync (guest-hands relay only): the shared panorama pose the
// two ?flat=1 windows must agree on. NOT wall-stamped — the pose is pair-global
// by construction (both windows are halves of one frustum), so unlike cursors/
// keys there is no wall-match rule. Flows BOTH ways on the room socket: a wall
// publishes its pose after local input (see GestureWallClient.send) and adopts
// poses relayed from its partner. Returns null for non-flatpose/malformed
// frames; never throws (LAN input).
export interface FlatPoseFrame {
  yaw: number;
  height: number;
  dist: number;
  t: number;
}

export function parseFlatPoseFrame(raw: string): FlatPoseFrame | null {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !isRecord(msg) ||
    msg.type !== "flatpose" ||
    typeof msg.yaw !== "number" ||
    !Number.isFinite(msg.yaw) ||
    typeof msg.height !== "number" ||
    !Number.isFinite(msg.height) ||
    typeof msg.dist !== "number" ||
    !Number.isFinite(msg.dist)
  ) {
    return null;
  }
  return {
    yaw: msg.yaw,
    height: msg.height,
    dist: msg.dist,
    t: typeof msg.t === "number" && Number.isFinite(msg.t) ? msg.t : 0,
  };
}

export type GestureWallStatus = "connecting" | "open" | "closed";

export interface GestureWallClientOptions {
  // Fusion server WS URL, e.g. ws://localhost:8770
  url: string;
  wall: string;
  onCursors: (cursors: GestureCursor[], t: number) => void;
  // Remote WASD holds from the guest-hands relay (absent for fusion streams).
  onKeys?: (frame: KeysFrame) => void;
  // Flat-pair pose frames relayed from the partner wall window (guest-hands
  // relay only — the fusion server never sends these).
  onFlatPose?: (frame: FlatPoseFrame) => void;
  onStatus?: (status: GestureWallStatus) => void;
  reconnectMs?: number;
  // Injectable for tests / non-browser envs.
  WebSocketImpl?: typeof WebSocket;
}

// Auto-reconnecting client. Sends the wall `hello` on open and streams parsed
// cursor frames to `onCursors`. A dropped/failed socket reconnects after
// `reconnectMs`; `stop()` closes it and cancels reconnection.
export class GestureWallClient {
  readonly #url: string;
  readonly #wall: string;
  readonly #onCursors: (cursors: GestureCursor[], t: number) => void;
  readonly #onKeys?: (frame: KeysFrame) => void;
  readonly #onFlatPose?: (frame: FlatPoseFrame) => void;
  readonly #onStatus?: (status: GestureWallStatus) => void;
  readonly #reconnectMs: number;
  readonly #WebSocketImpl: typeof WebSocket;
  #ws: WebSocket | null = null;
  #open = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #stopped = false;

  constructor(options: GestureWallClientOptions) {
    this.#url = options.url;
    this.#wall = options.wall;
    this.#onCursors = options.onCursors;
    this.#onKeys = options.onKeys;
    this.#onFlatPose = options.onFlatPose;
    this.#onStatus = options.onStatus;
    this.#reconnectMs = options.reconnectMs ?? 1500;
    const impl = options.WebSocketImpl ?? (typeof WebSocket !== "undefined" ? WebSocket : undefined);
    if (impl === undefined) {
      throw new Error("No WebSocket implementation available (pass WebSocketImpl).");
    }
    this.#WebSocketImpl = impl;
  }

  start(): void {
    this.#stopped = false;
    this.#connect();
  }

  // Push one JSON frame up the live socket (the flat-pair pose publish rides
  // this). Silently dropped while connecting/reconnecting/stopped — pose sync
  // is repeat-on-input, so the next publish lands once the socket is open, and
  // the hub's replay-on-subscribe covers the window that missed one.
  send(payload: unknown): void {
    if (!this.#open || this.#ws === null) {
      return;
    }
    try {
      this.#ws.send(JSON.stringify(payload));
    } catch {
      // dying socket — its onclose will reconnect
    }
  }

  stop(): void {
    this.#stopped = true;
    this.#open = false;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (this.#ws !== null) {
      // Detach handlers first so the socket's own async onclose can't fire a
      // second "closed" status — stop() is the single source of the terminal state.
      const ws = this.#ws;
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      try {
        ws.close();
      } catch {
        // already closing
      }
      this.#ws = null;
    }
    this.#onStatus?.("closed");
  }

  #connect(): void {
    if (this.#stopped) {
      return;
    }
    this.#onStatus?.("connecting");
    let ws: WebSocket;
    try {
      ws = new this.#WebSocketImpl(this.#url);
    } catch {
      this.#scheduleReconnect();
      return;
    }
    this.#ws = ws;
    this.#open = false;
    ws.onopen = () => {
      this.#open = true;
      this.#onStatus?.("open");
      try {
        ws.send(JSON.stringify({ type: "hello", wall: this.#wall }));
      } catch {
        // send failure -> the socket will error/close and reconnect
      }
    };
    ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") {
        return;
      }
      const frame = parseCursorsFrame(event.data, this.#wall);
      if (frame !== null) {
        this.#onCursors(frame.cursors, frame.t);
        return;
      }
      if (this.#onKeys !== undefined) {
        const keys = parseKeysFrame(event.data, this.#wall);
        if (keys !== null) {
          this.#onKeys(keys);
          return;
        }
      }
      if (this.#onFlatPose !== undefined) {
        const pose = parseFlatPoseFrame(event.data);
        if (pose !== null) {
          this.#onFlatPose(pose);
        }
      }
    };
    ws.onerror = () => {
      // onclose follows; reconnect is handled there.
    };
    ws.onclose = () => {
      this.#ws = null;
      this.#open = false;
      this.#onStatus?.("closed");
      this.#scheduleReconnect();
    };
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#timer !== null) {
      return;
    }
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#connect();
    }, this.#reconnectMs);
    (this.#timer as { unref?: () => void }).unref?.();
  }
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
