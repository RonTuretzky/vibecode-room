import { describe, expect, test } from "bun:test";
import { GUEST_ID_BASE, GUEST_ID_STRIDE } from "../ui/gesture/remote";
import {
  FLAT_POSE_DIST_MAX,
  FLAT_POSE_DIST_MIN,
  FLAT_POSE_HEIGHT_MAX,
  FLAT_POSE_HEIGHT_MIN,
  FLAT_POSE_YAW_LIMIT,
  MAX_GUEST_MESSAGE_CHARS,
  MAX_GUEST_NAME_CHARS,
  RemoteHandsHub,
  parseGuestMessage,
  resolveHandsInfo,
  sanitizeGuestName,
} from "./remote-hands";
import type { InterfaceAddresses } from "./project-import";

// ── parseGuestMessage ────────────────────────────────────────────────────────

describe("sanitizeGuestName", () => {
  test("trims, caps at MAX_GUEST_NAME_CHARS, and strips control chars", () => {
    expect(sanitizeGuestName("  Zoë  ")).toBe("Zoë");
    expect(sanitizeGuestName("a".repeat(MAX_GUEST_NAME_CHARS + 10))).toBe("a".repeat(MAX_GUEST_NAME_CHARS));
    // Control chars go BEFORE the cap so they can't eat visible budget, and a
    // cap that lands on trailing whitespace re-trims.
    expect(sanitizeGuestName("Ro\u0000n\u001b \u007f")).toBe("Ron");
    expect(sanitizeGuestName("evil\nname")).toBe("evilname");
  });

  test("empty and non-string inputs are 'no name' (null)", () => {
    expect(sanitizeGuestName("")).toBeNull();
    expect(sanitizeGuestName("   ")).toBeNull();
    expect(sanitizeGuestName("\u0000\u001f")).toBeNull(); // control-only
    expect(sanitizeGuestName(undefined)).toBeNull();
    expect(sanitizeGuestName(42)).toBeNull();
    expect(sanitizeGuestName({ name: "x" })).toBeNull();
  });
});

