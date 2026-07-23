import { expect, test, type Page } from "@playwright/test";

/**
 * Browser e2e for the Vibersyn projector UI (the full-viewport 3D room).
 *
 * We assert UI STATE (DOM + the `window.__VIBERSYN__` hook), never screenshots.
 * `?live=0` disables the live /api connect so we can drive deterministic state
 * via `applySnapshot`; the live-data spec omits it to exercise the real server.
 *
 * The 2D bubble stage, trace rail, audio panel and emergency BUTTON are gone —
 * builds/ideas live in the 3D scene (room-scene), the fleet rail carries the
 * per-process panels, and the kill-all is the deliberate Shift+E chord.
 */

async function waitForHook(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean((window as any).__VIBERSYN__?.ready), null, {
    timeout: 15_000,
  });
}

async function gotoStatic(page: Page): Promise<void> {
  await page.goto("/?live=0");
  await waitForHook(page);
  await expect(page.getByTestId("app")).toBeVisible();
}

async function apply(page: Page, partial: Record<string, unknown>): Promise<void> {
  await page.evaluate((p) => (window as any).__VIBERSYN__.applySnapshot(p), partial);
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

    // The 3D scene renders the demo fleet as trees; the fleet rail carries a
    // panel per process with its state semantics.
    const scene = page.getByTestId("room-scene");
    await expect(scene).toBeVisible();
    await expect(scene).toHaveAttribute("data-tree-count", "2");
    await expect(page.locator('[data-testid="fleet-panel"][data-callsign="Atlas"]')).toBeVisible();
    await expect(page.locator('[data-testid="fleet-panel"][data-callsign="Cobalt"]')).toBeVisible();
    await expect(page.locator('[data-testid="fleet-panel"][data-callsign="Atlas"]')).toHaveAttribute(
      "data-state",
      "active",
    );
  });

  test("shows the 3D garden with at least one idea flower (a pending suggestion)", async ({ page }) => {
    await gotoStatic(page);
    const field = page.getByTestId("room-scene");
    await expect(field).toBeVisible();
    await expect(field).not.toHaveAttribute("data-idea-count", "0");
    await expect(field.locator("canvas")).toBeVisible();
  });

  test("status bar carries the desk-mode control row; unmute only appears when muted", async ({ page }) => {
    await gotoStatic(page);
    // Fixed order: mic · capture · auto-build · QR import · guided demo.
    await expect(page.getByTestId("mic-button")).toBeVisible();
    await expect(page.getByTestId("capture-button")).toBeVisible();
    await expect(page.getByTestId("auto-build-button")).toBeVisible();
    await expect(page.getByTestId("qr-import-button")).toBeVisible();
    await expect(page.getByTestId("guided-demo-button")).toBeVisible();
    // NO-MOCKS AUDIT: the Mock Room fixture toggle is hidden by default —
    // only ?mock=1 (VIBERSYN_MOCK_ROOM=1 via run-room.sh) exposes it.
    await expect(page.getByTestId("mock-room-button")).toHaveCount(0);
    // The emergency BUTTON is gone by design — Shift+E is the kill-all.
    await expect(page.getByTestId("emergency-button")).toHaveCount(0);
    // Not muted at first paint → no unmute button.
    await expect(page.getByTestId("unmute-button")).toHaveCount(0);
  });
});

