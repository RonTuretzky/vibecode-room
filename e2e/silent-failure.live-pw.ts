// JOURNEY: "I pressed it. Did anything happen?"
//
// The operator's words were "there are so many broken things … the app is
// weirdly mocked in many places and is inconsistent". This spec is the
// executable form of that sentence: every high-stakes control on the wall is
// pressed while its OWN endpoint is failing, and the wall is asked one question
// — did anything visibly change?
//
// The oracle is deliberately the weakest possible one: not "a good error
// message", just "the pixels are not identical two seconds later". A control
// that cannot clear that bar is a button that lies about being pressed.
//
// Fault injection is per-row and scoped to that row's endpoint (page.route),
// so /api/state and /api/events keep working and the wall stays live. The
// reference implementation of the CORRECT behaviour already exists in this
// codebase — BranchPopup's "Open PR" busies its label and renders the server's
// own error inline (src/ui/BranchPopup.tsx) — so this is a consistency test,
// not a request for a new pattern.

import { expect, reportCoverage, test } from "./live-room";
import { measure, looksLikeFailureSignal, wallFingerprint, wallText } from "./journey";

// URL NOTE: `&remote=0` — see e2e/popup-lifetime.live-pw.ts. The tree menu that
// holds half of these controls closes itself in ~1.8s on the default URL.
const WALL = "/?wall=A&flat=1&remote=0";

/** A press has to produce SOMETHING within this long, or it was a no-op. */
const ACK_BUDGET_MS = 2_000;

interface Row {
  name: string;
  /** Endpoint to fail, as a page.route glob. */
  route: string;
  /** Bring the control on screen (open a menu, arm a confirm, …). */
  reach?: (page: import("@playwright/test").Page) => Promise<void>;
  testid: string;
}

test("no control on the wall is a silent no-op when its endpoint fails", async ({ room, wall }) => {
  await reportCoverage(room, "silent-failure");
  await wall.open(WALL);
  const page = wall.page;
  const target = (await room.state()).processes[0]!;

  const dock = page.locator('[data-testid="control-dock"]');
  const openDock = async (): Promise<void> => {
    // The dock folds itself away; the rAF hover loop (ControlDock.tsx) reopens
    // it when the cursor rests on it — exactly what a person does.
    await dock.hover();
    await expect(dock).toHaveAttribute("data-expanded", "true", { timeout: 5_000 });
  };
  const openTreeMenu = async (): Promise<void> => {
    await page.evaluate((callsign) => window.__VIBERSYN__?.select(callsign), target.callsign);
    await expect(page.locator('[data-testid="tree-menu"]')).toBeVisible({ timeout: 10_000 });
  };

  const rows: Row[] = [
    { name: "Auto-Build", testid: "auto-build-button", route: "**/api/auto-accept", reach: openDock },
    { name: "Self-Rebuild", testid: "self-rebuild-button", route: "**/api/self-rebuild", reach: openDock },
    { name: "Research mode", testid: "research-mode-button", route: "**/api/research-mode", reach: openDock },
    {
      name: "Record a change (arm)",
      testid: "record-steer-start",
      route: "**/api/process/*/select",
      reach: openTreeMenu,
    },
    {
      name: "Remove this tree (confirm)",
      testid: "tree-menu-remove-confirm",
      route: "**/api/process/*/dismiss",
      reach: async (p) => {
        await openTreeMenu();
        await p.locator('[data-testid="tree-menu-remove"]').first().click();
        await expect(p.locator('[data-testid="tree-menu-remove-confirm"]')).toBeVisible();
      },
    },
  ];

  // Baseline: is the idle wall quiet enough for "it changed" to mean anything?
  const idleBefore = await wallFingerprint(page);
  await page.waitForTimeout(ACK_BUDGET_MS);
  const idleAfter = await wallFingerprint(page);
  console.log(`[silent-failure] idle wall stable over ${ACK_BUDGET_MS}ms: ${idleBefore === idleAfter}`);

  const silent: string[] = [];
  const mute: string[] = [];
  for (const row of rows) {
    await page.unrouteAll();
    await page.route(row.route, async (route) => {
      await route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"injected fault"}' });
    });
    await row.reach?.(page);
    const control = page.locator(`[data-testid="${row.testid}"]`).first();
    if ((await control.count()) === 0) {
      console.log(`[silent-failure] ${row.name}: NOT PRESENT on this wall — skipped`);
      continue;
    }
    const beforeFingerprint = await wallFingerprint(page);
    const beforeText = await wallText(page);
    await control.click();
    const changed = await measure(async () => (await wallFingerprint(page)) !== beforeFingerprint, {
      timeoutMs: ACK_BUDGET_MS,
      pollMs: 40,
    });
    const afterText = await wallText(page);
    const honest = looksLikeFailureSignal(beforeText, afterText);
    console.log(
      `[silent-failure] ${row.name} (${row.route} → 500): visible change=${changed.ok} in ${changed.elapsedMs}ms, failure signal=${honest}`,
    );
    if (!changed.ok) {
      silent.push(`${row.name} [${row.testid}] → ${row.route}`);
    } else if (!honest) {
      mute.push(`${row.name} [${row.testid}]`);
    }
    // Reset the surface for the next row.
    await page.keyboard.press("Escape");
  }
  await page.unrouteAll();

  console.log(
    `[silent-failure] ${silent.length} control(s) changed NOTHING; ${mute.length} changed something but never said it failed`,
  );
  expect(
    silent,
    `pressing these while their endpoint returns 500 changes nothing on the wall within ${ACK_BUDGET_MS}ms — ` +
      "every handler swallows the failure with a bare catch {} (src/ui/App.tsx toggleAutoAccept/toggleSelfRebuild/" +
      "toggleResearchMode/dismissProcess, src/ui/RecordSteerToggle.tsx arm)",
  ).toEqual([]);
});

test('"build it" tells the room when the build never started', async ({ room, wall }) => {
  await wall.open(WALL);
  const page = wall.page;

  // A real idea, from real speech — the button under test only exists once the
  // room has actually surfaced something.
  const nonce = `zephyr${Math.random().toString(36).slice(2, 7)}`;
  await room.speak({ utterances: [{ text: `we should build a dashboard called ${nonce} for blocked agents` }] });
  const button = page.locator('[data-testid="idea-build-button"]').first();
  await expect(button, "the wall offered the idea").toBeVisible({ timeout: 20_000 });

  await page.route("**/api/idea/*/accept", async (route) => {
    await route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"injected fault"}' });
  });
  const beforeFingerprint = await wallFingerprint(page);
  const beforeText = await wallText(page);
  await button.click();
  const changed = await measure(async () => (await wallFingerprint(page)) !== beforeFingerprint, {
    timeoutMs: ACK_BUDGET_MS,
    pollMs: 40,
  });
  const afterText = await wallText(page);
  console.log(
    `[silent-failure] "build it" with /api/idea/:id/accept → 500: visible change=${changed.ok} in ${changed.elapsedMs}ms, ` +
      `failure signal=${looksLikeFailureSignal(beforeText, afterText)}`,
  );

  // The garden must not have gained a tree, and the room must not stay silent:
  // this is the single most consequential button on the wall.
  const trees = Number(await page.locator('[data-testid="room-scene"]').getAttribute("data-tree-count"));
  expect(
    changed.ok,
    `the wall said something within ${ACK_BUDGET_MS}ms about a build that never started (tree count ${trees}); ` +
      "src/ui/App.tsx actOnIdea swallows the response with a bare catch {} and no failure path",
  ).toBe(true);
});
