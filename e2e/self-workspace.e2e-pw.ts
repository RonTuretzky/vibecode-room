import { expect, test } from "@playwright/test";
import { demoProjectorSnapshot } from "../src/ui/demo-data";

const mirror = { ...demoProjectorSnapshot.processes[0]!, upid: "self", callsign: "mirror",
  task: "Vibersyn Room", stage: "self", state: "planning", builds: [], execution: null, source: undefined };

test("self workspace targets branches, refreshes new branches, and exposes cancel/retry", async ({ page }) => {
  let branches = [{ name: "room/base", subject: "base" }];
  const calls: Array<{ url: string; body: any }> = [];
  await page.route("**/api/self/branches", route => route.fulfill({ json: { current: "room/base", branches } }));
  await page.route("**/api/process/self/*", async route => {
    calls.push({ url: route.request().url(), body: route.request().postDataJSON() });
    await route.fulfill({ json: {} });
  });
  await page.goto("/?live=0");
  await page.waitForFunction(() => (window as any).__VIBERSYN__?.ready);
  const apply = async (process = mirror as any, landing: any = null) => page.evaluate(({ process, landing }) =>
    (window as any).__VIBERSYN__.applySnapshot({ processes: [process], steerLanding: landing }), { process, landing });
  await apply();
  await page.getByRole("button", { name: "Projects (1)", exact: true }).click();
  await page.locator(".project-row").click();
  await expect(page.getByRole("heading", { name: "mirror: Ready to rebuild the room" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry project" })).toHaveCount(0);
  await page.getByRole("combobox", { name: "Change target" }).selectOption("room/base");
  await page.getByRole("textbox", { name: "Describe the change" }).fill("Change this branch");
  await page.getByRole("button", { name: "Apply change", exact: true }).click();
  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0]!.body).toMatchObject({ text: "Change this branch", branch: "room/base", grow: false });
  branches = [...branches, { name: "room/new", subject: "new" }];
  await apply({ ...mirror, execution: { status: "executing", label: "Validating: test", percent: 0 } },
    { upid: "self", branch: "room/new", onto: null, error: null, atMs: 123 });
  await expect(page.getByRole("combobox", { name: "Change target" }).locator('option').filter({ hasText: 'room/new' })).toHaveCount(1);
  await page.getByRole("button", { name: "Cancel work" }).click();
  await expect.poll(() => calls.at(-1)?.url).toContain("/self/cancel-work");
  await apply({ ...mirror, execution: { status: "failed", label: "aborted", error: "the self-run was aborted." } });
  await expect(page.getByRole("heading", { name: "mirror: Room change cancelled" })).toBeVisible();
  await page.getByRole("button", { name: "Retry project" }).click();
  await expect.poll(() => calls.at(-1)?.url).toContain("/self/retry");
});
