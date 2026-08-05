import { expect, test, type Page } from "@playwright/test";
import WebSocket from "ws";

/**
 * Browser e2e for GUEST HANDS mode (?remote=1): people on the room LAN drive
 * the wall's dwell-to-click layer from their own computers via GET /hands.
 *
 *  - Wire-level: a guest WebSocket (the exact protocol the /hands page speaks)
 *    streams cursors into /hands/ws; the relay hub forwards them to the wall's
 *    /api/hands/room subscription; the wall's REAL dwell pipeline highlights
 *    and clicks the target — exactly once, with the re-arm-after-leave rule.
 *  - Full journey: a SECOND browser page opens /hands and press-holds the
 *    trackpad; the wall page clicks the aimed control. No fakes anywhere.
 */

const PORT = Number(process.env.VIBERSYN_PORT ?? 8787);

async function waitForHook(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean((window as any).__VIBERSYN__?.ready), null, {
    timeout: 15_000,
  });
}

// The wall-normalized center of a control on the wall page — what a guest
// cursor must aim at. Normalization is over the viewport, the same space the
// GestureLayer maps incoming cursors into.
async function normalizedCenter(page: Page, testId: string): Promise<{ x: number; y: number }> {
  const box = await page.getByTestId(testId).boundingBox();
  expect(box).not.toBeNull();
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  return {
    x: (box!.x + box!.width / 2) / viewport!.width,
    y: (box!.y + box!.height / 2) / viewport!.height,
  };
}

