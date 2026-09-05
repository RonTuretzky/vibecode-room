import { openProjectWork } from "./project-workspace";
// JOURNEY A — "somebody talks → an idea surfaces → you accept it → a tree grows".
//
// This is the room's product loop, driven end to end by injected speech against
// a REAL server with an EMPTY garden (roomOptions.seedDemoFleet=false — the
// Atlas/Cobalt fleet is fixture data and would make "a tree appeared" untestable).
//
// Every step carries a budget derived from the room's own constants, and every
// wait prints the number it measured.
//
// COST NOTE, because this spec is the one that spends money: accepting an idea
// starts the REAL build loop, and the smithers/native backends spawn the real
// `claude` CLI (HOME is inherited, so it uses the host subscription). One run of
// this file therefore leaves generated pages in `poc/` and a `builds/` tree in
// the repo it runs from, and consumes agent quota. Set
// VIBERSYN_BUILD_BACKENDS=none in roomOptions.env to keep the journey but drop
// the lanes.
//
// URL NOTE: `&remote=0`. Not the operator's URL — a workaround for the defect
// owned by e2e/popup-lifetime.live-pw.ts (the guest-hands dwell layer closes the
// top popup after 6s with nobody in the room). Journey A has to press buttons
// that live inside popups; isolating that defect in its own spec keeps this one
// about the build loop.

import { expect, reportCoverage, test } from "./live-room";
import { measure, wallText } from "./journey";

test.use({ roomOptions: { seedDemoFleet: false } });

const WALL = "/?wall=A&flat=1&remote=0";

/** detect/engine.ts throttle + detect/detector.ts 20s timeout → 24s ceiling, 12s target. */
const IDEA_BUDGET_MS = 12_000;
/**
 * The accept POST applies its snapshot inline (App.tsx actOnIdea), so this is
 * one localhost round trip plus a paint. Measured 867ms on an unloaded machine
 * and 1572ms with both Playwright workers busy — the ceiling is set above the
 * loaded figure so the assertion tracks the room, not the test machine.
 */
const TREE_BUDGET_MS = 2_500;
/** A lane that has not moved for this long has to say something. */
const STALL_BUDGET_MS = 20_000;

async function speakAnIdea(room: import("../src/testing/room-harness").RoomUnderTest, nonce: string) {
  return room.speak({
    utterances: [
      { text: `we should build a dashboard called ${nonce} that shows every blocked agent` },
      { text: "and it needs an api endpoint so the wall can poll it", pauseBeforeMs: 600 },
    ],
  });
}

