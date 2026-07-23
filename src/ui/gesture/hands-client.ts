// Browser client for the TouchDesigner hand-pinch stream (gesture-wall/touchdesigner/hands_stream.py).
// Protocol (JSON text frames, server = TD Web Server DAT on :9980):
//   client -> server (first):  {"type":"hello","client":"vibersyn-pinch","wall":"A"}  // wall omitted when unset
//   server -> client (tick):   {"type":"hands","t":123.456,"aspect":1.7778,
//                               "hands":[{"id":1,"hand":"Left","x":0.42,"y":0.31,
//                                         "pinch":0.2143,"pinching":true,"conf":0.95}, ...]}
// (x,y) are normalized [0,1], y DOWN (raw MediaPipe screen convention; x mirrored
// TD-side). `pinch` is the continuous thumb-index ratio the browser's hysteresis
// runs on; `pinching` is TD's latched bool, FALLBACK only. An empty hands array
// IS sent every tick (liveness contract); staleness runs on the browser clock.

export interface PinchHand {
  id: number;
  hand: "Left" | "Right" | null;
  x: number;
  y: number;
  pinch: number | null;
  pinching: boolean | null;
  conf: number;
  // Optional compact 21-point skeleton ([x,y] in the same mirrored [0,1] space),
  // when the bridge emits it — for the in-room debug HUD. Absent for the
  // TouchDesigner stream / older bridges; consumers must tolerate its absence.
  lm?: ReadonlyArray<readonly [number, number]>;
}

export interface HandsFrame {
  t: number;
  aspect: number;
  hands: PinchHand[];
}

// Pure parser: returns the frame, or null (non-hands frame, wall mismatch, or
// malformed). Never throws. A frame `wall` only rejects when BOTH sides name a
// wall and they differ — absent on either side = accepted.
export function parseHandsFrame(raw: string, wall?: string | null): HandsFrame | null {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(msg) || msg.type !== "hands" || !Array.isArray(msg.hands)) {
    return null;
  }
  if (typeof msg.wall === "string" && typeof wall === "string" && wall !== "" && msg.wall !== wall) {
    return null;
  }
  const hands: PinchHand[] = [];
  for (const entry of msg.hands) {
    const hand = coerceHand(entry);
    if (hand !== null) {
      hands.push(hand);
      if (hands.length === 2) {
        break; // numHands=2 upstream makes 3+ unreachable; defensively ignore extras
      }
    }
  }
  return {
    t: typeof msg.t === "number" ? msg.t : 0,
    aspect: typeof msg.aspect === "number" && Number.isFinite(msg.aspect) && msg.aspect > 0 ? msg.aspect : 16 / 9,
    hands,
  };
}

function coerceHand(entry: unknown): PinchHand | null {
  if (!isRecord(entry) || typeof entry.id !== "number" || typeof entry.x !== "number" || typeof entry.y !== "number") {
    return null;
  }
  const lm = coerceLandmarks(entry.lm);
  return {
    id: entry.id,
    hand: entry.hand === "Left" || entry.hand === "Right" ? entry.hand : null,
    x: clamp01(entry.x),
    y: clamp01(entry.y),
    pinch: typeof entry.pinch === "number" ? Math.max(0, Math.min(4, entry.pinch)) : null,
    pinching: typeof entry.pinching === "boolean" ? entry.pinching : null,
    conf: typeof entry.conf === "number" ? entry.conf : 1,
    // Only present when the bridge sent a valid skeleton — keeps frames without
    // it byte-identical to the old shape (existing consumers/tests unaffected).
    ...(lm !== null ? { lm } : {}),
  };
}

// Accept a 21-point [[x,y],...] skeleton, else null. Tolerant: any malformed
// point voids the whole skeleton (the HUD just shows dots-less until valid).
function coerceLandmarks(value: unknown): ReadonlyArray<readonly [number, number]> | null {
  if (!Array.isArray(value) || value.length !== 21) {
    return null;
  }
  const pts: Array<readonly [number, number]> = [];
  for (const p of value) {
    if (!Array.isArray(p) || p.length < 2 || typeof p[0] !== "number" || typeof p[1] !== "number") {
      return null;
    }
    pts.push([clamp01(p[0]), clamp01(p[1])]);
  }
  return pts;
}

export type HandsStatus = "connecting" | "open" | "closed";

export interface HandsClientOptions {
  // TouchDesigner Web Server DAT WS URL, e.g. ws://localhost:9980
  url: string;
  wall?: string | null;
  onFrame: (frame: HandsFrame) => void;
  onStatus?: (s: HandsStatus) => void;
  reconnectMs?: number;
  // Injectable for tests / non-browser envs.
  WebSocketImpl?: typeof WebSocket;
}

// Auto-reconnecting client. Sends the pinch `hello` on open and streams parsed
// hands frames to `onFrame`. A dropped/failed socket reconnects after
// `reconnectMs`; `stop()` closes it and cancels reconnection.
export class HandsClient {
  readonly #url: string;
  readonly #wall: string | null;
  readonly #onFrame: (frame: HandsFrame) => void;
  readonly #onStatus?: (s: HandsStatus) => void;
  readonly #reconnectMs: number;
  readonly #WebSocketImpl: typeof WebSocket;
  #ws: WebSocket | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #stopped = false;

  constructor(options: HandsClientOptions) {
    this.#url = options.url;
    this.#wall = options.wall ?? null;
    this.#onFrame = options.onFrame;
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
        // Informational hello (TD logs/ignores it); wall included only when set
        // so a future fusion server can route per-wall.
        ws.send(JSON.stringify({ type: "hello", client: "vibersyn-pinch", ...(this.#wall ? { wall: this.#wall } : {}) }));
      } catch {
        // send failure -> the socket will error/close and reconnect
      }
    };
    ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") {
        return;
      }
      const frame = parseHandsFrame(event.data, this.#wall);
      if (frame !== null) {
        this.#onFrame(frame);
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