describe("parseGuestMessage", () => {
  test("parses a hello with and without a wall", () => {
    expect(parseGuestMessage(JSON.stringify({ type: "hello", wall: "B" }))).toEqual({ kind: "hello", wall: "B", name: null });
    expect(parseGuestMessage(JSON.stringify({ type: "hello" }))).toEqual({ kind: "hello", wall: null, name: null });
    expect(parseGuestMessage(JSON.stringify({ type: "hello", wall: "  " }))).toEqual({ kind: "hello", wall: null, name: null });
  });

  test("a hello carries a sanitized optional display name", () => {
    expect(parseGuestMessage(JSON.stringify({ type: "hello", wall: "A", name: "  Zoë  " }))).toEqual({
      kind: "hello",
      wall: "A",
      name: "Zoë",
    });
    // Over-long and control-char-laden names come back wall-safe.
    expect(parseGuestMessage(JSON.stringify({ type: "hello", name: "x".repeat(99) }))).toEqual({
      kind: "hello",
      wall: null,
      name: "x".repeat(MAX_GUEST_NAME_CHARS),
    });
    // Junk name values never sink the hello itself.
    expect(parseGuestMessage(JSON.stringify({ type: "hello", wall: "A", name: 7 }))).toEqual({
      kind: "hello",
      wall: "A",
      name: null,
    });
    expect(parseGuestMessage(JSON.stringify({ type: "hello", name: "   " }))).toEqual({
      kind: "hello",
      wall: null,
      name: null,
    });
  });

  test("parses cursors, clamping coordinates and coercing engagement", () => {
    const msg = parseGuestMessage(
      JSON.stringify({ type: "cursors", cursors: [{ id: 0, x: 1.7, y: -0.2, engaged: true }, { id: 1, x: 0.5, y: 0.5 }] }),
    );
    expect(msg).toEqual({
      kind: "cursors",
      cursors: [
        { id: 0, x: 1, y: 0, engaged: true },
        { id: 1, x: 0.5, y: 0.5, engaged: false },
      ],
    });
  });

  test("drops malformed input without throwing", () => {
    expect(parseGuestMessage("not json")).toBeNull();
    expect(parseGuestMessage(JSON.stringify({ type: "cursors" }))).toBeNull();
    expect(parseGuestMessage(JSON.stringify({ type: "other", cursors: [] }))).toBeNull();
    expect(parseGuestMessage(JSON.stringify([1, 2, 3]))).toBeNull();
    expect(parseGuestMessage("x".repeat(MAX_GUEST_MESSAGE_CHARS + 1))).toBeNull();
  });

  test("rejects cursors with non-finite coords or out-of-block local ids", () => {
    const msg = parseGuestMessage(
      JSON.stringify({
        type: "cursors",
        cursors: [
          { id: 0, x: Number.NaN, y: 0.5 },
          { id: GUEST_ID_STRIDE, x: 0.5, y: 0.5 }, // outside the guest's block
          { id: -1, x: 0.5, y: 0.5 },
          { id: 1.5, x: 0.5, y: 0.5 },
          { id: 1, x: 0.4, y: 0.6, engaged: true },
        ],
      }),
    );
    expect(msg).toEqual({ kind: "cursors", cursors: [{ id: 1, x: 0.4, y: 0.6, engaged: true }] });
  });

  test("parses a flatpose, passing sane values through and clamping wild ones", () => {
    expect(parseGuestMessage(JSON.stringify({ type: "flatpose", yaw: -0.4, height: 4.6, dist: 20, t: 3 }))).toEqual({
      kind: "flatpose",
      yaw: -0.4,
      height: 4.6,
      dist: 20,
    });
    // Out-of-envelope values come back to sanity instead of flinging the pair.
    expect(parseGuestMessage(JSON.stringify({ type: "flatpose", yaw: 1e6, height: -3, dist: 9000 }))).toEqual({
      kind: "flatpose",
      yaw: FLAT_POSE_YAW_LIMIT,
      height: FLAT_POSE_HEIGHT_MIN,
      dist: FLAT_POSE_DIST_MAX,
    });
    expect(parseGuestMessage(JSON.stringify({ type: "flatpose", yaw: -1e6, height: 99, dist: 0 }))).toEqual({
      kind: "flatpose",
      yaw: -FLAT_POSE_YAW_LIMIT,
      height: FLAT_POSE_HEIGHT_MAX,
      dist: FLAT_POSE_DIST_MIN,
    });
  });

  test("drops a flatpose with missing or non-finite fields", () => {
    expect(parseGuestMessage(JSON.stringify({ type: "flatpose", yaw: 0, height: 4.6 }))).toBeNull(); // no dist
    expect(parseGuestMessage(JSON.stringify({ type: "flatpose", yaw: "0", height: 4.6, dist: 20 }))).toBeNull();
    expect(parseGuestMessage(JSON.stringify({ type: "flatpose", yaw: null, height: 4.6, dist: 20 }))).toBeNull();
    // NaN/Infinity survive JSON.parse only as null/strings, but a hand-rolled
    // parser upstream could still hand them over — guard at the coercion.
    expect(parseGuestMessage('{"type":"flatpose","yaw":1e999,"height":4.6,"dist":20}')).toBeNull(); // Infinity
  });

  test("caps a frame at two cursors and dedupes repeated local ids", () => {
    const msg = parseGuestMessage(
      JSON.stringify({
        type: "cursors",
        cursors: [
          { id: 0, x: 0.1, y: 0.1 },
          { id: 0, x: 0.9, y: 0.9 }, // duplicate id — first wins
          { id: 1, x: 0.2, y: 0.2 },
          { id: 2, x: 0.3, y: 0.3 }, // beyond the two-hand cap
        ],
      }),
    );
    expect(msg?.kind).toBe("cursors");
    if (msg?.kind === "cursors") {
      expect(msg.cursors.map((c) => c.id)).toEqual([0, 1]);
      expect(msg.cursors[0].x).toBeCloseTo(0.1);
    }
  });
});

// ── RemoteHandsHub ───────────────────────────────────────────────────────────

interface FakePeer {
  sent: unknown[];
  send: (raw: string) => void;
}

function fakePeer(): FakePeer {
  const peer: FakePeer = {
    sent: [],
    send: (raw: string) => {
      peer.sent.push(JSON.parse(raw));
    },
  };
  return peer;
}

