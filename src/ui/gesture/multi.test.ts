import { describe, expect, test } from "bun:test";
import { Zone } from "./core";
import { MultiDwell, type DwellCursor, type DwellFire } from "./multi";

// Two side-by-side zones filling the viewport halves (normalized coords).
function twoZones(): Zone[] {
  return [new Zone("left", "L", 0, 0, 0.5, 1), new Zone("right", "R", 0.5, 0, 0.5, 1)];
}

const IN_LEFT: readonly [number, number] = [0.25, 0.5];
const IN_RIGHT: readonly [number, number] = [0.75, 0.5];
const cursor = (id: number, [x, y]: readonly [number, number], engaged = true): DwellCursor => ({ id, x, y, engaged });

// Step the coordinator with a fixed cursor feed from t0..t1, collecting fires.
function run(
  multi: MultiDwell,
  zones: Zone[],
  feed: (t: number) => DwellCursor[],
  t0: number,
  t1: number,
  dt = 0.05,
): DwellFire[] {
  const fires: DwellFire[] = [];
  for (let t = t0; t <= t1 + 1e-9; t += dt) {
    fires.push(...multi.update(zones, feed(t), t).fired);
  }
  return fires;
}

describe("MultiDwell — single cursor", () => {
  test("parked cursor fires exactly once (refire only after leaving)", () => {
    const multi = new MultiDwell();
    const zones = twoZones();
    const fires = run(multi, zones, () => [cursor(1, IN_LEFT)], 0, 5);
    expect(fires).toEqual([{ zoneId: "left", cursorId: 1 }]);
  });

  test("progress accumulates only while on the target; leave/re-enter resets", () => {
    const multi = new MultiDwell();
    const zones = twoZonesGap();
    const inLeft: readonly [number, number] = [0.05, 0.5];
    const offZones: readonly [number, number] = [0.5, 0.5]; // dead space between zones
    // 0.4s on the left zone: partial progress, no fire.
    let fires = run(multi, zones, () => [cursor(1, inLeft)], 0, 0.4);
    expect(fires).toEqual([]);
    // Leave (well past the sticky hysteresis): the dwell resets…
    fires = run(multi, zones, () => [cursor(1, offZones)], 0.45, 0.65);
    expect(fires).toEqual([]);
    // …re-enter at 0.7: no fire until a FULL dwell from re-entry (0.7 + 0.8).
    fires = run(multi, zones, () => [cursor(1, inLeft)], 0.7, 1.45);
    expect(fires).toEqual([]);
    fires = run(multi, zones, () => [cursor(1, inLeft)], 1.5, 1.7);
    expect(fires).toEqual([{ zoneId: "left", cursorId: 1 }]);
  });

  test("disengaged cursor never accumulates dwell", () => {
    const multi = new MultiDwell();
    const fires = run(multi, twoZones(), () => [cursor(1, IN_LEFT, false)], 0, 3);
    expect(fires).toEqual([]);
  });

  test("timer restarts when the cursor moves to a different zone", () => {
    const multi = new MultiDwell();
    const zones = twoZones();
    // 0.6s on left, then hop to right: left never fires; right fires 0.8s later.
    const fires = run(multi, zones, (t) => [cursor(1, t < 0.6 ? IN_LEFT : IN_RIGHT)], 0, 1.45);
    expect(fires).toEqual([{ zoneId: "right", cursorId: 1 }]);
  });
});

// Zones with a gap in the middle so a point can sit on NO zone (the plain
// two-zone split has no dead space and sticky hysteresis would hold forever).
function twoZonesGap(): Zone[] {
  return [new Zone("left", "L", 0, 0, 0.1, 1), new Zone("right", "R", 0.9, 0, 0.1, 1)];
}

describe("MultiDwell — multi-cursor priority (one primary per target)", () => {
  test("first cursor to dwell claims the target; only it fires", () => {
    const multi = new MultiDwell();
    const zones = twoZones();
    // Cursor 1 arrives at t=0, cursor 2 at t=0.1 on the SAME zone.
    const feed = (t: number) => (t < 0.1 ? [cursor(1, IN_LEFT)] : [cursor(1, IN_LEFT), cursor(2, IN_LEFT)]);
    const fires = run(multi, zones, feed, 0, 1.0);
    expect(fires).toEqual([{ zoneId: "left", cursorId: 1 }]);
  });

  test("active list reports at most one dweller per zone (the claimant)", () => {
    const multi = new MultiDwell();
    const zones = twoZones();
    multi.update(zones, [cursor(1, IN_LEFT), cursor(2, IN_LEFT)], 0);
    const result = multi.update(zones, [cursor(1, IN_LEFT), cursor(2, IN_LEFT)], 0.4);
    const onLeft = result.active.filter((a) => a.zoneId === "left");
    expect(onLeft).toHaveLength(1);
    expect(onLeft[0].cursorId).toBe(1);
    expect(onLeft[0].progress).toBeGreaterThan(0.4);
  });

  test("same-tick race: earlier cursor in the feed wins the claim", () => {
    const multi = new MultiDwell();
    const fires = run(multi, twoZones(), () => [cursor(7, IN_LEFT), cursor(8, IN_LEFT)], 0, 1.0);
    expect(fires).toEqual([{ zoneId: "left", cursorId: 7 }]);
  });

  test("two cursors on two different zones dwell independently", () => {
    const multi = new MultiDwell();
    const fires = run(multi, twoZones(), () => [cursor(1, IN_LEFT), cursor(2, IN_RIGHT)], 0, 1.0);
    expect(fires).toHaveLength(2);
    expect(fires).toContainEqual({ zoneId: "left", cursorId: 1 });
    expect(fires).toContainEqual({ zoneId: "right", cursorId: 2 });
  });

  test("after a fire the zone is LOCKED briefly for the runner-up (no double-toggle)", () => {
    const multi = new MultiDwell({ dwellSeconds: 0.8, lockSeconds: 0.4 });
    const zones = twoZones();
    const feed = () => [cursor(1, IN_LEFT), cursor(2, IN_LEFT)];
    const all: { t: number; fire: DwellFire }[] = [];
    for (let t = 0; t <= 3.0 + 1e-9; t += 0.05) {
      for (const fire of multi.update(zones, feed(), t).fired) {
        all.push({ t, fire });
      }
    }
    // Cursor 1 fires at ~0.8. Cursor 2 may only fire after the 0.4s lock has
    // expired AND a full 0.8s dwell of its own: never before ~2.0.
    expect(all[0].fire).toEqual({ zoneId: "left", cursorId: 1 });
    const second = all[1];
    expect(second).toBeDefined();
    expect(second.fire.cursorId).toBe(2);
    expect(second.t).toBeGreaterThanOrEqual(1.95);
    // And cursor 1 (still parked) never re-fires without leaving.
    expect(all.filter((entry) => entry.fire.cursorId === 1)).toHaveLength(1);
  });

  test("a vanished cursor releases its claim so another can take over", () => {
    const multi = new MultiDwell();
    const zones = twoZones();
    // Cursor 1 claims left; cursor 2 waits on the same zone.
    run(multi, zones, () => [cursor(1, IN_LEFT), cursor(2, IN_LEFT)], 0, 0.4);
    // Cursor 1's hand drops out of the stream entirely.
    const fires = run(multi, zones, () => [cursor(2, IN_LEFT)], 0.45, 1.4);
    expect(fires).toEqual([{ zoneId: "left", cursorId: 2 }]);
  });
});
