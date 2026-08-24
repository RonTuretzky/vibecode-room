import { expect, test, type Page } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 } });

async function waitForHook(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean((window as any).__VIBERSYN__?.ready), null, {
    timeout: 15_000,
  });
}

test.describe("projector UI — mobile layout", () => {
  test("the 3D scene and every process's tree menu fit a narrow viewport without horizontal cutoff", async ({ page }) => {
    await page.goto("/?live=0");
    await waitForHook(page);
    await expect(page.getByTestId("app")).toBeVisible();

    // The full-viewport scene must be up (the canvas is the app background).
    await expect(page.getByTestId("room-scene").locator("canvas")).toBeVisible();

    const callsigns = await page.evaluate(() =>
      (window as any).__VIBERSYN__.getSnapshot().processes.map((process: { callsign: string }) => process.callsign),
    );
    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();

    // Guard against a silent no-op: the demo fleet must actually be there,
    // otherwise the loop below would vacuously pass on an empty board.
    expect(callsigns).toEqual(expect.arrayContaining(["Atlas", "Cobalt"]));

    // The per-process surface is the anchored tree menu now: open each one
    // and hold it to the viewport.
    for (const callsign of callsigns) {
      await page.evaluate((cs) => (window as any).__VIBERSYN__.select(cs), callsign);
      const menu = page.getByTestId("tree-menu");
      await expect(menu).toBeVisible();
      const box = await menu.boundingBox();
      expect(box, `${callsign} menu should have a bounding box`).not.toBeNull();
      expect(box!.x, `${callsign} left edge should be in viewport`).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width, `${callsign} right edge should be in viewport`).toBeLessThanOrEqual(
        viewport!.width,
      );
      await page.keyboard.press("Escape");
    }
  });
});
