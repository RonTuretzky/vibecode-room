import { expect, test, type Page } from "@playwright/test";

/**
 * Browser e2e for the Vibersyn projector UI (the gorgeous bubble world).
 *
 * We assert UI STATE (DOM + the `window.__VIBERSYN__` hook), never screenshots.
 * `?live=0` disables the live /api connect so we can drive deterministic state
 * via `applySnapshot`; the live-data spec omits it to exercise the real server.
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

  test("shows the 3D idea constellation with at least one orb (a pending suggestion)", async ({ page }) => {
    await gotoStatic(page);
    const field = page.getByTestId("idea-field-3d");
    await expect(field).toBeVisible();
    await expect(field).not.toHaveAttribute("data-orb-count", "0");
    await expect(field.locator("canvas")).toBeVisible();
  });

  test("renders the color-coded trace stream including route.action", async ({ page }) => {
    await gotoStatic(page);
    const rail = page.getByTestId("trace-rail");
    await expect(rail).toBeVisible();
    await expect(rail.locator('[data-testid="trace-event"]').first()).toBeVisible();
    await expect(rail.locator('[data-testid="trace-event"][data-event="route.action"]')).toHaveCount(1);
  });

  test("status bar carries the desk-mode control row; unmute only appears when muted", async ({ page }) => {
    await gotoStatic(page);
    // Fixed order: mic · capture · auto-build · QR import · emergency.
    await expect(page.getByTestId("mic-button")).toBeVisible();
    await expect(page.getByTestId("capture-button")).toBeVisible();
    await expect(page.getByTestId("auto-build-button")).toBeVisible();
    await expect(page.getByTestId("qr-import-button")).toBeVisible();
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
  test("digit key (1) selects the first process bubble (projector-friendly, no mouse)", async ({ page }) => {
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

  test("build detail is an accessible modal dialog; bubbles are labeled buttons", async ({ page }) => {
    await gotoStatic(page);
    await expect(page.getByRole("button", { name: /Atlas/ }).first()).toBeVisible();
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
  test("zero processes: field + idea bubble remain, no process bubbles, empty slot shows", async ({ page }) => {
    await gotoStatic(page);
    await apply(page, { processes: [] });
    await expect(page.getByTestId("bubble-field")).toBeVisible();
    await expect(page.locator('[data-testid="bubble"][data-kind="process"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="bubble"][data-kind="idea"]').first()).toBeVisible();
    await expect(page.getByTestId("fleet-empty")).toBeVisible();
  });

  test("single process: the 'No second process running' empty slot is shown (spec §9)", async ({ page }) => {
    await gotoStatic(page);
    await page.evaluate(() => {
      const snap = (window as any).__VIBERSYN__.getSnapshot();
      (window as any).__VIBERSYN__.applySnapshot({ processes: [snap.processes[0]] });
    });
    await expect(page.locator('[data-testid="bubble"][data-kind="process"]')).toHaveCount(1);
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
    await expect(page.locator('[data-testid="bubble"][data-callsign="Atlas"]')).toHaveAttribute(
      "data-state",
      "paused",
    );
  });
});

test.describe("projector UI — trace NEW pill (auto-scroll disabled)", () => {
  test("NEW pill appears when events arrive while scrolled up", async ({ page }) => {
    await gotoStatic(page);
    // Fill the trace so it overflows the rail card.
    await page.evaluate(() => {
      const trace = Array.from({ length: 80 }, (_unused, i) => ({
        level: "info",
        event: "observe.pass",
        sessionId: "e2e",
        correlationId: `c${i}`,
        meta: { i },
      }));
      (window as any).__VIBERSYN__.applySnapshot({ trace });
    });
    // Wait for React to commit all 80 rows so the rail genuinely overflows before we scroll.
    await expect(page.locator('[data-testid="trace-event"]')).toHaveCount(80);
    // Scroll the trace rail up (away from the bottom).
    await page.locator(".trace-scroll").evaluate((el) => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event("scroll"));
    });
    // Append a new event while scrolled up → the NEW pill must surface.
    await page.evaluate(() => {
      const snap = (window as any).__VIBERSYN__.getSnapshot();
      (window as any).__VIBERSYN__.applySnapshot({
        trace: [
          ...snap.trace,
          { level: "warn", event: "process.halt", sessionId: "e2e", correlationId: "cnew", meta: { trigger: "panic" } },
        ],
      });
    });
    await expect(page.getByTestId("new-events-pill")).toBeVisible();
  });
});