function makeHub(): RemoteHandsHub {
  let tick = 0;
  return new RemoteHandsHub({ now: () => (tick += 1) });
}

const hello = (wall?: string) => JSON.stringify({ type: "hello", ...(wall !== undefined ? { wall } : {}) });
const cursorsFrame = (cursors: unknown[]) => JSON.stringify({ type: "cursors", cursors });
const keysFramesOf = (peer: FakePeer) =>
  peer.sent.filter((m) => (m as { type: string }).type === "keys") as Array<{
    wall: string;
    guest: number;
    held: string[];
  }>;
const flatPose = (yaw: number, height: number, dist: number) => JSON.stringify({ type: "flatpose", yaw, height, dist, t: 0.5 });
const flatPosesOf = (peer: FakePeer) =>
  peer.sent.filter((m) => (m as { type: string }).type === "flatpose") as Array<{
    type: string;
    yaw: number;
    height: number;
    dist: number;
    t: number;
  }>;

describe("RemoteHandsHub", () => {
  test("welcomes a guest with its reserved global ids and the known walls", () => {
    const hub = makeHub();
    const room = fakePeer();
    hub.addRoom(room.send).message(hello("A"));

    const guest = fakePeer();
    hub.addGuest(guest.send);
    expect(guest.sent).toEqual([
      { type: "welcome", ids: [GUEST_ID_BASE, GUEST_ID_BASE - 1], wall: "A", walls: ["A"] },
    ]);
  });

  test("relays guest frames to matching-wall rooms in the fusion cursors protocol", () => {
    const hub = makeHub();
    const roomA = fakePeer();
    const roomB = fakePeer();
    hub.addRoom(roomA.send).message(hello("A"));
    hub.addRoom(roomB.send).message(hello("B"));

    const guest = fakePeer();
    const conn = hub.addGuest(guest.send);
    conn.message(cursorsFrame([{ id: 0, x: 0.25, y: 0.75, engaged: true }]));

    expect(roomA.sent).toHaveLength(1);
    const frame = roomA.sent[0] as { type: string; wall: string; t: number; cursors: unknown[] };
    expect(frame.type).toBe("cursors");
    expect(frame.wall).toBe("A"); // no explicit wall → first subscribed wall
    expect(frame.cursors).toEqual([{ id: GUEST_ID_BASE, x: 0.25, y: 0.75, engaged: true, conf: 1 }]);
    // Wall B never sees wall-A frames — both windows render the full room, so
    // mirroring one guest onto both would double-fire every dwell.
    expect(roomB.sent.filter((m) => (m as { type: string }).type === "cursors")).toHaveLength(0);
  });

  test("a named guest's relayed cursors carry the sanitized name; nameless hellos clear it", () => {
    const hub = makeHub();
    const room = fakePeer();
    hub.addRoom(room.send).message(hello("A"));

    const conn = hub.addGuest(fakePeer().send);
    const lastCursor = () => {
      const frames = room.sent.filter((m) => (m as { type: string }).type === "cursors") as Array<{
        cursors: Array<Record<string, unknown>>;
      }>;
      return frames[frames.length - 1].cursors[0];
    };

    // Anonymous guest: the wire shape is exactly the pre-names protocol — no
    // name key at all (not name:null), so old consumers see identical frames.
    conn.message(cursorsFrame([{ id: 0, x: 0.25, y: 0.75, engaged: true }]));
    expect(lastCursor()).toEqual({ id: GUEST_ID_BASE, x: 0.25, y: 0.75, engaged: true, conf: 1 });

    // A fresh hello with a name (how the page announces an edit): every
    // subsequent cursor carries it, sanitized by the hub.
    conn.message(JSON.stringify({ type: "hello", wall: "A", name: "  Zoë   " }));
    conn.message(cursorsFrame([{ id: 0, x: 0.25, y: 0.75, engaged: true }]));
    expect(lastCursor()).toEqual({ id: GUEST_ID_BASE, x: 0.25, y: 0.75, engaged: true, conf: 1, name: "Zoë" });

    // Clearing the field on the page sends a nameless hello: the tag comes off.
    conn.message(JSON.stringify({ type: "hello", wall: "A" }));
    conn.message(cursorsFrame([{ id: 0, x: 0.25, y: 0.75, engaged: false }]));
    expect(lastCursor()).toEqual({ id: GUEST_ID_BASE, x: 0.25, y: 0.75, engaged: false, conf: 1 });
  });

  test("each named guest tags only its OWN cursors", () => {
    const hub = makeHub();
    const room = fakePeer();
    hub.addRoom(room.send).message(hello("A"));

    const named = hub.addGuest(fakePeer().send);
    named.message(JSON.stringify({ type: "hello", name: "Ada" }));
    const anonymous = hub.addGuest(fakePeer().send);

    named.message(cursorsFrame([{ id: 0, x: 0.1, y: 0.1, engaged: true }]));
    anonymous.message(cursorsFrame([{ id: 0, x: 0.9, y: 0.9, engaged: true }]));

    const frames = room.sent.filter((m) => (m as { type: string }).type === "cursors") as Array<{
      cursors: Array<Record<string, unknown>>;
    }>;
    expect(frames[0].cursors[0]).toMatchObject({ id: GUEST_ID_BASE, name: "Ada" });
    expect(frames[1].cursors[0]).toEqual({ id: GUEST_ID_BASE - GUEST_ID_STRIDE, x: 0.9, y: 0.9, engaged: true, conf: 1 });
  });

  test("guest cursors are One-Euro smoothed in the relay: jitter attenuates, resets on hand loss", () => {
    // 30 Hz clock so the filter sees realistic frame spacing.
    let tick = 0;
    const hub = new RemoteHandsHub({ now: () => (tick += 1 / 30) });
    const room = fakePeer();
    hub.addRoom(room.send).message(hello("A"));
    const conn = hub.addGuest(fakePeer().send);

    const relayedX = () => {
      const frame = room.sent[room.sent.length - 1] as { cursors: Array<{ x: number }> };
      return frame.cursors[0].x;
    };
    // First sample passes through exactly (filter seeds on it).
    conn.message(cursorsFrame([{ id: 0, x: 0.5, y: 0.5, engaged: false }]));
    expect(relayedX()).toBe(0.5);
    // Settle, then a single-frame jitter spike: the relayed cursor must move
    // well under the raw spike (this shiver is what resets dwell on the wall).
    for (let i = 0; i < 5; i += 1) {
      conn.message(cursorsFrame([{ id: 0, x: 0.5, y: 0.5, engaged: false }]));
    }
    conn.message(cursorsFrame([{ id: 0, x: 0.56, y: 0.5, engaged: false }]));
    expect(relayedX()).toBeGreaterThan(0.5);
    expect(relayedX()).toBeLessThan(0.53);
    // Hand vanishes for a frame → its filter drops; the re-tracked hand seeds
    // fresh at its new position instead of gliding from stale state.
    conn.message(cursorsFrame([]));
    conn.message(cursorsFrame([{ id: 0, x: 0.9, y: 0.1, engaged: false }]));
    expect(relayedX()).toBe(0.9);
  });

  test("a guest hello with a wall routes its frames to that wall", () => {
    const hub = makeHub();
    const roomA = fakePeer();
    const roomB = fakePeer();
    hub.addRoom(roomA.send).message(hello("A"));
    hub.addRoom(roomB.send).message(hello("B"));

    const guest = fakePeer();
    const conn = hub.addGuest(guest.send);
    conn.message(hello("B"));
    conn.message(cursorsFrame([{ id: 1, x: 0.5, y: 0.5, engaged: false }]));

    expect(roomB.sent.filter((m) => (m as { type: string }).type === "cursors")).toHaveLength(1);
    expect(roomA.sent.filter((m) => (m as { type: string }).type === "cursors")).toHaveLength(0);
  });

  test("a guest whose chosen wall vanished follows a live wall instead of controlling nothing", () => {
    const hub = makeHub();
    const roomA = fakePeer();
    const roomB = fakePeer();
    hub.addRoom(roomA.send).message(hello("A"));
    const roomBConn = hub.addRoom(roomB.send);
    roomBConn.message(hello("B"));

    const conn = hub.addGuest(fakePeer().send);
    conn.message(hello("B"));
    roomBConn.close(); // wall B window went away

    conn.message(cursorsFrame([{ id: 0, x: 0.5, y: 0.5, engaged: true }]));
    expect(roomA.sent.filter((m) => (m as { type: string }).type === "cursors")).toHaveLength(1);

    // Wall B comes back: the explicit pick applies again.
    const roomB2 = fakePeer();
    hub.addRoom(roomB2.send).message(hello("B"));
    conn.message(cursorsFrame([{ id: 0, x: 0.6, y: 0.6, engaged: true }]));
    expect(roomB2.sent.filter((m) => (m as { type: string }).type === "cursors")).toHaveLength(1);
    expect(roomA.sent.filter((m) => (m as { type: string }).type === "cursors")).toHaveLength(1);
  });

  test("each guest gets its own id block", () => {
    const hub = makeHub();
    const room = fakePeer();
    hub.addRoom(room.send).message(hello("A"));

    const first = hub.addGuest(fakePeer().send);
    const second = hub.addGuest(fakePeer().send);
    first.message(cursorsFrame([{ id: 0, x: 0.1, y: 0.1, engaged: true }]));
    second.message(cursorsFrame([{ id: 0, x: 0.9, y: 0.9, engaged: true }]));

    const ids = room.sent.map((m) => (m as { cursors: { id: number }[] }).cursors[0].id);
    expect(ids).toEqual([GUEST_ID_BASE, GUEST_ID_BASE - GUEST_ID_STRIDE]);
  });

  test("a guest disconnect DISENGAGES its last cursors so a dwell in flight cancels", () => {
    const hub = makeHub();
    const room = fakePeer();
    hub.addRoom(room.send).message(hello("A"));

    const conn = hub.addGuest(fakePeer().send);
    conn.message(cursorsFrame([{ id: 0, x: 0.4, y: 0.6, engaged: true }]));
    conn.close();

    const frames = room.sent.filter((m) => (m as { type: string }).type === "cursors") as Array<{
      cursors: { id: number; x: number; y: number; engaged: boolean; conf: number }[];
    }>;
    expect(frames).toHaveLength(2);
    expect(frames[1].cursors).toEqual([{ id: GUEST_ID_BASE, x: 0.4, y: 0.6, engaged: false, conf: 1 }]);
    // Idempotent: a second close (socket teardown races) relays nothing more.
    conn.close();
    expect(room.sent.filter((m) => (m as { type: string }).type === "cursors")).toHaveLength(2);
  });

  test("keys frames broadcast to EVERY window with the guest seq; disconnect releases held keys everywhere", () => {
    const hub = makeHub();
    const roomA = fakePeer();
    const roomB = fakePeer();
    hub.addRoom(roomA.send).message(hello("A"));
    hub.addRoom(roomB.send).message(hello("B"));

    const conn = hub.addGuest(fakePeer().send);
    conn.message(JSON.stringify({ type: "keys", held: ["w", "d", "w", "x"] })); // dupes + junk dropped
    // Unlike cursors, key holds reach BOTH windows: the flat pair shares one
    // camera rig that only stays in lockstep if every window integrates the
    // identical hold timeline. Each frame is stamped with the RECEIVING
    // room's wall so the wall client's wall-match parse accepts it.
    expect(keysFramesOf(roomA)).toHaveLength(1);
    expect(keysFramesOf(roomA)[0]).toMatchObject({ wall: "A", guest: 0, held: ["w", "d"] });
    expect(keysFramesOf(roomB)).toHaveLength(1);
    expect(keysFramesOf(roomB)[0]).toMatchObject({ wall: "B", guest: 0, held: ["w", "d"] });

    conn.close();
    // The release must reach every window too — no wall camera may keep walking.
    expect(keysFramesOf(roomA)).toHaveLength(2);
    expect(keysFramesOf(roomA)[1].held).toEqual([]);
    expect(keysFramesOf(roomB)).toHaveLength(2);
    expect(keysFramesOf(roomB)[1].held).toEqual([]);
  });

  test("a guest's explicit wall pick routes cursors only — both rooms still receive its key holds", () => {
    const hub = makeHub();
    const roomA = fakePeer();
    const roomB = fakePeer();
    hub.addRoom(roomA.send).message(hello("A"));
    hub.addRoom(roomB.send).message(hello("B"));

    const conn = hub.addGuest(fakePeer().send);
    conn.message(hello("B"));
    conn.message(JSON.stringify({ type: "keys", held: ["w"] }));
    expect(keysFramesOf(roomA)).toHaveLength(1);
    expect(keysFramesOf(roomA)[0]).toMatchObject({ wall: "A", guest: 0, held: ["w"] });
    expect(keysFramesOf(roomB)).toHaveLength(1);
    expect(keysFramesOf(roomB)[0]).toMatchObject({ wall: "B", guest: 0, held: ["w"] });
  });

  test("malformed keys frames are dropped; an empty release is not re-sent on close", () => {
    const hub = makeHub();
    const room = fakePeer();
    hub.addRoom(room.send).message(hello("A"));

    const conn = hub.addGuest(fakePeer().send);
    conn.message(JSON.stringify({ type: "keys" }));
    conn.message(JSON.stringify({ type: "keys", held: "w" }));
    conn.message(JSON.stringify({ type: "keys", held: ["w"] }));
    conn.message(JSON.stringify({ type: "keys", held: [] })); // released before closing
    conn.close();
    const keys = room.sent.filter((m) => (m as { type: string }).type === "keys") as Array<{ held: string[] }>;
    expect(keys.map((frame) => frame.held)).toEqual([["w"], []]);
  });

  test("a wall's flatpose relays to every OTHER wall window — never the sender, never guests", () => {
    const hub = makeHub();
    const roomA = fakePeer();
    const roomB = fakePeer();
    const connA = hub.addRoom(roomA.send);
    connA.message(hello("A"));
    hub.addRoom(roomB.send).message(hello("B"));
    const guest = fakePeer();
    hub.addGuest(guest.send);

    connA.message(flatPose(-0.7, 5.2, 18));
    // The partner adopts; the sender's pose is already right (an echo would
    // fight the very input that produced it).
    expect(flatPosesOf(roomB)).toHaveLength(1);
    expect(flatPosesOf(roomB)[0]).toMatchObject({ yaw: -0.7, height: 5.2, dist: 18 });
    expect(typeof flatPosesOf(roomB)[0].t).toBe("number");
    expect(flatPosesOf(roomA)).toHaveLength(0);
    // The pose is projector-rig internals — guests never see it.
    expect(flatPosesOf(guest)).toHaveLength(0);
  });

  test("flatpose values are clamped in the relay; malformed flatpose frames are dropped", () => {
    const hub = makeHub();
    const roomA = fakePeer();
    const roomB = fakePeer();
    const connA = hub.addRoom(roomA.send);
    connA.message(hello("A"));
    hub.addRoom(roomB.send).message(hello("B"));

    connA.message(flatPose(1e9, 0, 1e9));
    expect(flatPosesOf(roomB)).toHaveLength(1);
    expect(flatPosesOf(roomB)[0]).toMatchObject({
      yaw: FLAT_POSE_YAW_LIMIT,
      height: FLAT_POSE_HEIGHT_MIN,
      dist: FLAT_POSE_DIST_MAX,
    });

    connA.message(JSON.stringify({ type: "flatpose", yaw: "spin", height: 5, dist: 20 }));
    connA.message(JSON.stringify({ type: "flatpose", yaw: 0 })); // missing fields
    connA.message("garbage");
    expect(flatPosesOf(roomB)).toHaveLength(1); // nothing further relayed
  });

  test("a guest-sent flatpose is dropped — only wall windows steer the pair", () => {
    const hub = makeHub();
    const room = fakePeer();
    hub.addRoom(room.send).message(hello("A"));

    const conn = hub.addGuest(fakePeer().send);
    conn.message(flatPose(1, 5, 20));
    expect(flatPosesOf(room)).toHaveLength(0);
    // And it is not stored either: a later wall subscription gets no replay.
    const late = fakePeer();
    hub.addRoom(late.send).message(hello("B"));
    expect(flatPosesOf(late)).toHaveLength(0);
  });

  test("replays the last flatpose on subscribe so a refreshed window snaps to its partner", () => {
    const hub = makeHub();
    const roomA = fakePeer();
    const connA = hub.addRoom(roomA.send);
    // Before any pose exists a hello replays nothing.
    connA.message(hello("A"));
    expect(flatPosesOf(roomA)).toHaveLength(0);

    connA.message(flatPose(0.3, 4.6, 22));
    // Window B refreshes: on its hello it immediately hears the pair's pose
    // instead of waiting for A's next input.
    const roomB = fakePeer();
    hub.addRoom(roomB.send).message(hello("B"));
    expect(flatPosesOf(roomB)).toHaveLength(1);
    expect(flatPosesOf(roomB)[0]).toMatchObject({ yaw: 0.3, height: 4.6, dist: 22 });
  });

  test("guestCount and walls track connects, hellos and closes", () => {
    const hub = makeHub();
    expect(hub.guestCount()).toBe(0);
    expect(hub.walls()).toEqual([]);

    const roomConn = hub.addRoom(fakePeer().send);
    roomConn.message(hello("B"));
    const roomConn2 = hub.addRoom(fakePeer().send);
    roomConn2.message(hello("A"));
    expect(hub.walls()).toEqual(["A", "B"]);

    const guestConn = hub.addGuest(fakePeer().send);
    expect(hub.guestCount()).toBe(1);
    guestConn.close();
    expect(hub.guestCount()).toBe(0);

    roomConn.close();
    expect(hub.walls()).toEqual(["A"]);
    roomConn2.close();
    expect(hub.walls()).toEqual([]);
  });

  test("wall subscriptions changing pushes a live walls update to guests", () => {
    const hub = makeHub();
    const guest = fakePeer();
    hub.addGuest(guest.send);
    guest.sent.length = 0; // drop the welcome

    const roomConn = hub.addRoom(fakePeer().send);
    roomConn.message(hello("A"));
    expect(guest.sent).toEqual([{ type: "walls", walls: ["A"] }]);

    roomConn.close();
    expect(guest.sent).toEqual([{ type: "walls", walls: ["A"] }, { type: "walls", walls: [] }]);
  });

  test("a closed room stops receiving frames; malformed guest input is inert", () => {
    const hub = makeHub();
    const room = fakePeer();
    const roomConn = hub.addRoom(room.send);
    roomConn.message(hello("A"));

    const conn = hub.addGuest(fakePeer().send);
    conn.message("garbage");
    conn.message(cursorsFrame([{ id: 0, x: 0.5, y: 0.5, engaged: true }]));
    expect(room.sent.filter((m) => (m as { type: string }).type === "cursors")).toHaveLength(1);

    roomConn.close();
    conn.message(cursorsFrame([{ id: 0, x: 0.6, y: 0.6, engaged: true }]));
    expect(room.sent.filter((m) => (m as { type: string }).type === "cursors")).toHaveLength(1);
  });

  test("a throwing peer send never breaks the relay for others", () => {
    const hub = makeHub();
    const bad = { send: () => { throw new Error("dying socket"); } };
    const good = fakePeer();
    hub.addRoom(bad.send).message(hello("A"));
    hub.addRoom(good.send).message(hello("A"));

    const conn = hub.addGuest(fakePeer().send);
    conn.message(cursorsFrame([{ id: 0, x: 0.5, y: 0.5, engaged: true }]));
    expect(good.sent.filter((m) => (m as { type: string }).type === "cursors")).toHaveLength(1);
  });
});

