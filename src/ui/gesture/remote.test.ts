import { describe, expect, test } from "bun:test";
import {
  GUEST_ID_BASE,
  GUEST_ID_STRIDE,
  RemoteKeyHolds,
  guestCursorId,
  guestDwellCaps,
  isGuestCursorId,
  roomHandsSocketUrl,
  shouldDrawCursorDot,
  shouldDrawNameTag,
  visibleCursorDots,
} from "./remote";

describe("guestCursorId", () => {
  test("assigns disjoint negative id blocks per guest, descending", () => {
    expect(guestCursorId(0, 0)).toBe(GUEST_ID_BASE);
    expect(guestCursorId(0, 1)).toBe(GUEST_ID_BASE - 1);
    expect(guestCursorId(1, 0)).toBe(GUEST_ID_BASE - GUEST_ID_STRIDE);
    expect(guestCursorId(2, 1)).toBe(GUEST_ID_BASE - 2 * GUEST_ID_STRIDE - 1);
  });

  test("two guests can never collide on any local hand id", () => {
    const seen = new Set<number>();
    for (let seq = 0; seq < 20; seq += 1) {
      for (let local = 0; local < GUEST_ID_STRIDE; local += 1) {
        const id = guestCursorId(seq, local);
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }
    }
  });

  test("out-of-range local ids fold into the guest's own block (defensive)", () => {
    expect(guestCursorId(1, GUEST_ID_STRIDE)).toBe(guestCursorId(1, 0));
    expect(guestCursorId(1, -1)).toBe(guestCursorId(1, GUEST_ID_STRIDE - 1));
  });
});

describe("isGuestCursorId", () => {
  test("guest block ids are guests; fusion/mouse ids are not", () => {
    expect(isGuestCursorId(GUEST_ID_BASE)).toBe(true);
    expect(isGuestCursorId(guestCursorId(3, 1))).toBe(true);
    expect(isGuestCursorId(0)).toBe(false);
    expect(isGuestCursorId(7)).toBe(false);
    expect(isGuestCursorId(-1)).toBe(false); // the mouse-test cursor
  });

  test("long-session fusion track ids (unbounded positives) can NEVER read as guests", () => {
    // The fusion tracker mints ever-increasing positive ids — a same-sign
    // guest range would eventually be invaded. Negatives are disjoint forever.
    expect(isGuestCursorId(1000)).toBe(false);
    expect(isGuestCursorId(1_000_000)).toBe(false);
  });
});

describe("guestDwellCaps", () => {
  test("guest-block ids hover-dwell and instant-fire; camera/mouse ids keep the engaged gate", () => {
    expect(guestDwellCaps(GUEST_ID_BASE)).toEqual({ hoverDwells: true, instantFire: true });
    expect(guestDwellCaps(guestCursorId(2, 1))).toEqual({ hoverDwells: true, instantFire: true });
    expect(guestDwellCaps(0)).toEqual({}); // fusion track
    expect(guestDwellCaps(1_000_000)).toEqual({}); // long-session fusion track
    expect(guestDwellCaps(-1)).toEqual({}); // the mouse-test cursor
  });
});

describe("shouldDrawCursorDot / visibleCursorDots", () => {
  test("guest cursors always draw; in-room cursors honor the preference", () => {
    expect(shouldDrawCursorDot(GUEST_ID_BASE, false)).toBe(true);
    expect(shouldDrawCursorDot(7, false)).toBe(false);
    expect(shouldDrawCursorDot(7, true)).toBe(true);
    expect(shouldDrawCursorDot(-1, false)).toBe(false);
  });

  test("visibleCursorDots keeps guests with the preference OFF and everything with it ON", () => {
    const cursors = new Map<number, string>([
      [GUEST_ID_BASE, "guest"],
      [7, "camera"],
      [-1, "mouse"],
    ]);
    expect(visibleCursorDots(cursors, false).map(([id]) => id)).toEqual([GUEST_ID_BASE]);
    expect(visibleCursorDots(cursors, true).map(([id]) => id)).toEqual([GUEST_ID_BASE, 7, -1]);
  });
});

