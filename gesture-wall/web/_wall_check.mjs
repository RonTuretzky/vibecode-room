// Node check for web/wall.js pure helpers (no DOM, no socket).
// Run: node web/_wall_check.mjs
import assert from "node:assert/strict";
import {
  idToHue,
  parseParams,
  isZoneLocked,
  lockZone,
  pruneLocks,
  staleIds,
  unlockedZones,
  STALE_SECONDS,
  ZONE_LOCK_SECONDS,
} from "./wall.js";
import { buildGrid, DwellSelector } from "./core.js";

let n = 0;
const ok = (name) => { n++; console.log(`  ok ${name}`); };

// --- idToHue ---------------------------------------------------------------
{
  // Deterministic + in range.
  for (let id = 0; id < 50; id++) {
    const h = idToHue(id);
    assert.ok(h >= 0 && h < 360, `hue in range for ${id}`);
    assert.equal(idToHue(id), h, "hue is stable");
  }
  // Consecutive ids are well-separated (golden-angle spread > 100deg apart).
  const sep = Math.abs(idToHue(1) - idToHue(2));
  const circSep = Math.min(sep, 360 - sep);
  assert.ok(circSep > 90, `consecutive ids spread (got ${circSep})`);
  // id=-1 (mouse) has a fixed distinct hue.
  assert.equal(idToHue(-1), 200, "mouse hue fixed");
  ok("idToHue");
}

// --- parseParams -----------------------------------------------------------
{
  const a = parseParams("?wall=B&server=ws://x:9/&rows=3&cols=4");
  assert.equal(a.wall, "B");
  assert.equal(a.server, "ws://x:9/");
  assert.equal(a.rows, 3);
  assert.equal(a.cols, 4);

  const d = parseParams("");
  assert.equal(d.wall, "A");
  assert.equal(d.rows, 2);
  assert.equal(d.cols, 3);
  assert.ok(d.server.startsWith("ws://"), "default server is ws://");

  // Bad ints fall back; out-of-range clamps.
  const c = parseParams("?rows=abc&cols=999");
  assert.equal(c.rows, 2, "bad rows -> default");
  assert.equal(c.cols, 12, "huge cols clamps to 12");
  ok("parseParams");
}

// --- zone lock decision ----------------------------------------------------
{
  const locks = new Map();
  assert.equal(isZoneLocked(locks, "r0c0", 0), false, "unlocked initially");

  lockZone(locks, "r0c0", 10.0);                 // unlock at 10 + 0.4
  assert.equal(isZoneLocked(locks, "r0c0", 10.1), true, "locked just after toggle");
  assert.equal(isZoneLocked(locks, "r0c0", 10.0 + ZONE_LOCK_SECONDS - 0.001), true, "locked until window end");
  assert.equal(isZoneLocked(locks, "r0c0", 10.0 + ZONE_LOCK_SECONDS), false, "unlocked at window end");
  assert.equal(isZoneLocked(locks, "other", 10.1), false, "only that zone is locked");

  // Custom lock duration.
  const l2 = new Map();
  lockZone(l2, "z", 0, 1.0);
  assert.equal(isZoneLocked(l2, "z", 0.5), true);
  assert.equal(isZoneLocked(l2, "z", 1.0), false);

  // pruneLocks removes only expired entries.
  pruneLocks(locks, 10.0 + ZONE_LOCK_SECONDS);
  assert.equal(locks.has("r0c0"), false, "expired lock pruned");
  ok("zone lock decision");
}

// --- unlockedZones filters shared zones ------------------------------------
{
  const zones = buildGrid(2, 3, 0.06);
  const locks = new Map();
  lockZone(locks, zones[0].id, 5.0);
  const vis = unlockedZones(zones, locks, 5.1);
  assert.equal(vis.length, zones.length - 1, "locked zone removed from dwell view");
  assert.ok(!vis.includes(zones[0]), "locked zone absent");
  // Surviving zones are the SAME object references (so dwell toggles the shared Zone).
  assert.ok(vis.every(z => zones.includes(z)), "returned zones are shared refs");
  // After the lock expires every zone is visible again.
  const vis2 = unlockedZones(zones, locks, 5.0 + ZONE_LOCK_SECONDS);
  assert.equal(vis2.length, zones.length, "all zones visible after unlock");
  ok("unlockedZones");
}

// --- staleIds eviction -----------------------------------------------------
{
  const cursors = new Map();
  cursors.set(1, { lastSeen: 9.0 });    // 1.0s old at t=10 -> stale
  cursors.set(2, { lastSeen: 9.8 });    // 0.2s old -> fresh
  cursors.set(-1, { lastSeen: 10.0 });  // mouse, just seen -> fresh
  const stale = staleIds(cursors, 10.0);
  assert.deepEqual(stale, [1], "only the >0.5s-old cursor is stale");

  // Exactly STALE_SECONDS old is NOT yet stale (strict > boundary).
  cursors.clear();
  cursors.set(7, { lastSeen: 10.0 - STALE_SECONDS });
  assert.deepEqual(staleIds(cursors, 10.0), [], "exactly at threshold not stale");
  cursors.set(7, { lastSeen: 10.0 - STALE_SECONDS - 0.0001 });
  assert.deepEqual(staleIds(cursors, 10.0), [7], "just past threshold is stale");
  ok("staleIds eviction");
}

// --- shared-lock conflict: two users on the SAME tile toggle it only once -----
// Reproduces the wall.js frame logic for the zone-lock conflict rule.
{
  const zones = buildGrid(1, 1, 0.0);              // single tile covering the wall
  const locks = new Map();
  const dwell = 0.8, cool = 0.4, hys = 0.0;
  // Two dwellers both parked dead-centre on the only tile.
  const A = new DwellSelector(dwell, cool, hys);
  const B = new DwellSelector(dwell, cool, hys);
  const pt = [0.5, 0.5];
  const toggles = [];

  // Step one cursor through the frame logic (lock-aware), return any event.
  function step(d, t) {
    if (d.activeZone && isZoneLocked(locks, d.activeZone.id, t)) d.reset();
    const vis = unlockedZones(zones, locks, t);
    const ev = d.update(vis, pt, t, true);
    if (ev) { lockZone(locks, ev.zoneId, t); toggles.push({ t, zoneId: ev.zoneId, selected: ev.selected }); }
    return ev;
  }

  // Advance time; both dwellers see the tile continuously. A reaches 0.8s first.
  for (let t = 0; t <= 1.0 + 1e-9; t += 0.1) {
    const tt = +t.toFixed(4);
    step(A, tt);   // A enters at t=0, completes at t>=0.8
    step(B, tt);   // B enters at t=0 too, would also complete at 0.8 — but tile is now locked
  }

  // Exactly ONE toggle should have fired even though both dwelt the full time,
  // because committing locks the zone and the lock-reset prevents B's sticky finish.
  assert.equal(toggles.length, 1, `shared lock prevents double-toggle (got ${toggles.length})`);
  assert.equal(zones[0].selected, true, "tile ends selected (toggled exactly once)");
  ok("shared zone-lock prevents double-toggle");
}

console.log(`\nwall.js node check: ${n} groups passed`);