test.describe("projector UI — drill into a build", () => {
  test("clicking a fleet panel opens the build detail; Escape closes it", async ({ page }) => {
    await gotoStatic(page);

    await expect(page.getByTestId("build-detail")).toHaveCount(0);
    await page.locator('[data-testid="fleet-panel"][data-callsign="Atlas"]').click();

    const detail = page.getByTestId("build-detail");
    await expect(detail).toBeVisible();
    await expect(page.getByTestId("detail-callsign")).toContainText("Atlas");
    await expect(page.getByTestId("detail-action-log")).toBeVisible();
    await expect(page.getByTestId("detail-trace")).toBeVisible();

    // Selection is reflected on the fleet panel and via the hook.
    await expect(page.locator('[data-testid="fleet-panel"][data-callsign="Atlas"]')).toHaveClass(/selected/);
    expect(await page.evaluate(() => (window as any).__VIBERSYN__.getSelected())).toBe("Atlas");

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("build-detail")).toHaveCount(0);
  });

  test("programmatic select() via the hook opens the detail", async ({ page }) => {
    await gotoStatic(page);
    await page.evaluate(() => (window as any).__VIBERSYN__.select("Cobalt"));
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

  test("Shift+E (the kill-all chord) flips the emergency status to triggered", async ({ page }) => {
    await gotoStatic(page);
    await expect(page.getByTestId("emergency-status")).toHaveAttribute("data-triggered", "false");

    await page.keyboard.press("Shift+E");
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
    await expect(page.locator('[data-testid="fleet-panel"][data-callsign="Atlas"]')).toBeVisible();
    await expect(page.getByTestId("room-scene")).toBeVisible();
  });

  test("a server-pushed snapshot re-renders the board over SSE (no reload)", async ({ page }) => {
    // The core live-observability guarantee: mutate server state out-of-band and
    // assert the page (loaded BEFORE the mutation) updates from the /api/events push.
    await page.goto("/");
    await waitForHook(page);
    const response = await page.request.post("/api/emergency-stop");
    expect(response.ok()).toBeTruthy();
    await expect(page.getByTestId("emergency-status")).toHaveAttribute("data-triggered", "true");
    // The server's kill-all also stops listening — a second field proves it's the pushed snapshot.
    await expect(page.getByTestId("listening-indicator")).toHaveAttribute("data-state", "muted");
  });
});

test.describe("projector UI — keyboard, a11y & detail completeness", () => {
  test("digit key (1) selects the first process (projector-friendly, no mouse)", async ({ page }) => {
    await gotoStatic(page);
    await page.keyboard.press("1");
    await expect(page.getByTestId("build-detail")).toBeVisible();
    await expect(page.getByTestId("detail-callsign")).toContainText("Atlas");
  });

  test("build detail shows the full build context", async ({ page }) => {
    await gotoStatic(page);
    await page.evaluate(() => (window as any).__VIBERSYN__.select("Atlas"));
    const detail = page.getByTestId("build-detail");
    await expect(detail).toBeVisible();
    await expect(page.getByTestId("detail-state")).toContainText("active");
    await expect(detail).toContainText("Codex gpt-5.5"); // model
    await expect(detail).toContainText("Blocker announcer"); // task
    await expect(detail).toContainText("upid_atlas_7f3"); // UPID
    await expect(detail).toContainText("smithers_run_9c12"); // runId
    await expect(page.getByTestId("detail-action-log").locator("li").first()).toBeVisible();
  });

  test("build detail is an accessible modal dialog", async ({ page }) => {
    await gotoStatic(page);
    await page.evaluate(() => (window as any).__VIBERSYN__.select("Atlas"));
    await expect(page.getByRole("dialog", { name: /Build detail for Atlas/ })).toBeVisible();
  });

  test("loads console-error-free on both the demo and live paths", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(`console: ${message.text()}`);
    });
    await page.goto("/?live=0");
    await waitForHook(page);
    await page.goto("/");
    await waitForHook(page);
    await expect(page.getByTestId("app")).toBeVisible();
    expect(errors, errors.join("\n")).toEqual([]);
  });
});