describe("shouldDrawNameTag", () => {
  test("only a guest cursor WITH a name gets a tag", () => {
    expect(shouldDrawNameTag(GUEST_ID_BASE, "Zoë")).toBe(true);
    expect(shouldDrawNameTag(guestCursorId(3, 1), "Ada")).toBe(true);
    expect(shouldDrawNameTag(GUEST_ID_BASE, undefined)).toBe(false); // anonymous guest
    expect(shouldDrawNameTag(GUEST_ID_BASE, null)).toBe(false);
    expect(shouldDrawNameTag(GUEST_ID_BASE, "")).toBe(false);
  });

  test("camera/fusion and mouse cursors never get a tag, even with a leaked name field", () => {
    expect(shouldDrawNameTag(7, "Mallory")).toBe(false);
    expect(shouldDrawNameTag(1_000_000, "Mallory")).toBe(false);
    expect(shouldDrawNameTag(-1, "Mallory")).toBe(false); // the mouse-test cursor
  });
});

describe("roomHandsSocketUrl", () => {
  test("http page → ws same-origin", () => {
    expect(roomHandsSocketUrl({ protocol: "http:", host: "192.168.1.20:8788" })).toBe(
      "ws://192.168.1.20:8788/api/hands/room",
    );
  });

  test("https page → wss same-origin", () => {
    expect(roomHandsSocketUrl({ protocol: "https:", host: "room.local:8790" })).toBe(
      "wss://room.local:8790/api/hands/room",
    );
  });
});

describe("RemoteKeyHolds", () => {
  test("press and release produce exactly one keydown and one keyup", () => {
    const holds = new RemoteKeyHolds();
    holds.update(0, ["w"], 0);
    expect(holds.diff(0.1)).toEqual({ down: ["w"], up: [] });
    expect(holds.diff(0.2)).toEqual({ down: [], up: [] }); // held: no re-fire
    holds.update(0, [], 0.3);
    expect(holds.diff(0.3)).toEqual({ down: [], up: ["w"] });
  });

  test("holds merge across guests: a key stays down until EVERY holder releases", () => {
    const holds = new RemoteKeyHolds();
    holds.update(0, ["w"], 0);
    holds.update(1, ["w", "d"], 0);
    expect(holds.diff(0.1).down.sort()).toEqual(["d", "w"]);
    holds.update(0, [], 0.2);
    expect(holds.diff(0.2)).toEqual({ down: [], up: [] }); // guest 1 still holds both
    holds.update(1, [], 0.3);
    expect(holds.diff(0.3).up.sort()).toEqual(["d", "w"]);
  });

  test("a guest silent past the stale window auto-releases (crashed page never walks forever)", () => {
    const holds = new RemoteKeyHolds(1.5);
    holds.update(0, ["s"], 0);
    expect(holds.diff(0)).toEqual({ down: ["s"], up: [] });
    expect(holds.diff(1.4)).toEqual({ down: [], up: [] }); // heartbeats missed but within grace
    expect(holds.diff(1.6)).toEqual({ down: [], up: ["s"] });
  });

  test("heartbeats refresh the stale clock", () => {
    const holds = new RemoteKeyHolds(1.5);
    holds.update(0, ["a"], 0);
    holds.diff(0);
    holds.update(0, ["a"], 1.4);
    expect(holds.diff(2.0)).toEqual({ down: [], up: [] }); // refreshed at 1.4
    expect(holds.diff(3.0)).toEqual({ down: [], up: ["a"] });
  });

  test("releaseAll returns everything applied, for unmount cleanup", () => {
    const holds = new RemoteKeyHolds();
    holds.update(0, ["w", "a"], 0);
    holds.diff(0);
    expect(holds.releaseAll().sort()).toEqual(["a", "w"]);
    expect(holds.diff(0.1)).toEqual({ down: [], up: [] });
  });
});
