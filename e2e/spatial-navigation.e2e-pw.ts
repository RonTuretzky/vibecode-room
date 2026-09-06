import { expect, test, type Page } from "@playwright/test";
import WebSocket from "ws";

// Several hold/release cycles and a second browser are exercised per journey.
test.setTimeout(90_000);

async function pose(page: Page) {
  return page.getByTestId("room-scene").evaluate(el => {
    const d = (el as HTMLElement).dataset;
    return { x: Number(d.cameraX), y: Number(d.cameraY), z: Number(d.cameraZ), yaw: Number(d.cameraYaw), radius: Number(d.cameraRadius), active: d.navigationActive };
  });
}
async function ready(page: Page) {
  await page.goto("/?live=0&remote=1&env=meadow");
  await expect(page.getByTestId("room-scene")).toHaveAttribute("data-camera-x", /-?\d/);
}
async function stopped(page: Page) {
  await expect.poll(async () => (await pose(page)).active).toBe("false");
  // Account for the rig's existing ease-out, then verify no continued movement.
  await page.waitForTimeout(1000);
  const a = await pose(page);
  await page.waitForTimeout(1100);
  const b = await pose(page);
  expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeLessThan(.15);
  expect(Math.abs(a.yaw - b.yaw)).toBeLessThan(.01);
}

test("room controls consolidate actions and sustained dwell moves then stops on leaving", async ({ page }) => {
  await ready(page);
  await expect(page.getByTestId("plant-idea-button")).toBeHidden();
  await page.getByTestId("control-dock-button").click();
  await expect(page.getByTestId("control-dock-tray").getByTestId("plant-idea-button")).toBeVisible();
  await page.getByLabel("Dwell to move", { exact: true }).check();
  const start = await pose(page);
  await page.getByTestId("nav-w").hover();
  await expect.poll(async () => (await pose(page)).z).toBeLessThan(start.z - 1);
  await page.getByRole("heading", { name: "Explore", exact: true }).hover();
  await stopped(page);
  await page.getByTestId("help-button").click();
  await expect(page.getByTestId("help-overlay")).toBeVisible();
  await expect(page.getByTestId("control-dock-tray")).toBeHidden();
});

test("room look, zoom, keyboard and closing the dock all act on the real camera", async ({ page }) => {
  await ready(page);
  await page.getByTestId("control-dock-button").click();
  const look = page.getByTestId("nav-arrowleft");
  await look.focus();
  const start = await pose(page);
  await page.keyboard.down("Space");
  await expect.poll(async () => (await pose(page)).yaw).toBeGreaterThan(start.yaw + .15);
  await page.keyboard.up("Space");
  await stopped(page);
  const before = await pose(page);
  await page.getByRole("button", { name: "Zoom in", exact: true }).focus();
  await page.keyboard.down("Enter");
  await expect.poll(async () => (await pose(page)).radius).toBeLessThan(before.radius - .5);
  await page.keyboard.press("Escape");
  await page.keyboard.up("Enter");
  await expect(page.getByTestId("control-dock-tray")).toBeHidden();
  await stopped(page);
  const keyboardStart = await pose(page);
  await page.keyboard.down("ArrowRight");
  await expect.poll(async () => (await pose(page)).yaw).toBeLessThan(keyboardStart.yaw - .15);
  await page.keyboard.up("ArrowRight");
  await stopped(page);
  // Fit and fullscreen must not share a shortcut. A browser API spy avoids
  // platform-specific fullscreen support while exercising the real key path.
  await page.evaluate(() => {
    (window as any).__fullscreenRequests = 0;
    document.documentElement.requestFullscreen = async () => { (window as any).__fullscreenRequests++; };
  });
  await page.keyboard.press("f");
  expect(await page.evaluate(() => (window as any).__fullscreenRequests)).toBe(0);
  await page.keyboard.press("Shift+F");
  expect(await page.evaluate(() => (window as any).__fullscreenRequests)).toBe(1);
});

