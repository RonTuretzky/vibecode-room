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
  };
}

export type GestureWallStatus = "connecting" | "open" | "closed";

export interface GestureWallClientOptions {
  // Fusion server WS URL, e.g. ws://localhost:8770
  url: string;
  wall: string;
  onCursors: (cursors: GestureCursor[], t: number) => void;
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
  readonly #onStatus?: (status: GestureWallStatus) => void;
  readonly #reconnectMs: number;
  readonly #WebSocketImpl: typeof WebSocket;
  #ws: WebSocket | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #stopped = false;

  constructor(options: GestureWallClientOptions) {
    this.#url = options.url;
    this.#wall = options.wall;
    this.#onCursors = options.onCursors;
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

  stop(): void {
    this.#stopped = true;
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
    ws.onopen = () => {
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
      }
    };
    ws.onerror = () => {
      // onclose follows; reconnect is handled there.
    };
    ws.onclose = () => {
      this.#ws = null;
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
