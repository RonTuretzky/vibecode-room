import { expect, test, type Page } from "@playwright/test";

/**
 * Browser e2e for the Vibersyn projector UI (the full-viewport 3D room).
 *
 * We assert UI STATE (DOM + the `window.__VIBERSYN__` hook), never screenshots.
 * `?live=0` disables the live /api connect so we can drive deterministic state
 * via `applySnapshot`; the live-data spec omits it to exercise the real server.
 *
 * The 2D bubble stage, trace rail, audio panel, emergency BUTTON and the
 * fleet rail are all gone — builds/ideas live in the 3D scene (room-scene),
 * each process's surface is the anchored per-tree menu (select a tree), the
 * routine controls fold behind the ⚙ Controls dock, and the kill-all is the
 * deliberate Shift+E chord.
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

    // The 3D scene renders the demo fleet as trees (the 2D fleet rail is
    // gone); selecting a process surfaces its anchored tree menu with the
    // state semantics.
    const scene = page.getByTestId("room-scene");
    await expect(scene).toBeVisible();
    await expect(scene).toHaveAttribute("data-tree-count", "2");
    await page.evaluate(() => (window as any).__VIBERSYN__.select("Atlas"));
    await expect(page.getByTestId("tree-menu-callsign")).toContainText("Atlas");
    await expect(page.getByTestId("tree-menu-status")).toHaveClass(/state-active/);
  });

  test("shows the 3D garden with at least one idea flower (a pending suggestion)", async ({ page }) => {
    await gotoStatic(page);
    const field = page.getByTestId("room-scene");
    await expect(field).toBeVisible();
    await expect(field).not.toHaveAttribute("data-idea-count", "0");
    await expect(field.locator("canvas")).toBeVisible();
  });

  test("routine controls fold behind the ⚙ dock; one click unfolds them", async ({ page }) => {
    await gotoStatic(page);
    // Folded at boot: the tray's children exist in the DOM but stay hidden.
    await expect(page.getByTestId("control-dock")).toHaveAttribute("data-expanded", "false");
    await expect(page.getByTestId("mic-capture-button")).toBeHidden();
    await page.getByTestId("control-dock-button").click();
    await expect(page.getByTestId("control-dock")).toHaveAttribute("data-expanded", "true");
    await expect(page.getByTestId("mic-capture-button")).toBeVisible();
    await expect(page.getByTestId("guided-demo-button")).toBeVisible();
    await expect(page.getByTestId("central-park-button")).toBeVisible();
    // Gone by design: the separate auto-build and QR buttons (voice + the q
    // key carry those verbs), the emergency button (Shift+E), and — NO-MOCKS
    // AUDIT — the Mock Room toggle without ?mock=1.
    await expect(page.getByTestId("auto-build-button")).toHaveCount(0);
    await expect(page.getByTestId("qr-import-button")).toHaveCount(0);
    await expect(page.getByTestId("mock-room-button")).toHaveCount(0);
    await expect(page.getByTestId("emergency-button")).toHaveCount(0);
    // Not muted at first paint → no unmute button.
    await expect(page.getByTestId("unmute-button")).toHaveCount(0);
  });
});

test.describe("projector UI — drill into a build (the anchored tree menu)", () => {
  test("selecting a process opens its tree menu; Escape closes it", async ({ page }) => {
    await gotoStatic(page);

    await expect(page.getByTestId("tree-menu")).toHaveCount(0);
    // Digit keys select processes (projector-friendly; scene clicks route the
    // same way through the pick seam).
    await page.keyboard.press("1");

    const menu = page.getByTestId("tree-menu");
    await expect(menu).toBeVisible();
    await expect(page.getByTestId("tree-menu-callsign")).toContainText("Atlas");
    expect(await page.evaluate(() => (window as any).__VIBERSYN__.getSelected())).toBe("Atlas");

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("tree-menu")).toHaveCount(0);
  });

  test("programmatic select() via the hook opens the tree menu", async ({ page }) => {
    await gotoStatic(page);
    await page.evaluate(() => (window as any).__VIBERSYN__.select("Cobalt"));
    await expect(page.getByTestId("tree-menu")).toBeVisible();
    await expect(page.getByTestId("tree-menu-callsign")).toContainText("Cobalt");
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

    // Unmuted again — on the offline page the mic itself is not running, so
    // the orb reports deaf (unmuted, no live mic) rather than listening.
    await expect(page.getByTestId("listening-indicator")).not.toHaveAttribute("data-state", "muted");
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
    // The server seeds the same deterministic demo (plus whatever pinned
    // imports it adopts at boot), so the demo fleet must be in the live
    // snapshot and standing as trees.
    await expect
      .poll(async () =>
        page.evaluate(() => (window as any).__VIBERSYN__.getSnapshot().processes.map((p: any) => p.callsign)),
      )
      .toEqual(expect.arrayContaining(["Atlas", "Cobalt"]));
    const scene = page.getByTestId("room-scene");
    await expect(scene).toBeVisible();
    await expect(scene).not.toHaveAttribute("data-tree-count", "0");
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
    await expect(page.getByTestId("tree-menu")).toBeVisible();
    await expect(page.getByTestId("tree-menu-callsign")).toContainText("Atlas");
  });

  test("the tree menu shows the process context", async ({ page }) => {
    await gotoStatic(page);
    await page.evaluate(() => (window as any).__VIBERSYN__.select("Atlas"));
    const menu = page.getByTestId("tree-menu");
    await expect(menu).toBeVisible();
    // Identity plate: inferred title + callsign + status; the UPID rides the
    // menu's own data contract; steering is right there.
    await expect(page.getByTestId("tree-menu-title")).toContainText("Blocker announcer");
    await expect(page.getByTestId("tree-menu-callsign")).toContainText("Atlas");
    await expect(page.getByTestId("tree-menu-status")).toHaveClass(/state-active/);
    await expect(menu).toHaveAttribute("data-upid", "upid_atlas_7f3");
    // Local concept trees do not offer a Git branch recording action.
    await expect(page.getByTestId("tree-menu-grow")).toHaveCount(0);
  });

  test("an adopted repository exposes branch recording on its grow control", async ({ page }) => {
    await gotoStatic(page);
    await page.evaluate(() => {
      const room = (window as any).__VIBERSYN__;
      const snap = room.getSnapshot();
      room.applySnapshot({ processes: snap.processes.map((p: any, i: number) => i === 0 ? {
        ...p, treeRepo: { adopted: true, remoteUrl: "https://github.com/example/demo", branches: [] },
      } : p) });
      room.select("Atlas");
    });
    await expect(page.getByTestId("tree-menu-grow")).toBeVisible();
    await expect(page.getByTestId("tree-menu-grow")).toBeEnabled();
  });

  test("the tree menu is an accessible dialog", async ({ page }) => {
    await gotoStatic(page);
    await page.evaluate(() => (window as any).__VIBERSYN__.select("Atlas"));
    await expect(page.getByRole("dialog", { name: /Tree controls for Atlas/ })).toBeVisible();
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
  });

  test("single process: one tree stands, and it is selectable", async ({ page }) => {
    await gotoStatic(page);
    await page.evaluate(() => {
      const snap = (window as any).__VIBERSYN__.getSnapshot();
      (window as any).__VIBERSYN__.applySnapshot({ processes: [snap.processes[0]] });
    });
    await expect(page.getByTestId("room-scene")).toHaveAttribute("data-tree-count", "1");
    await page.keyboard.press("1");
    await expect(page.getByTestId("tree-menu-callsign")).toContainText("Atlas");
  });

  test("non-active process state renders with the correct data-state", async ({ page }) => {
    await gotoStatic(page);
    await page.evaluate(() => {
      const snap = (window as any).__VIBERSYN__.getSnapshot();
      const states = ["paused", "halted", "completed"];
      const processes = snap.processes.map((p: any, i: number) => ({ ...p, state: states[i] ?? p.state }));
      (window as any).__VIBERSYN__.applySnapshot({ processes });
    });
    await page.evaluate(() => (window as any).__VIBERSYN__.select("Atlas"));
    await expect(page.getByTestId("tree-menu-status")).toHaveClass(/state-paused/);
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
    // The toggle folds inside the ⚙ Controls dock.
    await page.getByTestId("control-dock-button").click();
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
              slides: [], // A real generated deck has no fixture slides.
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
    await page.evaluate(() => (window as any).__VIBERSYN__.select("Atlas"));
    await expect(page.getByTestId("tree-menu-deck")).toBeVisible();
    await page.getByTestId("tree-menu-deck").click();
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
