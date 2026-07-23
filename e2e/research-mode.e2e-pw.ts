import { expect, test, type Page } from "@playwright/test";

/**
 * Browser e2e for RESEARCH MODE — the dialogue-tree + research-quest surface:
 *
 *  - the mode toggle (status-bar button + `r`) and its snapshot round-trip
 *  - the research tray: proposed quests carry Research/Dismiss, a researching
 *    quest shows live progress, a complete quest offers the dossier
 *  - the 3D scene mounts the dialogue helix + research crystals (asserted via
 *    the scene's data-dialogue-count / data-research-count contract)
 *  - the dossier overlay opens/closes (offline fixture: deckUrl is null, so
 *    the explicit "not available" notice shows instead of an iframe)
 *
 * Same conventions as desk-mode.e2e-pw.ts: `?live=0` pins the deterministic
 * demo snapshot (which boots with researchMode ON and three fixture quests).
 */

async function waitForHook(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean((window as any).__VIBERSYN__?.ready), null, {
    timeout: 15_000,
  });
}

async function gotoStatic(page: Page, query = "?live=0"): Promise<void> {
  await page.goto(`/${query}`);
  await waitForHook(page);
  await expect(page.getByTestId("app")).toBeVisible();
}

test.describe("research mode — toggle + tray", () => {
  test("demo boots with research ON: toggle button lit, tray shows all three lifecycle stages", async ({ page }) => {
    await gotoStatic(page);
    await expect(page.getByTestId("research-mode-button")).toHaveAttribute("data-state", "on");
    const tray = page.getByTestId("research-tray");
    await expect(tray).toBeVisible();
    const items = page.getByTestId("research-item");
    await expect(items).toHaveCount(3);
    // Loop order contract: researching first, then proposed, then complete.
    await expect(items.nth(0)).toHaveAttribute("data-status", "researching");
    await expect(page.getByTestId("research-progress")).toBeVisible();
    await expect(page.locator('[data-testid="research-item"][data-status="complete"]')).toHaveCount(1);
    await expect(page.getByTestId("research-result")).toContainText("4 sources");
  });

  test("the r key toggles research mode off (tray unmounts) and back on", async ({ page }) => {
    await gotoStatic(page);
    await page.keyboard.press("r");
    await expect(page.getByTestId("research-mode-button")).toHaveAttribute("data-state", "off");
    await expect(page.getByTestId("research-tray")).toHaveCount(0);
    await page.keyboard.press("r");
    await expect(page.getByTestId("research-tray")).toBeVisible();
  });

  test("accepting a proposed quest flips it to researching (offline demo keeps the tray interactive)", async ({ page }) => {
    await gotoStatic(page);
    const proposed = page.locator('[data-testid="research-item"][data-status="proposed"]');
    await expect(proposed).toHaveCount(1);
    await proposed.getByTestId("research-accept-button").click();
    await expect(page.locator('[data-testid="research-item"][data-status="proposed"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="research-item"][data-status="researching"]')).toHaveCount(2);
  });

  test("dismissing a quest drops its card locally", async ({ page }) => {
    await gotoStatic(page);
    await expect(page.getByTestId("research-item")).toHaveCount(3);
    await page.getByTestId("research-dismiss-button").first().click();
    await expect(page.getByTestId("research-item")).toHaveCount(2);
  });
});

test.describe("research mode — 3D dialogue tree", () => {
  test("the scene mounts the dialogue helix + research crystals (data-* contract)", async ({ page }) => {
    await gotoStatic(page);
    const scene = page.getByTestId("room-scene");
    await expect(scene).toHaveAttribute("data-dialogue-count", "5");
    await expect(scene).toHaveAttribute("data-research-count", "3");
  });

  test("toggling the mode off empties the scene's research surfaces", async ({ page }) => {
    await gotoStatic(page);
    // The demo fixture keeps quests alive, so crystals persist after toggle-off
    // (a finished dossier stays visitable); clearing the quests empties both.
    await page.evaluate(() => (window as any).__VIBERSYN__.applySnapshot({ researchMode: false, research: [] }));
    const scene = page.getByTestId("room-scene");
    await expect(scene).toHaveAttribute("data-dialogue-count", "0");
    await expect(scene).toHaveAttribute("data-research-count", "0");
  });
});

test.describe("research mode — dossier overlay", () => {
  test("Dossier ▸ opens the overlay; offline fixture shows the explicit no-deck notice; Esc closes", async ({ page }) => {
    await gotoStatic(page);
    await page.getByTestId("research-deck-button").click();
    await expect(page.getByTestId("research-deck-overlay")).toBeVisible();
    await expect(page.getByTestId("research-deck-missing")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("research-deck-overlay")).toHaveCount(0);
  });
});