test.describe("projector UI — boundary fleet states", () => {
  test("zero processes: the scene stays up, the empty fleet slot shows", async ({ page }) => {
    await gotoStatic(page);
    await apply(page, { processes: [] });
    const scene = page.getByTestId("room-scene");
    await expect(scene).toBeVisible();
    await expect(scene).toHaveAttribute("data-tree-count", "0");
    await expect(page.getByTestId("fleet-empty")).toBeVisible();
  });

  test("single process: the 'No second process running' empty slot is shown (spec §9)", async ({ page }) => {
    await gotoStatic(page);
    await page.evaluate(() => {
      const snap = (window as any).__VIBERSYN__.getSnapshot();
      (window as any).__VIBERSYN__.applySnapshot({ processes: [snap.processes[0]] });
    });
    await expect(page.getByTestId("fleet-panel")).toHaveCount(1);
    const empty = page.getByTestId("fleet-empty");
    await expect(empty).toBeVisible();
    await expect(empty).toContainText("No second process running");
  });

  test("non-active process state renders with the correct data-state", async ({ page }) => {
    await gotoStatic(page);
    await page.evaluate(() => {
      const snap = (window as any).__VIBERSYN__.getSnapshot();
      const states = ["paused", "halted", "completed"];
      const processes = snap.processes.map((p: any, i: number) => ({ ...p, state: states[i] ?? p.state }));
      (window as any).__VIBERSYN__.applySnapshot({ processes });
    });
    await expect(page.locator('[data-testid="fleet-panel"][data-callsign="Atlas"]')).toHaveAttribute(
      "data-state",
      "paused",
    );
  });
});

test.describe("projector UI — 3D scene navigation & decks", () => {
  test("garden ↔ orbit toggle and layout cycle update the scene attributes", async ({ page }) => {
    await gotoStatic(page);
    const scene = page.getByTestId("room-scene");
    await expect(scene).toHaveAttribute("data-mode", "garden");
    await page.getByTestId("scene-mode-button").click();
    await expect(scene).toHaveAttribute("data-mode", "orbit");
    await expect(scene).toHaveAttribute("data-layout", "radial");
    await page.getByTestId("scene-layout-button").click();
    await expect(scene).toHaveAttribute("data-layout", "ball");
  });

  test("zen mode hides the chrome; Esc restores it", async ({ page }) => {
    await gotoStatic(page);
    await page.getByTestId("scene-zen-button").click();
    await expect(page.getByTestId("app")).toHaveAttribute("data-zen", "true");
    await expect(page.getByTestId("zen-hint")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("app")).toHaveAttribute("data-zen", "false");
  });

  test("mock room (opted in via ?mock=1) fills the scene with the busy fixture and back", async ({ page }) => {
    // The toggle only exists behind ?mock=1 (no-mocks audit).
    await page.goto("/?live=0&mock=1");
    await waitForHook(page);
    await expect(page.getByTestId("app")).toBeVisible();
    await page.getByTestId("mock-room-button").click();
    const scene = page.getByTestId("room-scene");
    await expect(scene).toHaveAttribute("data-tree-count", "5");
    // Every busy-fixture project ships an explainer deck for the scene click.
    const slideCounts = await page.evaluate(() =>
      (window as any).__VIBERSYN__.getSnapshot().processes.map((p: any) => p.slides?.length ?? 0),
    );
    expect(slideCounts.every((count: number) => count > 0)).toBe(true);
    await page.getByTestId("mock-room-button").click();
    await expect(scene).toHaveAttribute("data-tree-count", "2");
  });

  test("a process build with a real slideshowUrl gets a Deck button that opens the live deck", async ({ page }) => {
    await gotoStatic(page);
    await page.evaluate(() => {
      const snap = (window as any).__VIBERSYN__.getSnapshot();
      const processes = snap.processes.map((p: any, i: number) =>
        i === 0
          ? {
              ...p,
              builds: [
                {
                  backend: "native",
                  label: "Native",
                  status: "ready",
                  previewUrl: "http://127.0.0.1:4100/",
                  summary: null,
                  slideshowUrl: "/api/health",
                },
              ],
            }
          : p,
      );
      (window as any).__VIBERSYN__.applySnapshot({ processes });
    });
    const deckButton = page.getByTestId("process-deck-button");
    await expect(deckButton).toBeVisible();
    await deckButton.click();
    await expect(page.getByTestId("slideshow-overlay")).toBeVisible();
    await expect(page.getByTestId("slideshow-project")).toContainText("Blocker announcer");
    // The live slide embeds the generated deck with an open-in-window link.
    await expect(page.getByTestId("slideshow-live-frame")).toBeAttached();
    await expect(page.getByTestId("slideshow-open-live")).toBeVisible();
    // The deck HUD carries the per-backend build chips.
    await expect(page.getByTestId("slideshow-builds")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("slideshow-overlay")).toHaveCount(0);
  });
});