test("speaking an idea grows a tree: idea → accept → the garden gains it", async ({ room, wall }) => {
  await reportCoverage(room, "idea-to-build");
  await wall.open(WALL);

  const scene = wall.page.locator('[data-testid="room-scene"]');
  await expect(scene).toBeVisible();
  const treesBefore = Number(await scene.getAttribute("data-tree-count"));
  expect(treesBefore, "the journey starts in an empty garden").toBe(0);

  // --- somebody talks -------------------------------------------------------
  const nonce = `zephyr${Math.random().toString(36).slice(2, 7)}`;
  const spoken = await speakAnIdea(room, nonce);
  // The clock that matters starts when the LAST sentence committed — the moment
  // the person stopped talking and started waiting.
  const lastFinalAtMs = spoken.emits.filter((emit) => emit.final).at(-1)?.emittedAtMs ?? spoken.endedAtMs;

  // --- an idea surfaces, ON THE WALL, not just in the snapshot --------------
  const tray = wall.page.locator('[data-testid="idea-item"][data-status="ready"]');
  const watchFromMs = Date.now();
  const surfaced = await measure(async () => (await tray.count()) > 0, { timeoutMs: IDEA_BUDGET_MS + 12_000 });
  const waitedMs = watchFromMs + surfaced.elapsedMs - lastFinalAtMs;
  console.log(
    `[idea-to-build] last final → a ready idea painted on the wall: ${waitedMs}ms (budget ${IDEA_BUDGET_MS}ms)`,
  );
  expect(surfaced.ok, `a ready idea reached the wall (waited ${waitedMs}ms after the last word)`).toBe(true);
  expect(waitedMs, `speech → a ready idea on the wall within ${IDEA_BUDGET_MS}ms (measured ${waitedMs}ms)`).toBeLessThanOrEqual(
    IDEA_BUDGET_MS,
  );

  // PROVENANCE: the idea has to be ABOUT what was said. The nonce is a word no
  // fixture could contain.
  await expect(tray.first(), "the idea the wall offers came from the sentence that was spoken").toContainText(nonce);

  // --- accept it ------------------------------------------------------------
  const buildButton = wall.page.locator('[data-testid="idea-build-button"]').first();
  await expect(buildButton).toBeVisible();
  const pressedAtMs = Date.now();
  await buildButton.click();

  const grown = await measure(async () => Number(await scene.getAttribute("data-tree-count")) > treesBefore, {
    timeoutMs: TREE_BUDGET_MS + 4_000,
  });
  console.log(`[idea-to-build] "build it" → the tree is in the garden: ${grown.elapsedMs}ms (budget ${TREE_BUDGET_MS}ms)`);
  expect(grown.ok, `the garden gained a tree (waited ${grown.elapsedMs}ms)`).toBe(true);
  expect(
    grown.elapsedMs,
    `accept → tree within ${TREE_BUDGET_MS}ms (measured ${grown.elapsedMs}ms since the press at ${pressedAtMs})`,
  ).toBeLessThanOrEqual(TREE_BUDGET_MS);

  // The room agrees with the wall.
  const snapshot = await room.state();
  expect(snapshot.processes.length, "the server grew exactly one process").toBe(1);
});

test("a build lane that stops moving has to say so", async ({ room, wall }) => {
  await wall.open(WALL);

  const nonce = `zephyr${Math.random().toString(36).slice(2, 7)}`;
  await speakAnIdea(room, nonce);
  await wall.page.locator('[data-testid="idea-build-button"]').first().click({ timeout: 25_000 });
  const target = (
    await room.waitFor((snapshot) => snapshot.processes[0], { label: "the new process", timeoutMs: 10_000 })
  ).value;

  await openProjectWork(wall.page, target.callsign);
  const lanes = wall.page.locator("#project-workspace .project-detail");
  await expect(lanes, "normal project controls expose build status before a deck exists").toBeVisible();

  // Sample what the lane SAYS over the stall budget. The oracle is the rendered
  // row, not the snapshot: this is exactly what a person watching the wall sees.
  const samples: string[] = [];
  const startedAtMs = Date.now();
  while (Date.now() - startedAtMs < STALL_BUDGET_MS) {
    samples.push((await lanes.first().innerText()).replace(/\s+/gu, " ").trim());
    await wall.page.waitForTimeout(1_000);
  }
  const distinct = [...new Set(samples)];
  const finalText = await wallText(wall.page);
  console.log(
    `[idea-to-build] lane row over ${STALL_BUDGET_MS}ms: ${distinct.length} distinct state(s) → ${JSON.stringify(distinct)}`,
  );

  // /api/health KNOWS the build substrate is degraded. The wall never says it.
  const health = await room.health();
  const degraded = health.degradation.degraded.map((leg) => `${leg.leg}:${leg.mode}`);
  console.log(`[idea-to-build] /api/health degraded legs: ${degraded.join(", ") || "none"}`);

  const advanced = distinct.length > 1;
  const explained = /stall|stuck|waiting|no progress|degrad|unavailable|fail|error|timed out/iu.test(finalText);
  expect(
    advanced || explained,
    `after ${STALL_BUDGET_MS}s the lane either moved or the wall explained why not. It rendered "${distinct[0] ?? ""}" the whole time, ` +
      `while /api/health reported degraded legs [${degraded.join(", ")}] that appear nowhere on the wall.`,
  ).toBe(true);
});
