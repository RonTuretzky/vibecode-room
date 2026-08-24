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
    // The garden↔orbit scene toggle is the deterministic dwell target (same
    // choice as the gesture-dwell spec: always visible, flips both ways).
    await page.goto(`/?live=0&remote=1`);
    await waitForHook(page);
    await expect(page.getByTestId("gesture-overlay")).toBeAttached();
    // Dwell rides requestAnimationFrame — keep this page focused so parallel
    // workers' background throttling can't freeze the ring mid-fill.
    await page.bringToFront();

    const scene = page.getByTestId("room-scene");
    await expect(scene).toHaveAttribute("data-mode", "garden");
    const target = await normalizedCenter(page, "scene-mode-button");

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

      // The dwell fires the click (the highlight/ring semantics are pinned
      // by the mouse-dwell spec on this same pipeline).
      await expect(scene).toHaveAttribute("data-mode", "orbit", { timeout: 10_000 });

      // Hand leaves (stream stops → the wall evicts the cursor): no ghost
      // re-fire without a cursor. (The stricter parked-cursor re-arm rule is
      // covered by the mouse-dwell spec on the same pipeline; this target
      // MOVES when its label toggles, so a parked assertion would race reflow.)
      frames.stop();
      await page.waitForTimeout(1_400);
      await expect(scene).toHaveAttribute("data-mode", "orbit");

      // A fresh approach at the re-measured position toggles it back —
      // one click per approach, through the real relay both times.
      stream(await normalizedCenter(page, "scene-mode-button"));
      await expect(scene).toHaveAttribute("data-mode", "garden", { timeout: 10_000 });
    } finally {
      frames.stop();
      ws.close();
    }
  });

  test("full journey: a second browser page drives the wall through the /hands trackpad", async ({ page, context }) => {
    await page.goto(`/?live=0&remote=1`);
    await waitForHook(page);
    await page.bringToFront();
    const scene = page.getByTestId("room-scene");
    await expect(scene).toHaveAttribute("data-mode", "garden");
    const target = await normalizedCenter(page, "scene-mode-button");

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
    await expect(scene).toHaveAttribute("data-mode", "orbit", { timeout: 10_000 });
    await guest.mouse.up();
    // (The 🖐 Guests HUD button left the walls — live-room directive; the
    // always-on QR badge carries the invitation now, so the journey's proof
    // ends here: the pad genuinely drove the wall.)

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
