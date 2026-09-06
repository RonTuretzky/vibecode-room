import { test, expect } from "@playwright/test";

test("phone workspace actions fit and the import dialog contains keyboard focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?live=0&remote=0");
  await page.getByTestId("control-dock-button").click();
  const navigation = await page.getByRole("navigation", { name: "Room actions" }).boundingBox();
  expect(navigation!.x).toBeGreaterThanOrEqual(0);
  expect(navigation!.x + navigation!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: ".context/phone-navigation.png", animations: "disabled" });
  for (const button of await page
    .getByTestId("scene-controls")
    .getByRole("button")
    .all()) {
    const box = await button.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  }
  await page.getByRole("button", { name: "🌱 Plant an idea", exact: true }).click();
  const input = page.getByRole("textbox", {
    name: "What would you like to do?",
  });
  await expect(input).toBeFocused();
  await input.press("Shift+Tab");
  await expect(
    page.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();
  const dialog = page.getByRole("dialog", { name: "Plant an idea" });
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(box!.y + box!.height).toBeLessThanOrEqual(844);
  await page.screenshot({
    path: ".context/phone-workspace.png",
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByTestId("control-dock-button"),
  ).toBeFocused();
});
