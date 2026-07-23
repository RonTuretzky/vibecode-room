import { expect, test, type Page } from "@playwright/test";

/**
 * Browser e2e for desk mode — the rebuild that made mouse + keyboard + voice the
 * primary control surface (gesture wall demoted to explicit opt-in):
 *
 *  - gesture decoupling: ?wall= alone is an identity badge, no gesture layer
 *  - per-wall scoping: the 3D scene stays FULL on every wall, but
 *    ?view=ideas|builds scopes the 2D surfaces + controls (wall A = idea
 *    surface + idea controls, wall B = build surface + build controls; the
 *    default full view renders everything)
 *  - the idea tray (explicit Build/Dismiss over the whole detection ledger)
 *  - the QR import overlay (phone → GitHub URL → fleet)
 *  - the extended keyboard map + help overlay + voice feedback flash
 *
 * Same conventions as projector.e2e-pw.ts: assert UI state via the DOM and the
 * `window.__VIBERSYN__` hook; `?live=0` pins the deterministic demo snapshot.
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

async function apply(page: Page, partial: Record<string, unknown>): Promise<void> {
  await page.evaluate((p) => (window as any).__VIBERSYN__.applySnapshot(p), partial);
}

test.describe("desk mode — gesture decoupling & wall identity", () => {
  test("?wall=A alone shows the identity badge and does NOT mount the gesture layer", async ({ page }) => {
    await gotoStatic(page, "?live=0&wall=A&view=ideas");
    await expect(page.getByTestId("wall-badge")).toHaveText("WALL A");
    await expect(page.getByTestId("gesture-overlay")).toHaveCount(0);
  });

  test("?gesture=1 explicitly re-enables the legacy gesture layer", async ({ page }) => {
    await gotoStatic(page, "?live=0&wall=B&gesture=1");
    await expect(page.getByTestId("gesture-overlay")).toBeAttached();
    await expect(page.getByTestId("wall-badge")).toHaveText("WALL B");
  });

  test("no wall/view params: no badge, no gesture layer (plain single window)", async ({ page }) => {
    await gotoStatic(page);
    await expect(page.getByTestId("wall-badge")).toHaveCount(0);
    await expect(page.getByTestId("gesture-overlay")).toHaveCount(0);
  });
});

test.describe("desk mode — per-wall scoping (each wall renders ITS surface + controls)", () => {
  test("?view=ideas (wall A): idea tray + idea controls, NO build surfaces", async ({ page }) => {
    await gotoStatic(page, "?live=0&wall=A&view=ideas");
    await expect(page.getByTestId("room-scene")).toBeVisible();
    await expect(page.getByTestId("idea-tray")).toBeVisible();
    await expect(page.locator('[data-region="suggestion"]')).toBeVisible();
    await expect(page.getByTestId("mic-capture-button")).toBeVisible();
    await expect(page.getByTestId("guided-demo-button")).toBeVisible();
    await expect(page.getByTestId("fleet-panel")).toHaveCount(0);
    await expect(page.locator('[data-region="transcript"]')).toHaveCount(0);
    await expect(page.getByTestId("qr-import-button")).toHaveCount(0);
  });

  test("?view=builds (wall B): fleet + build controls, NO idea surfaces", async ({ page }) => {
    await gotoStatic(page, "?live=0&wall=B&view=builds");
    await expect(page.getByTestId("room-scene")).toBeVisible();
    await expect(page.getByTestId("fleet-panel")).toHaveCount(2);
    await expect(page.locator('[data-region="transcript"]')).toBeVisible();
    await expect(page.getByTestId("qr-import-button")).toBeVisible();
    await expect(page.getByTestId("idea-tray")).toHaveCount(0);
    await expect(page.locator('[data-region="suggestion"]')).toHaveCount(0);
    await expect(page.getByTestId("mic-capture-button")).toHaveCount(0);
    await expect(page.getByTestId("guided-demo-button")).toHaveCount(0);
  });

  test("the 3D scene stays FULL on both walls (identical node counts; only 2D scopes)", async ({ page }) => {
    await gotoStatic(page, "?live=0&wall=A&view=ideas");
    const wallA = await page.getByTestId("room-scene").evaluate((el) => ({
      ideas: el.getAttribute("data-idea-count"),
      trees: el.getAttribute("data-tree-count"),
    }));
    await gotoStatic(page, "?live=0&wall=B&view=builds");
    const wallB = await page.getByTestId("room-scene").evaluate((el) => ({
      ideas: el.getAttribute("data-idea-count"),
      trees: el.getAttribute("data-tree-count"),
    }));
    expect(wallA).toEqual(wallB);
    expect(Number(wallA.ideas)).toBeGreaterThan(0);
    expect(Number(wallA.trees)).toBeGreaterThan(0);
  });
});

test.describe("desk mode — idea tray (offline demo)", () => {
  test("renders every demo candidate; forming cards carry no buttons", async ({ page }) => {
    await gotoStatic(page);
    await expect(page.getByTestId("idea-item")).toHaveCount(3);
    // Two ready candidates → two Build + two Dismiss buttons.
    await expect(page.getByTestId("idea-build-button")).toHaveCount(2);
    await expect(page.getByTestId("idea-dismiss-button")).toHaveCount(2);
    const forming = page.locator('[data-testid="idea-item"][data-status="forming"]');
    await expect(forming).toHaveCount(1);
    await expect(forming.locator("button")).toHaveCount(0);
  });

  test("Dismiss drops the card (offline demo keeps the tray interactive locally)", async ({ page }) => {
    await gotoStatic(page);
    await page.getByTestId("idea-dismiss-button").first().click();
    await expect(page.getByTestId("idea-item")).toHaveCount(2);
  });

  test("keyboard x dismisses the TOP ready idea", async ({ page }) => {
    await gotoStatic(page);
    await page.keyboard.press("x");
    await expect(page.getByTestId("idea-item")).toHaveCount(2);
    // The tray is ready-first; the top ready demo idea is the blocker announcer.
    await expect(page.locator('[data-idea-id="idea_blocker_announcer"]')).toHaveCount(0);
  });

  test("keys are ignored while typing in an input (no accidental dismiss)", async ({ page }) => {
    await gotoStatic(page);
    await page.evaluate(() => {
      const input = document.createElement("input");
      input.id = "e2e-typing-guard";
      document.body.appendChild(input);
      input.focus();
    });
    await page.keyboard.press("x");
    await expect(page.getByTestId("idea-item")).toHaveCount(3);
  });
});

test.describe("desk mode — overlays & keyboard map", () => {
  test("? opens the help overlay; Esc closes it", async ({ page }) => {
    await gotoStatic(page);
    await page.keyboard.press("?");
    await expect(page.getByTestId("help-overlay")).toBeVisible();
    await expect(page.getByTestId("help-keyboard")).toContainText("EMERGENCY STOP");
    await expect(page.getByTestId("help-voice")).toContainText("Vibersyn, build it");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("help-overlay")).toHaveCount(0);
  });

  test("q toggles the QR overlay; click-outside closes it", async ({ page }) => {
    await gotoStatic(page);
    await page.keyboard.press("q");
    await expect(page.getByTestId("qr-overlay")).toBeVisible();
    // Click the backdrop (far corner, outside the centered card).
    await page.getByTestId("qr-overlay").click({ position: { x: 8, y: 8 } });
    await expect(page.getByTestId("qr-overlay")).toHaveCount(0);
  });

  test("the QR Import button opens the overlay with the server's submit URL + QR image", async ({ page }) => {
    await gotoStatic(page);
    await page.getByTestId("qr-import-button").click();
    await expect(page.getByTestId("qr-overlay")).toBeVisible();
    // /api/import/info resolves against the real server; the QR renders client-side.
    await expect(page.getByTestId("qr-submit-url")).toContainText("/submit");
    await expect(page.getByTestId("qr-code-image")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("qr-overlay")).toHaveCount(0);
  });

  test("Shift+E triggers the emergency stop", async ({ page }) => {
    await gotoStatic(page);
    await expect(page.getByTestId("emergency-status")).toHaveAttribute("data-triggered", "false");
    await page.keyboard.press("Shift+E");
    await expect(page.getByTestId("emergency-status")).toHaveAttribute("data-triggered", "true");
  });

  test("a bare e (no shift) never triggers the emergency stop", async ({ page }) => {
    await gotoStatic(page);
    await page.keyboard.press("e");
    await expect(page.getByTestId("emergency-status")).toHaveAttribute("data-triggered", "false");
  });
});

test.describe("desk mode — voice feedback", () => {
  test("a changed snapshot.voice flashes the recognized command", async ({ page }) => {
    await gotoStatic(page);
    await expect(page.getByTestId("voice-flash")).toHaveCount(0);
    await apply(page, { voice: { lastCommand: "build", at: new Date().toISOString() } });
    const flash = page.getByTestId("voice-flash");
    await expect(flash).toBeVisible();
    await expect(flash).toContainText("build");
  });
});
