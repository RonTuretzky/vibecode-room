import { expect, test, type Page } from "@playwright/test";

/**
 * Browser e2e for the Panopticon projector UI (the gorgeous bubble world).
 *
 * We assert UI STATE (DOM + the `window.__PANOPTICON__` hook), never screenshots.
 * `?live=0` disables the live /api connect so we can drive deterministic state
 * via `applySnapshot`; the live-data spec omits it to exercise the real server.
 */

async function waitForHook(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean((window as any).__PANOPTICON__?.ready), null, {
    timeout: 15_000,
  });
}

async function gotoStatic(page: Page): Promise<void> {
  await page.goto("/?live=0");
  await waitForHook(page);
  await expect(page.getByTestId("app")).toBeVisible();
}

async function apply(page: Page, partial: Record<string, unknown>): Promise<void> {
  await page.evaluate((p) => (window as any).__PANOPTICON__.applySnapshot(p), partial);
}

test.describe("projector UI — first paint & feature parity", () => {
  test("renders from the deterministic demo snapshot with no backend", async ({ page }) => {
    await gotoStatic(page);

    // Listening indicator (top-left, highest criticality).
    const listening = page.getByTestId("listening-indicator");
    await expect(listening).toBeVisible();
    await expect(listening).toHaveAttribute("data-state", "listening");

    // Emergency status (top-right) — calm/clear by default.
    await expect(page.getByTestId("emergency-status")).toHaveAttribute("data-triggered", "false");

    // Active cue (top-center).
    await expect(page.getByTestId("active-cue")).toBeVisible();

    // The bubble field with process bubbles for the demo fleet.
    await expect(page.getByTestId("bubble-field")).toBeVisible();
    await expect(page.locator('[data-testid="bubble"][data-callsign="Atlas"]')).toBeVisible();
    await expect(page.locator('[data-testid="bubble"][data-callsign="Cobalt"]')).toBeVisible();

    // Process bubbles carry their state semantics.
    await expect(page.locator('[data-testid="bubble"][data-callsign="Atlas"]')).toHaveAttribute(
      "data-kind",
      "process",
    );
  });

  test("shows at least one idea bubble (a pending suggestion)", async ({ page }) => {
    await gotoStatic(page);
    await expect(page.locator('[data-testid="bubble"][data-kind="idea"]').first()).toBeVisible();
  });

  test("renders the color-coded trace stream including route.action", async ({ page }) => {
    await gotoStatic(page);
    const rail = page.getByTestId("trace-rail");
    await expect(rail).toBeVisible();
    await expect(rail.locator('[data-testid="trace-event"]').first()).toBeVisible();
    await expect(rail.locator('[data-testid="trace-event"][data-event="route.action"]')).toHaveCount(1);
  });

  test("only operational controls present are emergency (always) and unmute (when muted)", async ({ page }) => {
    await gotoStatic(page);
    await expect(page.getByTestId("emergency-button")).toBeVisible();
    // Not muted at first paint → no unmute button.
    await expect(page.getByTestId("unmute-button")).toHaveCount(0);
  });
});

test.describe("projector UI — drill into a build", () => {
  test("clicking a bubble opens the build detail; Escape closes it", async ({ page }) => {
    await gotoStatic(page);

    await expect(page.getByTestId("build-detail")).toHaveCount(0);
    await page.locator('[data-testid="bubble"][data-callsign="Atlas"]').click({ force: true });

    const detail = page.getByTestId("build-detail");
    await expect(detail).toBeVisible();
    await expect(page.getByTestId("detail-callsign")).toContainText("Atlas");
    await expect(page.getByTestId("detail-action-log")).toBeVisible();
    await expect(page.getByTestId("detail-trace")).toBeVisible();

    // Selection is reflected on the bubble and via the hook.
    await expect(page.locator('[data-testid="bubble"][data-callsign="Atlas"]')).toHaveAttribute(
      "data-selected",
      "true",
    );
    expect(await page.evaluate(() => (window as any).__PANOPTICON__.getSelected())).toBe("Atlas");

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("build-detail")).toHaveCount(0);
  });

  test("programmatic select() via the hook opens the detail", async ({ page }) => {
    await gotoStatic(page);
    await page.evaluate(() => (window as any).__PANOPTICON__.select("Cobalt"));
    await expect(page.getByTestId("build-detail")).toBeVisible();
    await expect(page.getByTestId("detail-callsign")).toContainText("Cobalt");
  });
});

test.describe("projector UI — bounded safety controls", () => {
  test("mute state reveals the unmute control and flips the listening indicator", async ({ page }) => {
    await gotoStatic(page);

    await apply(page, { muted: true, listening: false });
    await expect(page.getByTestId("listening-indicator")).toHaveAttribute("data-state", "muted");

    const unmute = page.getByTestId("unmute-button");
    await expect(unmute).toBeVisible();
    await unmute.click();

    await expect(page.getByTestId("listening-indicator")).toHaveAttribute("data-state", "listening");
    await expect(page.getByTestId("unmute-button")).toHaveCount(0);
  });

  test("emergency kill-all flips the emergency status to triggered", async ({ page }) => {
    await gotoStatic(page);
    await expect(page.getByTestId("emergency-status")).toHaveAttribute("data-triggered", "false");

    await page.getByTestId("emergency-button").click();
    await expect(page.getByTestId("emergency-status")).toHaveAttribute("data-triggered", "true");
  });
});

test.describe("projector UI — live backend wiring", () => {
  test("pulls the fleet from the live /api/state + SSE (no demo override)", async ({ page }) => {
    // No ?live=0 → the app fetches /api/state and subscribes to /api/events.
    await page.goto("/");
    await waitForHook(page);
    await expect(page.getByTestId("app")).toBeVisible();
    // The server seeds the same deterministic demo, so the fleet must appear.
    await expect(page.locator('[data-testid="bubble"][data-callsign="Atlas"]')).toBeVisible();
    await expect(page.getByTestId("trace-rail")).toBeVisible();
  });
});
