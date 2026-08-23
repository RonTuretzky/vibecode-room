// JOURNEY B, THE TWO HALVES NOBODY CAN SEE — pressing Record, and being told
// the room got it.
//
// e2e/record-window.live-pw.ts owns the middle of this journey (collect → the
// grace drain → the dispatch on the wire). This spec owns the two ends:
//
//   1. THE PRESS. `arm()` is `void fetch(...).catch(() => undefined)` and the
//      lit state is derived purely from the next pushed snapshot
//      (src/ui/RecordSteerToggle.tsx: `const recording = process.steering === true`).
//      On a slow network the button is visually inert for the whole round trip:
//      the person presses, nothing happens, they press again.
//   2. THE RECEIPT. Stop always renders "✓ got it — …", because `dispatched` is
//      set to `[]` (never null) on the recording→stopped edge. Meanwhile the
//      server's #drainSteerGrace returns silently when the collected slice is
//      empty (src/server/composition.ts). Say nothing, press stop: the wall
//      claims a build that was never dispatched.
//
// URL NOTE: `&remote=0` — the tree menu self-closes on the default wall URL
// (owned by e2e/popup-lifetime.live-pw.ts), which would eat the buttons.

import { expect, reportCoverage, test } from "./live-room";
import { measure, wallFingerprint, wallText } from "./journey";

const WALL = "/?wall=A&flat=1&remote=0";

/** A press must be acknowledged inside one animation of human patience. */
const ACK_BUDGET_MS = 400;
/** How long the injected /select round trip takes — a plausible bad network. */
const SLOW_NETWORK_MS = 3_000;
/** STEER_GRACE_MS (2500) + the drain timer's 100ms slack + slack for the wall. */
const RECEIPT_BUDGET_MS = 3_500;

test("pressing Record acknowledges the press before the server answers", async ({ room, wall }) => {
  await reportCoverage(room, "record-honesty");
  await wall.open(WALL);
  const page = wall.page;
  const target = (await room.state()).processes[0]!;

  await page.evaluate((callsign) => window.__VIBERSYN__?.select(callsign), target.callsign);
  await expect(page.locator('[data-testid="tree-menu"]')).toBeVisible({ timeout: 10_000 });

  // A slow-but-working room: the POST still lands, it just takes 3s.
  await page.route("**/api/process/*/select", async (route) => {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, SLOW_NETWORK_MS));
    await route.continue();
  });

  const button = page.locator('[data-testid="record-steer-start"]').first();
  const before = await wallFingerprint(page);
  await button.click();
  const acked = await measure(async () => (await wallFingerprint(page)) !== before, {
    timeoutMs: SLOW_NETWORK_MS + 4_000,
    pollMs: 20,
  });
  console.log(
    `[record-honesty] press → ANY visible change: ${acked.elapsedMs}ms (budget ${ACK_BUDGET_MS}ms, injected network delay ${SLOW_NETWORK_MS}ms)`,
  );

  // The room is not broken — it is mute. Prove the round trip eventually works,
  // so the finding is precisely "no optimistic state", not "arming is broken".
  await expect(page.locator('[data-testid="record-steer-stop"]').first()).toBeVisible({
    timeout: SLOW_NETWORK_MS + 5_000,
  });
  expect(
    acked.elapsedMs,
    `the Record button showed the press within ${ACK_BUDGET_MS}ms (measured ${acked.elapsedMs}ms — the whole ` +
      "network round trip, because src/ui/RecordSteerToggle.tsx arm() discards its response and the button's " +
      "entire state comes from the next SSE snapshot)",
  ).toBeLessThanOrEqual(ACK_BUDGET_MS);
});

test("the room does not claim it got a recording nobody made", async ({ room, wall }) => {
  await wall.open(WALL);
  const page = wall.page;
  const target = (await room.state()).processes[0]!;

  await page.evaluate((callsign) => window.__VIBERSYN__?.select(callsign), target.callsign);
  await page.locator('[data-testid="record-steer-start"]').first().click();
  await room.waitFor((snapshot) => snapshot.steeringUpid === target.upid, { label: "record armed", timeoutMs: 5_000 });
  await expect(page.locator('[data-testid="record-steer-stop"]').first()).toBeVisible();

  // …and say NOTHING. Then stop. This is what happens every time somebody arms
  // the window by accident, or speaks and the mic was muted.
  await page.waitForTimeout(1_000);
  const stoppedAtMs = Date.now();
  await page.locator('[data-testid="record-steer-stop"]').first().click();

  const panel = page.locator('[data-testid="record-steer-dispatched"]');
  const claimed = await measure(async () => (await panel.count()) > 0, { timeoutMs: RECEIPT_BUDGET_MS, pollMs: 30 });
  const claimText = claimed.ok ? (await panel.innerText()).replace(/\s+/gu, " ").trim() : "(no panel)";
  console.log(`[record-honesty] stop → receipt panel in ${claimed.elapsedMs}ms: "${claimText}"`);

  // Give the server its full grace window before judging the claim.
  await page.waitForTimeout(Math.max(0, RECEIPT_BUDGET_MS - (Date.now() - stoppedAtMs)));
  const traces = await room.traces();
  const dispatched = traces.filter((entry) => entry.event === "process.steer");
  const collects = traces.filter((entry) => entry.event === "steering.window.collect");
  console.log(
    `[record-honesty] server after the grace: ${collects.length} collect(s), ${dispatched.length} dispatch(es)`,
  );

  const wall_ = await wallText(page);
  const claimsSuccess = /got it/iu.test(wall_);
  expect(
    !claimsSuccess || dispatched.length > 0,
    `the wall says "${claimText}" ${RECEIPT_BUDGET_MS}ms after Stop, while the server collected ${collects.length} ` +
      `line(s) and dispatched ${dispatched.length} — src/ui/RecordSteerToggle.tsx sets dispatched=[] (never null) on ` +
      "the recording→stopped edge, and src/server/composition.ts #drainSteerGrace returns silently on an empty slice",
  ).toBe(true);
});
