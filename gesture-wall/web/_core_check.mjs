// Node check for web/core.js — the shared pure-logic core that gesturewall.js
// (single-wall app) and wall.js (networked client) both import.
//
// gesturewall.js itself can't be imported under bare Node because its first line
// loads MediaPipe from a CDN URL and it bootstraps from DOMContentLoaded. But it
// DEFINES none of the pure classes — it imports every one of them from ./core.js
// (verified: no class/function (OneEuroFilter|Point2DFilter|Zone|buildGrid|
// DwellSelector|Homography) definition in gesturewall.js). So exercising core.js
// here proves the exact logic gesturewall.js runs in the browser.
//
// Run: node web/_core_check.mjs
import assert from "node:assert/strict";
import {
  OneEuroFilter,
  Point2DFilter,
  Zone,
  buildGrid,
  DwellSelector,
  Homography,
  WALL_CORNERS,
  CORNER_NAMES,
} from "./core.js";

let n = 0;
const ok = (name) => { n++; console.log(`  ok ${name}`); };

// --- named exports all present ---------------------------------------------
{
  for (const [name, v] of Object.entries({
    OneEuroFilter, Point2DFilter, Zone, buildGrid, DwellSelector, Homography,
    WALL_CORNERS, CORNER_NAMES,
  })) assert.ok(v != null, `export ${name} present`);
  assert.equal(WALL_CORNERS.length, 4, "WALL_CORNERS has 4 corners");
  assert.equal(CORNER_NAMES.length, 4, "CORNER_NAMES has 4 names");
  ok("named exports");
}

// --- Homography corner round-trip (~1e-12) ---------------------------------
{
  // Arbitrary, clearly non-degenerate quad in image space.
  const src = [[0.10, 0.12], [0.88, 0.07], [0.93, 0.91], [0.06, 0.85]];
  const H = Homography.fromCornerPoints(src);            // src -> WALL_CORNERS
  let maxErr = 0;
  for (let i = 0; i < 4; i++) {
    const [u, v] = H.apply(src[i][0], src[i][1]);
    const [eu, ev] = WALL_CORNERS[i];
    maxErr = Math.max(maxErr, Math.abs(u - eu), Math.abs(v - ev));
  }
  assert.ok(maxErr < 1e-12, `corner round-trip error ${maxErr} < 1e-12`);

  // Identity maps points to themselves.
  const I = Homography.identity();
  const [ix, iy] = I.apply(0.37, 0.62);
  assert.ok(Math.abs(ix - 0.37) < 1e-15 && Math.abs(iy - 0.62) < 1e-15, "identity is identity");

  // Degenerate (collinear) source is rejected.
  assert.throws(() => Homography.fromCornerPoints([[0, 0], [0.3, 0.3], [0.6, 0.6], [0.9, 0.9]]),
    /degenerate/, "collinear quad rejected");
  ok("Homography corner round-trip");
}

// --- 1-Euro steady-state ----------------------------------------------------
{
  // Feeding a constant signal must converge to that constant.
  const f = new OneEuroFilter(60, 1.0, 0.0);
  let y = 0;
  for (let i = 0; i < 200; i++) y = f.call(5.0, i / 60);
  assert.ok(Math.abs(y - 5.0) < 1e-6, `1-euro steady-state -> 5.0 (got ${y})`);

  // First sample passes through unchanged (no history).
  const g = new OneEuroFilter(60, 1.0, 0.007);
  assert.equal(g.call(0.42, 0), 0.42, "first sample passes through");

  // Point2DFilter converges on both axes.
  const p = new Point2DFilter(60, 1.0, 0.007);
  let xy = [0, 0];
  for (let i = 0; i < 200; i++) xy = p.call(0.3, 0.7, i / 60);
  assert.ok(Math.abs(xy[0] - 0.3) < 1e-6 && Math.abs(xy[1] - 0.7) < 1e-6,
    `point filter steady-state (got ${xy})`);
  ok("1-euro steady-state");
}

// --- dwell toggle -----------------------------------------------------------
{
  const zones = buildGrid(1, 1, 0.0);                   // single tile over the wall
  const d = new DwellSelector(0.8, 0.4, 0.15);
  const pt = [0.5, 0.5];

  // Not engaged -> no progress, no event.
  assert.equal(d.update(zones, pt, 0.0, false), null, "disengaged -> null");

  // Enter the tile; dwell builds but doesn't fire before 0.8s.
  assert.equal(d.update(zones, pt, 0.0, true), null, "enter -> null");
  assert.equal(d.update(zones, pt, 0.5, true), null, "mid-dwell -> null");
  assert.ok(d.progress > 0 && d.progress < 1, "progress advancing");

  // Cross the dwell threshold -> exactly one toggle event, tile becomes selected.
  const ev = d.update(zones, pt, 0.8, true);
  assert.ok(ev && ev.zoneId === zones[0].id && ev.selected === true, "toggle fires, selected=true");
  assert.equal(zones[0].selected, true, "zone marked selected");

  // Cooldown: immediately after, no re-fire.
  assert.equal(d.update(zones, pt, 0.85, true), null, "cooldown suppresses re-toggle");

  // After cooldown, a fresh full dwell toggles back off.
  d.update(zones, pt, 1.3, true);   // re-enter after cooldown (0.8+0.4=1.2)
  const ev2 = d.update(zones, pt, 2.2, true);
  assert.ok(ev2 && ev2.selected === false, "second dwell toggles back off");
  ok("dwell toggle");
}

console.log(`\ncore.js node check: ${n} groups passed`);