// ── resolveHandsInfo ─────────────────────────────────────────────────────────

const lanInterfaces = (): InterfaceAddresses => ({
  en0: [{ family: "IPv4", internal: false, address: "192.168.1.20" }],
});
const noLan = (): InterfaceAddresses => ({});

describe("resolveHandsInfo", () => {
  test("prefers the dedicated LAN listener via the best LAN IPv4", () => {
    const info = resolveHandsInfo({
      host: "127.0.0.1",
      port: 8787,
      phonePort: 8788,
      tlsPort: 8789,
      interfaces: lanInterfaces,
      guestCount: 2,
      walls: ["A"],
    });
    expect(info).toEqual({
      url: "http://192.168.1.20:8788/hands",
      httpsUrl: "https://192.168.1.20:8789/hands",
      host: "192.168.1.20",
      lanReachable: true,
      guestCount: 2,
      walls: ["A"],
    });
  });

  test("no TLS listener → httpsUrl is null (trackpad-only off-host, honestly)", () => {
    const info = resolveHandsInfo({
      host: "0.0.0.0",
      port: 8787,
      phonePort: null,
      tlsPort: null,
      interfaces: lanInterfaces,
      guestCount: 0,
      walls: [],
    });
    expect(info.url).toBe("http://192.168.1.20:8787/hands");
    expect(info.httpsUrl).toBeNull();
    expect(info.lanReachable).toBe(true);
  });

  test("loopback bind with no LAN listener is not reachable", () => {
    const info = resolveHandsInfo({
      host: "127.0.0.1",
      port: 8787,
      phonePort: null,
      tlsPort: null,
      interfaces: lanInterfaces,
      guestCount: 0,
      walls: [],
    });
    expect(info).toMatchObject({ url: "http://127.0.0.1:8787/hands", lanReachable: false });
  });

  test("LAN listener bound but no LAN interface up → honest unreachable", () => {
    const info = resolveHandsInfo({
      host: "127.0.0.1",
      port: 8787,
      phonePort: 8788,
      tlsPort: null,
      interfaces: noLan,
      guestCount: 0,
      walls: [],
    });
    expect(info).toMatchObject({ url: "http://127.0.0.1:8788/hands", lanReachable: false });
  });
});