test.describe("guest hands (?remote=1)", () => {
  test("a guest WS cursor dwells a wall control: highlight, fire, and one click per approach", async ({ page }) => {
    // &mock=1 exposes the Mock Room toggle purely as a deterministic dwell
    // target (same trick as the gesture-dwell spec).
    await page.goto(`/?live=0&remote=1&mock=1`);
    await waitForHook(page);
    await expect(page.getByTestId("gesture-overlay")).toBeAttached();

    const mock = page.getByTestId("mock-room-button");
    await expect(mock).toHaveAttribute("data-state", "off");
    const target = await normalizedCenter(page, "mock-room-button");

    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/hands/ws`);
    const frames: { stop: () => void } = { stop: () => undefined };
    try {
      // The hub welcomes every guest with its reserved global cursor ids.
      const welcome = await new Promise<{ type: string; ids: number[] }>((resolve, reject) => {
        ws.once("message", (raw) => resolve(JSON.parse(String(raw))));
        ws.once("error", reject);
      });
      expect(welcome.type).toBe("welcome");
      // Guests live in the reserved NEGATIVE id block (disjoint from fusion
      // camera tracks, which are unbounded positives, and the mouse's -1).
      expect(welcome.ids[0]).toBeLessThanOrEqual(-1000);

      // Park an engaged guest cursor on the control at ~30 Hz (the wall evicts
      // cursors it has not heard from in 0.5s, so streaming is the contract).
      const stream = (point: { x: number; y: number }) => {
        const timer = setInterval(() => {
          ws.send(JSON.stringify({ type: "cursors", cursors: [{ id: 0, x: point.x, y: point.y, engaged: true }] }));
        }, 33);
        frames.stop = () => clearInterval(timer);
      };
      stream(target);

      // Pointing at it: highlight + filling ring, then the dwell fires the click.
      await expect(page.locator('[data-testid="mock-room-button"][data-dwell-hot]')).toBeAttached({ timeout: 3_000 });
      await expect(mock).toHaveAttribute("data-state", "on", { timeout: 4_000 });

      // Hand leaves (stream stops → the wall evicts the cursor): no ghost
      // re-fire without a cursor. (The stricter parked-cursor re-arm rule is
      // covered by the mouse-dwell spec on the same pipeline; this target
      // MOVES when its label toggles, so a parked assertion would race reflow.)
      frames.stop();
      await page.waitForTimeout(1_400);
      await expect(mock).toHaveAttribute("data-state", "on");

      // A fresh approach at the re-measured position toggles it back off —
      // one click per approach, through the real relay both times.
      stream(await normalizedCenter(page, "mock-room-button"));
      await expect(mock).toHaveAttribute("data-state", "off", { timeout: 4_000 });
    } finally {
      frames.stop();
      ws.close();
    }
  });

  test("full journey: a second browser page drives the wall through the /hands trackpad", async ({ page, context }) => {
    await page.goto(`/?live=0&remote=1&mock=1`);
    await waitForHook(page);
    const mock = page.getByTestId("mock-room-button");
    await expect(mock).toHaveAttribute("data-state", "off");
    const target = await normalizedCenter(page, "mock-room-button");

    // The guest opens /hands on "their computer" (a second page here). The
    // trackpad is the zero-permission default mode.
    const guest = await context.newPage();
    await guest.goto(`http://127.0.0.1:${PORT}/hands`);
    await expect(guest.getByTestId("guest-status")).toHaveAttribute("data-state", "live", { timeout: 10_000 });
    // A wall IS listening (the wall page above), so the no-wall banner is hidden.
    await expect(guest.getByTestId("guest-no-wall")).toBeHidden();

    // Press-and-hold the pad at the spot that maps onto the wall control. The
    // pad is the wall (1:1 normalized mapping), so the wall-normalized center
    // converts straight into pad pixels.
    const pad = await guest.getByTestId("guest-pad").boundingBox();
    expect(pad).not.toBeNull();
    const padX = pad!.x + target.x * pad!.width;
    const padY = pad!.y + target.y * pad!.height;
    await guest.mouse.move(padX, padY);
    await guest.mouse.down();

    // Holding still on the pad dwells the wall control until it clicks.
    await expect(page.locator('[data-testid="mock-room-button"][data-dwell-hot]')).toBeAttached({ timeout: 3_000 });
    await expect(mock).toHaveAttribute("data-state", "on", { timeout: 4_000 });
    await guest.mouse.up();

    // The wall's Guests overlay reports the live connection: open it via its
    // HUD button and read the URL + count off the real DOM.
    await page.getByTestId("guest-hands-button").click();
    await expect(page.getByTestId("guest-hands-overlay")).toBeVisible();
    await expect(page.getByTestId("guest-hands-url")).toContainText("/hands");
    await expect(page.getByTestId("guest-hands-count")).toContainText("1 guest", { timeout: 8_000 });

    await guest.close();
  });

  test("the guest page's WASD buttons replay as the wall's own key events (and release on silence)", async ({ page }) => {
    await page.goto(`/?live=0&remote=1`);
    await waitForHook(page);
    await expect(page.getByTestId("gesture-overlay")).toBeAttached();
    // Observe the synthetic window key events the relay must produce — the
    // exact events RoomScene's fly-through consumes.
    await page.evaluate(() => {
      const seen: string[] = [];
      (window as any).__KEYS__ = seen;
      window.addEventListener("keydown", (event) => seen.push(`down:${event.key}`));
      window.addEventListener("keyup", (event) => seen.push(`up:${event.key}`));
    });

    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/hands/ws`);
    try {
      await new Promise((resolve, reject) => {
        ws.once("message", resolve);
        ws.once("error", reject);
      });
      // Hold W+D (heartbeat like the page does), then go silent: the wall must
      // press both, then auto-release both within the 1.5s stale window.
      const timer = setInterval(() => ws.send(JSON.stringify({ type: "keys", held: ["w", "d"] })), 250);
      await expect
        .poll(async () => page.evaluate(() => (window as any).__KEYS__ as string[]), { timeout: 4_000 })
        .toEqual(expect.arrayContaining(["down:w", "down:d"]));
      clearInterval(timer);
      await expect
        .poll(async () => page.evaluate(() => (window as any).__KEYS__ as string[]), { timeout: 4_000 })
        .toEqual(expect.arrayContaining(["up:w", "up:d"]));
    } finally {
      ws.close();
    }
  });

  test("GET /hands serves the self-contained guest page", async ({ request }) => {
    const response = await request.get(`http://127.0.0.1:${PORT}/hands`);
    expect(response.status()).toBe(200);
    const html = await response.text();
    expect(html).toContain("guest-pad");
    expect(html).toContain("/hands/ws");
  });
});
