// "THE RESPONSIVITY SUCKS" — measured, not argued.
//
// The other specs measure spoken→painted latency. This one measures the wall's
// own frame clock, because the second half of that complaint is a projector
// that feels heavy while a three.js garden and a per-frame DOM sweep share the
// main thread:
//   • src/ui/ControlDock.tsx runs root.matches(':hover') + a
//     querySelector(':focus-visible') on EVERY animation frame, forever.
//   • src/ui/gesture/GestureLayer.tsx runs querySelectorAll + elementFromPoint
//     per visible control per frame (guarded on cursors.size > 0) and
//     querySelectorAll('[data-dwell-shield]') + getBoundingClientRect per shield.
//
// It samples requestAnimationFrame deltas in three configurations on the real
// wall URL and reports p50/p95/max for each.
//
// THE ASSERTION IS A RATIO, NOT A MILLISECOND COUNT. This browser paints on
// SwiftShader (a software GPU) at projector resolution, so the absolute numbers
// belong to the renderer, not to the room — asserting on them would manufacture
// a defect. What IS hardware-independent is the COST THE APP ADDS: opening a
// menu, and mounting the guest-hands dwell layer, must not multiply the wall's
// frame time. Absolute numbers are printed for the record.

import { expect, reportCoverage, test } from "./live-room";
import { percentile, sampleFrameDeltas } from "./journey";

/** Using the room may cost frames; it may not cost this multiple of them. */
const MAX_SLOWDOWN = 2.5;
const SAMPLE_MS = 4_000;

async function report(page: import("@playwright/test").Page, label: string): Promise<{ p50: number; p95: number }> {
  const deltas = (await sampleFrameDeltas(page, SAMPLE_MS)).slice(2);
  const p50 = percentile(deltas, 50);
  const p95 = percentile(deltas, 95);
  const max = percentile(deltas, 100);
  const fps = p50 === 0 ? 0 : Math.round(1000 / p50);
  console.log(`[frame-pacing] ${label}: n=${deltas.length} p50=${p50}ms (~${fps}fps) p95=${p95}ms max=${max}ms`);
  return { p50, p95 };
}

test("the wall keeps its frame budget while the room is being used", async ({ room, wall }) => {
  await reportCoverage(room, "frame-pacing");
  const page = wall.page;

  // 1. The projected wall exactly as the operator runs it (guest-hands dwell
  //    layer mounted, because ?remote defaults ON).
  await wall.open("/?wall=A&flat=1");
  await expect(page.locator('[data-testid="room-scene"]')).toBeVisible();
  const idle = await report(page, "projected wall, idle");

  // 2. The same wall with a tree menu open — a glass panel, an anchor chased at
  //    1Hz, and the dock's collapse animation.
  const target = (await room.state()).processes[0]!;
  await page.evaluate((callsign) => window.__VIBERSYN__?.select(callsign), target.callsign);
  const busy = await report(page, "projected wall, tree menu open");

  // 3. The control wall with the dwell layer removed, to attribute the cost.
  await wall.open("/?wall=A&flat=1&remote=0");
  await page.evaluate((callsign) => window.__VIBERSYN__?.select(callsign), target.callsign);
  const noDwell = await report(page, "&remote=0 (no dwell layer), tree menu open");

  const slowdown = idle.p50 === 0 ? 0 : Math.round((busy.p50 / idle.p50) * 100) / 100;
  const dwellCost = noDwell.p50 === 0 ? 0 : Math.round((busy.p50 / noDwell.p50) * 100) / 100;
  console.log(
    `[frame-pacing] using the room costs ${slowdown}x the idle frame time; the guest-hands dwell layer costs ${dwellCost}x`,
  );
  expect(
    slowdown,
    `opening a tree menu must not multiply the wall's frame time (measured ${slowdown}x: idle p50 ${idle.p50}ms → in-use p50 ${busy.p50}ms)`,
  ).toBeLessThanOrEqual(MAX_SLOWDOWN);
});