test("guest phone controls move, change angle, zoom, and release on disconnect", async ({ page, context }) => {
  await ready(page);
  const guest = await context.newPage();
  await guest.setViewportSize({ width: 390, height: 844 });
  await guest.goto("/hands");
  await expect(guest.getByTestId("guest-status")).toHaveAttribute("data-state", "live");
  for (const key of ["w", "arrowleft", "arrowup"]) {
    const control = guest.getByTestId(`guest-key-${key}`);
    const start = await pose(page);
    await control.scrollIntoViewIfNeeded();
    const rect = await control.boundingBox();
    expect(rect!.x).toBeGreaterThanOrEqual(0);
    expect(rect!.x + rect!.width).toBeLessThanOrEqual(390);
    await control.focus();
    await guest.keyboard.down("Space");
    await expect.poll(async () => {
      const current = await pose(page);
      return key === "arrowleft" ? current.yaw - start.yaw : key === "arrowup" ? current.y - start.y : start.z - current.z;
    }).toBeGreaterThan(.15);
    await guest.keyboard.up("Space");
    await stopped(page);
  }
  const zoom = await pose(page);
  await guest.getByRole("button", { name: "Zoom in", exact: true }).focus();
  await guest.keyboard.down("Enter");
  await expect.poll(async () => (await pose(page)).radius).toBeLessThan(zoom.radius - .5);
  await guest.close();
  await stopped(page);
});

test("guest mouse dwell and touch holds stop on leave or cancellation", async ({ page, context }) => {
  await ready(page);
  const guest = await context.newPage();
  await guest.goto("/hands");
  await expect(guest.getByTestId("guest-status")).toHaveAttribute("data-state", "live");
  await guest.getByLabel("Dwell to move", { exact: true }).check();
  const before = await pose(page);
  await guest.getByTestId("guest-key-d").hover();
  await expect.poll(async () => (await pose(page)).x).toBeGreaterThan(before.x + .5);
  await guest.getByRole("heading", { name: "Explore the room" }).hover();
  await stopped(page);
  const button = guest.getByTestId("guest-key-w");
  await button.scrollIntoViewIfNeeded();
  const box = await button.boundingBox();
  const cdp = await context.newCDPSession(guest);
  const touchStart = await pose(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }] });
  await expect.poll(async () => (await pose(page)).z).toBeLessThan(touchStart.z - .5);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
  await stopped(page);
  await cdp.detach();
  await guest.close();
});

test("fixed corner projector controls explicitly disable navigation", async ({ page }) => {
  await page.goto("/?live=0&gesture=1&wall=A&env=meadow");
  await page.getByTestId("control-dock-button").click();
  await expect(page.getByTestId("nav-w")).toBeDisabled();
});


test("a remote cursor dwells navigation continuously, then leaves and releases", async ({ page }) => {
  await ready(page);
  await page.getByTestId("control-dock-button").click();
  const button = await page.getByTestId("nav-arrowleft").boundingBox();
  const viewport = page.viewportSize()!;
  const ws = new WebSocket(`ws://127.0.0.1:${process.env.VIBERSYN_PORT ?? 8787}/hands/ws`);
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    await new Promise((resolve, reject) => { ws.once("message", resolve); ws.once("error", reject); });
    const start = await pose(page);
    timer = setInterval(() => ws.send(JSON.stringify({ type: "cursors", cursors: [{ id: 0,
      x: (button!.x + button!.width / 2) / viewport.width,
      y: (button!.y + button!.height / 2) / viewport.height, engaged: false }] })), 33);
    await expect.poll(async () => (await pose(page)).yaw).toBeGreaterThan(start.yaw + .15);
    const moving = await pose(page);
    await expect.poll(async () => (await pose(page)).yaw).toBeGreaterThan(moving.yaw + .2);
    clearInterval(timer);
    ws.send(JSON.stringify({ type: "cursors", cursors: [] }));
    await stopped(page);

    // A guest releasing W must not release a physical W held in the room.
    await page.keyboard.down("w");
    ws.send(JSON.stringify({ type: "keys", held: ["w"] }));
    await expect.poll(async () => (await pose(page)).active).toBe("true");
    ws.send(JSON.stringify({ type: "keys", held: [] }));
    await page.waitForTimeout(1200);
    expect((await pose(page)).active).toBe("true");
    await page.keyboard.up("w");
    await stopped(page);
  } finally { clearInterval(timer); ws.close(); await page.keyboard.up("w"); }
});