// ── guest FLY MODE (raw pinch-camera frames) ─────────────────────────────────

describe("guest flyhands", () => {
  const flyFrame = (hands: unknown[], extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type: "flyhands", t: 12.5, aspect: 1.5, hands, ...extra });

  test("parseGuestMessage sanitizes flyhands: clamps, caps at 2, dedupes ids, voids bad skeletons", () => {
    const lm = Array.from({ length: 21 }, () => [0.5, 0.5] as [number, number]);
    const parsed = parseGuestMessage(
      flyFrame([
        { id: 0, x: -0.5, y: 1.7, pinch: 9, conf: 3, lm },
        { id: 0, x: 0.1, y: 0.1 }, // duplicate id → dropped
        { id: 1, x: 0.4, y: 0.6, pinch: 0.2, lm: [[0.1, 0.2]] }, // short lm → voided
        { id: 2, x: 0.9, y: 0.9 }, // third hand → capped away? (only after 2 land)
      ]),
    );
    expect(parsed).toEqual({
      kind: "flyhands",
      t: 12.5,
      aspect: 1.5,
      hands: [
        { id: 0, x: 0, y: 1, pinch: 4, conf: 1, lm },
        { id: 1, x: 0.4, y: 0.6, pinch: 0.2, conf: 1 },
      ],
    });
  });

  test("malformed flyhands (no hands array / bad ids) are dropped whole or per-hand", () => {
    expect(parseGuestMessage(JSON.stringify({ type: "flyhands", t: 1 }))).toBeNull();
    const parsed = parseGuestMessage(flyFrame([{ id: -1, x: 0.5, y: 0.5 }, { id: 1.5, x: 0.5, y: 0.5 }]));
    expect(parsed).toEqual({ kind: "flyhands", t: 12.5, aspect: 1.5, hands: [] });
  });

  test("the hub relays flyhands RAW, wall-routed, tagged with the guest seq", () => {
    const hub = makeHub();
    const roomA = fakePeer();
    const roomB = fakePeer();
    hub.addRoom(roomA.send).message(hello("A"));
    hub.addRoom(roomB.send).message(hello("B"));

    const conn = hub.addGuest(fakePeer().send);
    const lm = Array.from({ length: 21 }, () => [0.25, 0.75] as [number, number]);
    conn.message(flyFrame([{ id: 0, x: 0.42, y: 0.31, pinch: 0.21, conf: 1, lm }]));

    const frames = roomA.sent.filter((m) => (m as { type: string }).type === "flyhands");
    expect(frames).toHaveLength(1);
    const frame = frames[0] as { wall: string; guest: number; t: number; aspect: number; hands: unknown[] };
    expect(frame.wall).toBe("A");
    expect(typeof frame.guest).toBe("number");
    expect(frame.t).toBe(12.5);
    expect(frame.aspect).toBe(1.5);
    // RAW pass-through — no One Euro on this path (PinchCam owns smoothing).
    expect(frame.hands).toEqual([{ id: 0, x: 0.42, y: 0.31, pinch: 0.21, conf: 1, lm }]);
    expect(roomB.sent.filter((m) => (m as { type: string }).type === "flyhands")).toHaveLength(0);
  });
});
