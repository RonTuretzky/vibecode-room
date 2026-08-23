import { expect, test, type Page } from "@playwright/test";

/**
 * Browser e2e for the GUIDED DEMO — the coached visitor walkthrough of the
 * KICKOFF/IDEA phase (rescoped: the demo ends at the deck's "How should we
 * continue?" decision; commissioning is an epilogue, never waited on).
 *
 * Runs the REAL mechanics end-to-end in ?dwell=mouse mode (the documented
 * camera-free path: the mouse drives the same point→highlight→dwell→activate
 * loop as the gesture wall):
 *   step 1 orientation — dwell-pops all three practice orbs;
 *   step 2 record      — dwell-selects the big Record button (offline demo
 *                        applies unmute+capture locally; live POSTs the API);
 *   steps 3–5          — driven by snapshot changes through the same window
 *                        hook the other specs use, asserting the machine's
 *                        advance conditions (new process → mock lanes race →
 *                        first mock ready → auto-opened deck with the
 *                        decision bar; any decision completes the demo).
 */

async function waitForHook(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean((window as any).__VIBERSYN__?.ready), null, {
    timeout: 15_000,
  });
}

async function apply(page: Page, partial: Record<string, unknown>): Promise<void> {
  await page.evaluate((p) => (window as any).__VIBERSYN__.applySnapshot(p), partial);
}

async function dwell(page: Page, testId: string): Promise<void> {
  const target = page.getByTestId(testId).first();
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
}

// Park the mouse away from any dwell target so re-approaches re-arm.
async function parkMouse(page: Page): Promise<void> {
  await page.mouse.move(8, Math.round((await page.viewportSize())!.height * 0.85));
  await page.waitForTimeout(250);
}

