import { describe, expect, test } from "bun:test";
import { GestureWallClient, parseCursorsFrame, type GestureCursor } from "./wall-client";

describe("parseCursorsFrame", () => {
  const frame = (over: object = {}) =>
    JSON.stringify({ type: "cursors", wall: "A", t: 12.3, cursors: [{ id: 7, x: 0.42, y: 0.31, engaged: true, conf: 0.88 }], ...over });

  test("parses a well-formed cursors frame for the subscribed wall", () => {
    const parsed = parseCursorsFrame(frame(), "A");
    expect(parsed?.t).toBe(12.3);
    expect(parsed?.cursors).toEqual([{ id: 7, x: 0.42, y: 0.31, engaged: true, conf: 0.88 }]);
  });

  test("rejects wrong wall, wrong type, and malformed JSON", () => {
    expect(parseCursorsFrame(frame(), "B")).toBeNull();
    expect(parseCursorsFrame(JSON.stringify({ type: "hello", wall: "A" }), "A")).toBeNull();
    expect(parseCursorsFrame("not json", "A")).toBeNull();
    expect(parseCursorsFrame(JSON.stringify({ type: "cursors", wall: "A" }), "A")).toBeNull(); // no cursors array
  });

  test("clamps coords, defaults engaged/conf, drops malformed cursors", () => {
    const raw = JSON.stringify({
      type: "cursors",
      wall: "A",
      cursors: [
        { id: 1, x: 1.5, y: -0.2 }, // clamp + defaults
        { id: 2, x: 0.5, y: 0.5, engaged: false, conf: 0.1 },
        { x: 0.5, y: 0.5 }, // no id -> dropped
        { id: 3, x: "bad", y: 0.5 }, // bad x -> dropped
      ],
    });
    const parsed = parseCursorsFrame(raw, "A");
    expect(parsed?.cursors).toEqual([
      { id: 1, x: 1, y: 0, engaged: true, conf: 1 },
      { id: 2, x: 0.5, y: 0.5, engaged: false, conf: 0.1 },
    ]);
    expect(parsed?.t).toBe(0); // missing t -> 0
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

describe("GestureWallClient", () => {
  test("sends the wall hello on open and streams parsed cursors", () => {
    FakeWebSocket.instances = [];
    const cursorsSeen: GestureCursor[][] = [];
    const statuses: string[] = [];
    const client = new GestureWallClient({
      url: "ws://localhost:8770",
      wall: "A",
      onCursors: (cursors) => cursorsSeen.push(cursors),
      onStatus: (s) => statuses.push(s),
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });
    client.start();
    const ws = FakeWebSocket.instances[0];
    expect(ws.url).toBe("ws://localhost:8770");
    ws.open();
    expect(JSON.parse(ws.sent[0])).toEqual({ type: "hello", wall: "A" });
    ws.message(JSON.stringify({ type: "cursors", wall: "A", t: 1, cursors: [{ id: 5, x: 0.1, y: 0.2 }] }));
    expect(cursorsSeen).toHaveLength(1);
    expect(cursorsSeen[0][0].id).toBe(5);
    // a frame for another wall is ignored
    ws.message(JSON.stringify({ type: "cursors", wall: "B", t: 2, cursors: [{ id: 9, x: 0, y: 0 }] }));
    expect(cursorsSeen).toHaveLength(1);
    expect(statuses).toContain("open");
    client.stop();
  });

  test("reconnects after a drop, and stop() cancels reconnection", async () => {
    FakeWebSocket.instances = [];
    const client = new GestureWallClient({
      url: "ws://localhost:8770",
      wall: "A",
      onCursors: () => {},
      reconnectMs: 5,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });
    client.start();
    FakeWebSocket.instances[0].drop(); // socket closed -> schedule reconnect
    await new Promise((r) => setTimeout(r, 15));
    expect(FakeWebSocket.instances.length).toBe(2); // reconnected
    client.stop();
    FakeWebSocket.instances[1].drop();
    await new Promise((r) => setTimeout(r, 15));
    expect(FakeWebSocket.instances.length).toBe(2); // no reconnect after stop
  });
});
