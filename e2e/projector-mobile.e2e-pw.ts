import { expect, test, type Page } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 } });

async function waitForHook(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean((window as any).__VIBERSYN__?.ready), null, {
    timeout: 15_000,
  });
}

test.describe("projector UI — mobile fleet layout", () => {
  test("keeps every process bubble fully visible in a narrow viewport", async ({ page }) => {
    await page.goto("/?live=0");
    await waitForHook(page);
    await expect(page.getByTestId("app")).toBeVisible();

    const callsigns = await page.evaluate(() =>
      (window as any).__VIBERSYN__.getSnapshot().processes.map((process: { callsign: string }) => process.callsign),
    );
    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();

    // Guard against a silent no-op: the demo fleet must actually render bubbles,
    // otherwise the loop below would vacuously pass on an empty board.
    expect(callsigns).toEqual(expect.arrayContaining(["Atlas", "Cobalt"]));

    for (const callsign of callsigns) {
      const bubble = page.locator(`[data-testid="bubble"][data-callsign="${callsign}"]`);
      await expect(bubble).toBeVisible();

      const box = await bubble.boundingBox();
      expect(box, `${callsign} bubble should have a bounding box`).not.toBeNull();
      expect(box!.x, `${callsign} left edge should be in viewport`).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width, `${callsign} right edge should be in viewport`).toBeLessThanOrEqual(
        viewport!.width,
      );
      expect(box!.y, `${callsign} top should be in viewport`).toBeGreaterThanOrEqual(0);
      expect(box!.y + box!.height, `${callsign} bottom should be in viewport`).toBeLessThanOrEqual(
        viewport!.height,
      );
    }
  });
});
