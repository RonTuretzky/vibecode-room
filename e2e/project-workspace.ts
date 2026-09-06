import { expect, type Page } from "@playwright/test";
export async function openProjectWork(
  page: Page,
  callsign: string,
): Promise<void> {
  const panel = page.locator("#project-workspace");
  if (!(await panel.isVisible())) {
    if (await page.getByTestId("control-dock-button").getAttribute("aria-expanded") !== "true")
      await page.getByTestId("control-dock-button").click();
    await page.getByRole("button", { name: /^Projects \(/ }).click();
  }
  await page.getByRole("textbox", { name: "Search projects" }).fill(callsign);
  await panel
    .locator(".project-row")
    .filter({ hasText: callsign })
    .first()
    .click();
  await expect(panel.locator(".project-detail")).toBeVisible();
}
