import { describe, expect, test } from "bun:test";
import { HandsClient, parseHandsFrame, type HandsFrame } from "./hands-client";

describe("parseHandsFrame", () => {
  const hand = (over: object = {}) => ({ id: 1, hand: "Left", x: 0.42, y: 0.31, pinch: 0.2143, pinching: true, conf: 0.95, ...over });
  const frame = (over: object = {}) =>
    JSON.stringify({ type: "hands", t: 123.456, aspect: 1.7778, hands: [hand(), hand({ id: 2, hand: "Right" })], ...over });

  test("parses a well-formed two-hand frame", () => {
    const parsed = parseHandsFrame(frame());
    expect(parsed?.t).toBe(123.456);
    expect(parsed?.aspect).toBe(1.7778);
    expect(parsed?.hands).toEqual([
      { id: 1, hand: "Left", x: 0.42, y: 0.31, pinch: 0.2143, pinching: true, conf: 0.95 },
      { id: 2, hand: "Right", x: 0.42, y: 0.31, pinch: 0.2143, pinching: true, conf: 0.95 },
    ]);
  });

  test("rejects wrong type, malformed JSON, and missing/non-array hands", () => {
    expect(parseHandsFrame(JSON.stringify({ type: "cursors", hands: [] }))).toBeNull();
    expect(parseHandsFrame("not json")).toBeNull();
    expect(parseHandsFrame(JSON.stringify({ type: "hands" }))).toBeNull(); // no hands array
    expect(parseHandsFrame(JSON.stringify({ type: "hands", hands: "nope" }))).toBeNull();
  });

  test("clamps coords/pinch, defaults hand/pinch/pinching/conf, drops malformed hands", () => {
    const raw = JSON.stringify({
      type: "hands",
      hands: [
        { id: 1, x: 1.5, y: -0.2, pinch: 9 }, // clamp coords + pinch, defaults for the rest
        { id: 2, y: 0.5 }, // no x -> dropped, sibling survives
        { id: 3, x: 0.5, y: 0.5, hand: "left", pinch: "bad", pinching: "yes", conf: 0.4 }, // non-literal hand, bad pinch/pinching -> null
      ],
    });
    const parsed = parseHandsFrame(raw);
    expect(parsed?.hands).toEqual([
      { id: 1, hand: null, x: 1, y: 0, pinch: 4, pinching: null, conf: 1 },
      { id: 3, hand: null, x: 0.5, y: 0.5, pinch: null, pinching: null, conf: 0.4 },
    ]);
    expect(parsed?.t).toBe(0); // missing t -> 0
    expect(parsed?.aspect).toBe(16 / 9); // missing aspect -> 16/9
  });

  test("pinch clamps at 0 from below", () => {
    const parsed = parseHandsFrame(frame({ hands: [hand({ pinch: -1 })] }));
    expect(parsed?.hands[0].pinch).toBe(0);
  });

  test("aspect defaults to 16/9 on non-number, non-finite, and non-positive values", () => {
    expect(parseHandsFrame(frame({ aspect: "wide" }))?.aspect).toBe(16 / 9);
    expect(parseHandsFrame(frame({ aspect: 0 }))?.aspect).toBe(16 / 9);
    expect(parseHandsFrame(frame({ aspect: -2 }))?.aspect).toBe(16 / 9);
    expect(parseHandsFrame(frame({ aspect: Number.POSITIVE_INFINITY }))?.aspect).toBe(16 / 9);
  });

  test("keeps only the first 2 coerced hands", () => {
    const parsed = parseHandsFrame(frame({ hands: [hand(), hand({ id: 2 }), hand({ id: 3 })] }));
    expect(parsed?.hands.map((h) => h.id)).toEqual([1, 2]);
  });

  test("wall only rejects when both sides name a wall and they differ", () => {
    expect(parseHandsFrame(frame({ wall: "B" }), "A")).toBeNull();
    expect(parseHandsFrame(frame({ wall: "A" }), "A")).not.toBeNull();
    expect(parseHandsFrame(frame({ wall: "B" }))).not.toBeNull(); // no client wall -> accepted
    expect(parseHandsFrame(frame({ wall: "B" }), null)).not.toBeNull();
    expect(parseHandsFrame(frame(), "A")).not.toBeNull(); // no frame wall -> accepted
  });
});

// Minimal WebSocket double that lets the test drive open/message/close.
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  // test drivers
  open(): void {
    this.onopen?.();
  }
  message(data: string): void {
    this.onmessage?.({ data });
  }
  drop(): void {
    this.onclose?.();
  }
}

describe("HandsClient", () => {
  test("sends the pinch hello (with wall) on open and streams parsed frames", () => {
    FakeWebSocket.instances = [];
    const framesSeen: HandsFrame[] = [];
    const statuses: string[] = [];
    const client = new HandsClient({
      url: "ws://localhost:9980",
      wall: "A",
      onFrame: (frame) => framesSeen.push(frame),
      onStatus: (s) => statuses.push(s),
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });
    client.start();
    const ws = FakeWebSocket.instances[0];
    expect(ws.url).toBe("ws://localhost:9980");
    ws.open();
    expect(JSON.parse(ws.sent[0])).toEqual({ type: "hello", client: "vibersyn-pinch", wall: "A" });
    ws.message(JSON.stringify({ type: "hands", t: 1, hands: [{ id: 1, x: 0.1, y: 0.2 }] }));
    expect(framesSeen).toHaveLength(1);
    expect(framesSeen[0].hands[0].id).toBe(1);
    // a frame for another wall is dropped
    ws.message(JSON.stringify({ type: "hands", wall: "B", t: 2, hands: [] }));
    expect(framesSeen).toHaveLength(1);
    expect(statuses).toContain("open");
    client.stop();
  });

  test("omits wall from the hello when none is configured", () => {
    FakeWebSocket.instances = [];
    const client = new HandsClient({
      url: "ws://localhost:9980",
      onFrame: () => {},
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });
    client.start();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    expect(JSON.parse(ws.sent[0])).toEqual({ type: "hello", client: "vibersyn-pinch" });
    client.stop();
  });

  test("reconnects after a drop, and stop() cancels reconnection with one terminal closed", async () => {
    FakeWebSocket.instances = [];
    const statuses: string[] = [];
    const client = new HandsClient({
      url: "ws://localhost:9980",
      onFrame: () => {},
      onStatus: (s) => statuses.push(s),
      reconnectMs: 5,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });
    client.start();
    FakeWebSocket.instances[0].drop(); // socket closed -> schedule reconnect
    await new Promise((r) => setTimeout(r, 15));
    expect(FakeWebSocket.instances.length).toBe(2); // reconnected
    client.stop();
    const afterStop = statuses.slice();
    expect(afterStop[afterStop.length - 1]).toBe("closed");
    FakeWebSocket.instances[1].drop();
    await new Promise((r) => setTimeout(r, 15));
    expect(FakeWebSocket.instances.length).toBe(2); // no reconnect after stop
    expect(statuses).toEqual(afterStop); // stop() was the single terminal "closed"
  });
});
