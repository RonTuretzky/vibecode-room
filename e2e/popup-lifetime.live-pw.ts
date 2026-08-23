// POPUP LIFETIME — "menus close themselves before you can read them".
//
// The wall URL the operator projects (`/?wall=A&flat=1`) leaves ?remote at its
// production DEFAULT. This spec opens a tree menu on that exact URL and simply
// waits, which is the whole experiment: a menu that is still on screen after
// 20 seconds passes, one that vanishes fails and prints WHEN it vanished.
//
// The `&remote=0` variant is the control. Running both in one file makes the
// difference between them the finding, rather than a claim about internals.

import { expect, reportCoverage, test } from "./live-room";

/** How long a projected menu must survive with nobody touching anything. */
const SURVIVE_MS = 20_000;
const SAMPLE_EVERY_MS = 250;

async function openTreeMenuAndWatch(
  wall: { page: import("@playwright/test").Page },
  callsign: string,
): Promise<{ survivedMs: number; visible: boolean }> {
  await wall.page.evaluate((id) => window.__VIBERSYN__?.select(id), callsign);
  const menu = wall.page.locator('[data-testid="tree-menu"]');
  await expect(menu, "the tree menu opened").toBeVisible({ timeout: 10_000 });

  const openedAtMs = Date.now();
  while (Date.now() - openedAtMs < SURVIVE_MS) {
    await wall.page.waitForTimeout(SAMPLE_EVERY_MS);
    if ((await menu.count()) === 0 || !(await menu.first().isVisible())) {
      return { survivedMs: Date.now() - openedAtMs, visible: false };
    }
  }
  return { survivedMs: Date.now() - openedAtMs, visible: true };
}

test("a tree menu on the projected wall URL stays open with nobody in the room", async ({ room, wall }) => {
  await reportCoverage(room, "popup-lifetime");
  await wall.open("/?wall=A&flat=1");
  const target = (await room.state()).processes[0]!;

  const result = await openTreeMenuAndWatch(wall, target.callsign);
  console.log(`[popup-lifetime] default ?remote — menu survived ${result.survivedMs}ms (visible=${result.visible})`);
  expect(result.visible, `the menu was still open after ${result.survivedMs}ms`).toBe(true);
});

test("control: the same menu with &remote=0", async ({ room, wall }) => {
  await wall.open("/?wall=A&flat=1&remote=0");
  const target = (await room.state()).processes[0]!;

  const result = await openTreeMenuAndWatch(wall, target.callsign);
  console.log(`[popup-lifetime] &remote=0 — menu survived ${result.survivedMs}ms (visible=${result.visible})`);
  expect(result.visible, `the menu was still open after ${result.survivedMs}ms`).toBe(true);
});
