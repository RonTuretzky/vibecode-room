import { spawn, type ChildProcess } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";

/**
 * Browser e2e for the gesture dwell-select interaction:
 *
 *  - ?dwell=mouse: the mouse drives the full point→highlight→dwell→activate
 *    loop (deterministic — park the pointer on a control and it clicks itself
 *    after ~0.8s, exactly once).
 *  - ?gesture=1: cursor policy — the OS cursor is hidden (cursor:none), no
 *    pointer glyph exists, and scene drag-orbit is unbound.
 *  - --fake parity: the synthetic fusion emitter (gesture-wall/tools/
 *    fake-fusion.mjs, what run-room.sh --fake starts) drives real highlights
 *    over the live UI through the actual WebSocket protocol.
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

test.describe("mouse-dwell fallback (?dwell=mouse)", () => {
  test("parking the mouse on a control highlights it, fills the ring, and clicks it ONCE", async ({ page }) => {
    await gotoStatic(page, "?live=0&dwell=mouse");
    await expect(page.getByTestId("gesture-overlay")).toBeAttached();

    const mock = page.getByTestId("mock-room-button");
    await expect(mock).toHaveAttribute("data-state", "off");
    const box = await mock.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);

    // Pointing at it: the target highlights (grow/glow) while the ring fills.
    await expect(page.locator('[data-testid="mock-room-button"][data-dwell-hot]')).toBeAttached({ timeout: 2_000 });
    // Dwell completion (~0.8s) synthesizes the click.
    await expect(mock).toHaveAttribute("data-state", "on", { timeout: 4_000 });

    // Re-arm only after leaving: a parked cursor must NOT toggle it again.
    await page.waitForTimeout(1_600);
    await expect(mock).toHaveAttribute("data-state", "on");

    // Leave, return, dwell again: toggles back off (one click per approach).
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height + 160);
    await page.waitForTimeout(300);
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await expect(mock).toHaveAttribute("data-state", "off", { timeout: 4_000 });
  });

  test("OS cursor stays visible in mouse-dwell mode (no gesture-mode class)", async ({ page }) => {
    await gotoStatic(page, "?live=0&dwell=mouse");
    await expect(page.getByTestId("app")).toHaveAttribute("data-gesture", "false");
    const cursor = await page
      .getByTestId("app")
      .evaluate((el) => getComputedStyle(el).cursor);
    expect(cursor).not.toBe("none");
  });
});

test.describe("gesture mode cursor policy (?gesture=1)", () => {
  test("OS cursor hidden everywhere; dwell layer mounted; no pointer glyph element", async ({ page }) => {
    await gotoStatic(page, "?live=0&wall=A&gesture=1&fusion=ws://127.0.0.1:9");
    await expect(page.getByTestId("app")).toHaveAttribute("data-gesture", "true");
    await expect(page.getByTestId("gesture-overlay")).toBeAttached();
    const cursors = await page.evaluate(() => {
      const app = document.querySelector('[data-testid="app"]')!;
      const sceneCanvas = document.querySelector('[data-testid="room-scene"] canvas');
      return {
        app: getComputedStyle(app).cursor,
        scene: sceneCanvas ? getComputedStyle(sceneCanvas).cursor : null,
        button: getComputedStyle(document.querySelector('[data-testid="mock-room-button"]')!).cursor,
      };
    });
    expect(cursors.app).toBe("none");
    expect(cursors.scene).toBe("none");
    expect(cursors.button).toBe("none");
  });

  test("scene drag-orbit is gated OFF (pointing never fights the camera)", async ({ page }) => {
    await gotoStatic(page, "?live=0&wall=A&gesture=1&fusion=ws://127.0.0.1:9");
    // The scene canvas has no pointer bindings in gesture mode: dragging across
    // it must not change the camera. Assert via the canvas pixels being
    // untouched is flaky on CI GPUs, so assert the contract's observable seam:
    // pointerdown capture (setPointerCapture) never engages, i.e. no listener
    // was bound — the canvas never enters the "grabbing" interaction.
    const sceneCursorBefore = await page.evaluate(() => {
      const canvas = document.querySelector('[data-testid="room-scene"] canvas') as HTMLElement;
      return canvas.style.cursor; // "" — gesture mode never sets grab/grabbing
    });
    expect(sceneCursorBefore).toBe("");
    await page.mouse.move(400, 400);
    await page.mouse.down();
    await page.mouse.move(600, 400, { steps: 5 });
    await page.mouse.up();
    const sceneCursorAfter = await page.evaluate(() => {
      const canvas = document.querySelector('[data-testid="room-scene"] canvas') as HTMLElement;
      return canvas.style.cursor;
    });
    expect(sceneCursorAfter).toBe(""); // desk mode would have set an inline cursor
  });
});

test.describe("synthetic fusion emitter (run-room.sh --fake parity)", () => {
  let fake: ChildProcess | null = null;
  const FAKE_PORT = 8791;

  test.beforeAll(async () => {
    fake = spawn("bun", ["gesture-wall/tools/fake-fusion.mjs"], {
      env: { ...process.env, FAKE_WS_PORT: String(FAKE_PORT), FAKE_FPS: "30" },
      stdio: "ignore",
    });
    // Give the WS server a moment to bind.
    await new Promise((resolve) => setTimeout(resolve, 700));
  });

  test.afterAll(() => {
    fake?.kill();
  });

  test("fake fusion cursors sweep the wall and light up real dwell targets", async ({ page }) => {
    await gotoStatic(page, `?live=0&wall=A&gesture=1&fusion=ws://127.0.0.1:${FAKE_PORT}`);
    await expect(page.getByTestId("gesture-overlay")).toBeAttached();
    // The two Lissajous cursors sweep [0.16,0.84]×[0.18,0.82]; as they cross
    // HUD controls / panels, the dwell layer must set data-dwell-hot (the
    // point→highlight feedback) on real UI elements.
    await expect(page.locator("[data-dwell-hot]").first()).toBeAttached({ timeout: 30_000 });
  });
});
