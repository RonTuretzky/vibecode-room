import { expect, test } from "@playwright/test";

test("park views cycle, Fit returns to projects, and environment switches stay usable", async ({ page }) => {
  await page.goto("/?live=0&env=park");
  const view = page.getByTestId("park-view-button");
  const scene = page.getByTestId("room-scene");
  await expect(view).toContainText("The Pond");
  for (const label of ["The Pond", "Park overlook", "Wollman Rink", "Project lawn"]) {
    await view.click();
    await expect(scene).toHaveAttribute("data-park-view", label);
  }
  await page.getByTestId("scene-fit-button").click();
  await page.getByTestId("scene-mode-button").click();
  await expect(view).toHaveCount(0);
  await page.getByTestId("scene-mode-button").click();
  await expect(view).toBeVisible();
  await page.getByTestId("control-dock-button").click();
  await page.getByTestId("central-park-button").click();
  await expect(view).toHaveCount(0);
  await page.getByTestId("central-park-button").click();
  await expect(view).toBeVisible();
  await page.getByTestId("control-dock-button").click();
  await page.keyboard.press("1");
  await expect(page.getByTestId("tree-menu")).toBeVisible();
});

test("park camera exploration is unavailable on locked projector walls", async ({ page }) => {
  await page.goto("/?live=0&env=park&flat=1&wall=a");
  await expect(page.getByTestId("scene-fit-button")).toBeDisabled();
  await expect(page.getByTestId("park-view-button")).toHaveCount(0);
});

test("park controls fit a narrow browser and remain usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?live=0&env=park");
  const view = page.getByTestId("park-view-button");
  await expect(view).toBeVisible();
  const box = await page.getByTestId("scene-controls").boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await view.click();
  await expect(page.getByTestId("room-scene")).toHaveAttribute("data-park-view", "The Pond");
  await page.getByTestId("scene-zen-button").click();
  await expect(page.getByTestId("scene-controls")).toHaveCSS("opacity", "0");
  await expect(page.getByTestId("scene-controls")).toHaveCSS("pointer-events", "none");
  for (const selector of [".wall-clock", ".status-bar"]) {
    await expect(page.locator(selector)).toHaveCSS("opacity", "0");
    await expect(page.locator(selector)).toHaveCSS("pointer-events", "none");
  }
  // Some browser/OS combinations do not expose fullscreen at all.
  await expect(page.locator(".fullscreen-button")).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(view).toBeVisible();
  await expect(page.getByTestId("control-dock")).toHaveCSS("opacity", "1");
});