test.describe("guided demo — coached flow with mouse-dwell", () => {
  test("orbs → record → idea → mock race → first-ready opens the deck; a decision finishes", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/?live=0&demo=guided&dwell=mouse");
    await waitForHook(page);

    // STEP 1: three practice orbs; dwell-pop each one.
    const demo = page.getByTestId("guided-demo");
    await expect(demo).toHaveAttribute("data-step", "orientation");
    await expect(page.getByTestId("practice-orb")).toHaveCount(3);
    for (let i = 0; i < 3; i += 1) {
      await parkMouse(page);
      await dwell(page, "practice-orb");
      // Dwell (~0.8s) pops the orb (its button leaves the DOM).
      await expect(page.getByTestId("practice-orb")).toHaveCount(3 - i - 1, { timeout: 6_000 });
    }
    await expect(demo).toHaveAttribute("data-step", "record", { timeout: 4_000 });

    // STEP 2: dwell the big Record button → the room really flips to
    // unmuted + capturing (offline demo applies it locally). The step then
    // completes only once the room has HEARD the visitor — a browser mic
    // cannot start under Playwright, so feed one fresh spoken line through
    // the same snapshot hook the real ASR path publishes on.
    await parkMouse(page);
    await dwell(page, "guided-record-button");
    await page.waitForFunction(() => {
      const snap = (window as any).__VIBERSYN__.getSnapshot();
      return snap.muted === false && snap.captureMode === true;
    });
    await page.evaluate(() => {
      const snap = (window as any).__VIBERSYN__.getSnapshot();
      (window as any).__VIBERSYN__.applySnapshot({
        transcript: [
          ...snap.transcript,
          { time: "00:00:01", speaker: "Room", text: "let us build a garden kiosk", kind: "room" },
        ],
      });
    });
    await expect(demo).toHaveAttribute("data-step", "idea", { timeout: 6_000 });
    const flags = await page.evaluate(() => {
      const snap = (window as any).__VIBERSYN__.getSnapshot();
      return { muted: snap.muted, captureMode: snap.captureMode, autoAccept: snap.autoAccept };
    });
    expect(flags.muted).toBe(false);
    expect(flags.captureMode).toBe(true);
    expect(flags.autoAccept).toBe(true);

    // STEP 3: the live transcript renders; the coach is DELIBERATELY inert —
    // even a process born in the background never yanks the visitor forward.
    // Only their own 🌱 Plant press advances, and the race then adopts the
    // newborn process as the camera focus.
    await expect(page.getByTestId("guided-transcript")).toBeVisible();

    // The finalize verb is PLANT language, and START OVER is two-stage: the
    // first press only ARMS the confirm, the second really fires — and the
    // demo stays on the idea step either way (a reset, not an advance).
    await expect(page.getByTestId("guided-done-button")).toContainText("Plant this idea");
    const restart = page.getByTestId("guided-restart-button");
    await expect(restart).toHaveAttribute("data-armed", "false");
    await restart.click();
    await expect(restart).toHaveAttribute("data-armed", "true");
    await restart.click();
    await expect(restart).toHaveAttribute("data-armed", "false");
    await expect(demo).toHaveAttribute("data-step", "idea");
    await parkMouse(page);
    const baseline = await page.evaluate(() =>
      (window as any).__VIBERSYN__.getSnapshot().processes.map((p: any) => p.upid),
    );
    await page.evaluate((upids) => {
      const snap = (window as any).__VIBERSYN__.getSnapshot();
      (window as any).__VIBERSYN__.applySnapshot({
        processes: [
          ...snap.processes,
          {
            upid: "upid_guided_e2e",
            runId: "run_guided_e2e",
            callsign: "Guided",
            state: "active",
            selected: false,
            task: "Guided demo project",
            model: "runtime",
            progressLabel: "starting",
            progress: 5,
            lastOutput: "",
            lastAction: "spawned from accepted suggestion",
            events: [],
            builds: [
              { backend: "smithers", label: "Smithers", status: "building", previewUrl: null, summary: null, slideshowUrl: null, progressLabel: "planning", percent: 10 },
              { backend: "eliza", label: "ElizaOS", status: "building", previewUrl: null, summary: null, slideshowUrl: null, percent: 5 },
              { backend: "native", label: "Native", status: "building", previewUrl: null, summary: null, slideshowUrl: null, percent: 20 },
            ],
          },
        ],
      });
      return upids;
    }, baseline);
    // The background spawn did NOT move the coach — the idea step waits for
    // the visitor's own press.
    await expect(demo).toHaveAttribute("data-step", "idea");
    await page.getByTestId("guided-done-button").click();
    await parkMouse(page);
    await expect(demo).toHaveAttribute("data-step", "race", { timeout: 4_000 });
    await expect(page.getByTestId("guided-celebrate")).toBeVisible();

    // STEP 4: one MOCK lane per concept sketch, all racing — DE-THEMED: lanes
    // carry real telemetry but are labeled generically ("Concept N"), never by
    // framework/backend name; a failed lane shows FAILED without wedging.
    await expect(page.getByTestId("guided-lane")).toHaveCount(3);
    await expect(page.getByTestId("guided-lane").nth(0)).toContainText("Concept 1");
    await expect(page.getByTestId("guided-lane").nth(1)).toContainText("Concept 2");
    await expect(page.getByTestId("guided-lane").nth(2)).toContainText("Concept 3");
    await expect(page.getByTestId("guided-lanes")).not.toContainText("Smithers");
    await expect(page.getByTestId("guided-lanes")).not.toContainText("ElizaOS");

    const withStatus = (smithers: string, eliza: string, native: string, deck: boolean) => ({
      upid: "upid_guided_e2e",
      runId: "run_guided_e2e",
      callsign: "Guided",
      state: "active",
      selected: false,
      task: "Guided demo project",
      model: "runtime",
      progressLabel: "building",
      progress: 60,
      lastOutput: "",
      lastAction: "building",
      events: [],
      builds: [
        { backend: "smithers", label: "Smithers", status: smithers, previewUrl: null, summary: null, slideshowUrl: null, percent: 60 },
        { backend: "eliza", label: "ElizaOS", status: eliza, previewUrl: null, summary: null, slideshowUrl: deck ? "/api/health" : null, percent: 90 },
        { backend: "native", label: "Native", status: native, previewUrl: null, summary: null, slideshowUrl: null, percent: 30 },
      ],
    });

    // Native fails → still on the race step, lane says FAILED.
    await page.evaluate((proc) => {
      const snap = (window as any).__VIBERSYN__.getSnapshot();
      (window as any).__VIBERSYN__.applySnapshot({
        processes: snap.processes.map((p: any) => (p.upid === "upid_guided_e2e" ? proc : p)),
      });
    }, withStatus("building", "building", "failed", false));
    await expect(demo).toHaveAttribute("data-step", "race");
    await expect(page.locator('[data-testid="guided-lane"][data-status="failed"]')).toContainText("FAILED");

    // ElizaOS's MOCK finishes FIRST (with a real deck URL) → decide +
    // auto-opened pitch deck on eliza's slide; per-backend tabs label the
    // other lanes and the "How should we continue?" decision bar is up.
    await page.evaluate((proc) => {
      const snap = (window as any).__VIBERSYN__.getSnapshot();
      (window as any).__VIBERSYN__.applySnapshot({
        processes: snap.processes.map((p: any) => (p.upid === "upid_guided_e2e" ? proc : p)),
      });
    }, withStatus("building", "ready", "failed", true));
    // The race HOLDS for its minimum on-screen dwell (RACE_MIN_DWELL_MS, 10s)
    // even with a mock already ready — each auto-advanced step is watchable.
    await expect(demo).toHaveAttribute("data-step", "decide", { timeout: 15_000 });
    await expect(page.getByTestId("slideshow-overlay")).toBeVisible();
    await expect(page.getByTestId("deck-backend-tab")).toHaveCount(3);
    await expect(page.locator('[data-testid="deck-backend-tab"][data-backend="eliza"]')).toHaveAttribute("aria-selected", "true");
    await expect(page.locator('[data-testid="deck-backend-tab"][data-backend="smithers"]')).toBeDisabled();
    await expect(page.locator('[data-testid="deck-backend-tab"][data-backend="native"]')).toContainText("failed");

    // FINALE: the room-native decision bar (dwell-operable buttons) is on the
    // deck. Picking "Build it for real" fires the commission as an EPILOGUE —
    // the demo completes immediately (never waits for the full build) and the
    // process transforms to COMMISSIONED (executing chip).
    await expect(page.getByTestId("deck-decision")).toBeVisible();
    await parkMouse(page);
    await dwell(page, "decision-commission");
    await expect(page.getByTestId("guided-demo")).toHaveCount(0, { timeout: 6_000 });
    await expect(page.getByTestId("guided-epilogue")).toBeVisible();
    await expect(page.getByTestId("execution-chip").first()).toBeVisible();
    await expect(page.getByTestId("deck-stage")).toContainText("COMMISSIONED");
  });

  test("skip at every step, Esc exits, HUD button re-enters fresh (dock folds on entry)", async ({ page }) => {
    await page.goto("/?live=0");
    await waitForHook(page);

    // Enter via the HUD button (it lives INSIDE the ⚙ Controls tray — hover
    // the dock toggle so the popover unfolds first).
    await page.getByTestId("control-dock-button").hover();
    await expect(page.getByTestId("control-dock")).toHaveAttribute("data-expanded", "true");
    await page.getByTestId("guided-demo-button").click();
    const demo = page.getByTestId("guided-demo");
    await expect(demo).toHaveAttribute("data-step", "orientation");
    // Starting the guide FOLDS the dock (two glass panels never overlap over
    // the projection) and it stays folded on its own — only a fresh hover on
    // the dock re-opens it.
    await expect(page.getByTestId("control-dock")).toHaveAttribute("data-expanded", "false");
    await parkMouse(page);
    await page.waitForTimeout(400);
    await expect(page.getByTestId("control-dock")).toHaveAttribute("data-expanded", "false");

    // The walk crosses the race via its never-wedge escape (nothing was
    // built — no focus process); a race with mocks building refuses the skip.
    for (const next of ["record", "idea", "race", "decide"]) {
      await page.getByTestId("guided-skip-button").click();
      await expect(demo).toHaveAttribute("data-step", next);
    }
    // Esc exits from the decide step.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("guided-demo")).toHaveCount(0);

    // Re-enter: a FRESH run back at step 1 (dock folds again on re-entry).
    await page.getByTestId("control-dock-button").hover();
    await page.getByTestId("guided-demo-button").click();
    await expect(page.getByTestId("guided-demo")).toHaveAttribute("data-step", "orientation");
    await expect(page.getByTestId("guided-orb-progress")).toContainText("0 / 3");
    await expect(page.getByTestId("control-dock")).toHaveAttribute("data-expanded", "false");
  });

  test("an emergency-stopped room says so instead of wedging", async ({ page }) => {
    await page.goto("/?live=0&demo=guided");
    await waitForHook(page);
    await apply(page, { emergencyStopTriggered: true });
    await expect(page.getByTestId("guided-notice")).toContainText("EMERGENCY STOP");
    // Skip/exit still work while stopped.
    await page.getByTestId("guided-skip-button").click();
    await expect(page.getByTestId("guided-demo")).toHaveAttribute("data-step", "record");
    await page.getByTestId("guided-exit-button").click();
    await expect(page.getByTestId("guided-demo")).toHaveCount(0);
  });
});
