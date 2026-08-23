// JOURNEY D — the DECIDE loop, end to end: somebody speaks an idea → it is
// accepted → the concept mock races → the pitch DECK opens → answering a
// QUESTION card visibly rebuilds the mock and regenerates the deck with the
// answer decided → "Build it for real" COMMISSIONS a real implementation run
// through the gateway seam → the executing lane shows FOOTPRINT-derived
// progress (real files, honest elapsed) → completion yields a BROWSABLE
// preview surfaced as the tree's dwell-reachable "🌐 Live app ▸" row.
//
// This is the spec the room never had: the live gateway has NEVER recorded a
// vibersyn-process run — the commission rail existed only in unit tests. Here
// the REAL server drives the REAL gateway-client protocol against a fake
// gateway (e2e/deck-rig.ts) whose scripted implementation writes REAL files
// over REAL seconds, so every honesty gate on the path (footprint probe,
// index.html-or-failed, event-derived percent) is exercised for real.
//
// COST NOTE: zero quota. The `claude` CLI is the rig's scripted fake
// (VIBERSYN_CLAUDE_CLI), the gateway is the rig's fake, Cerebras is blank
// (harness) — the deck asks the deterministic + judge questions and SAYS
// "template copy — no model" in its footer (provenance rule).
//
// URL NOTE: `&remote=0` — the guest-hands popup-lifetime defect is owned by
// e2e/popup-lifetime.live-pw.ts; this journey presses buttons inside popups.

import type { Page } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, reportCoverage, test as roomTest } from "./live-room";
import { startDeckRig, type DeckRig } from "./deck-rig";
import { executionOf } from "../src/ui/stage";
import type { ProjectorProcess } from "../src/ui/types";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WALL = "/?wall=A&flat=1&remote=0";

/** detect throttle ceiling (mirrors idea-to-build.live-pw.ts). */
const IDEA_BUDGET_MS = 12_000;
/** accept → the scripted mock lane ready + deck published. */
const READY_BUDGET_MS = 25_000;
/** answer POST → version-bumped rebuilt mock + regenerated deck. */
const REBUILD_BUDGET_MS = 25_000;
/** commission press → 200 + gateway launch recorded. */
const COMMISSION_BUDGET_MS = 6_000;
/** launch → built lane with a served preview (scripted run ~3.6s). */
const BUILT_BUDGET_MS = 30_000;

const test = roomTest.extend<{ rig: DeckRig }>({
  rig: async ({}, use) => {
    const rig = await startDeckRig({ repoRoot: REPO_ROOT });
    await use(rig);
    await rig.stop();
  },
  // The room boots pointed at the rig: scripted claude (mock lanes), fake
  // gateway (the commission rail), single lane, fast watchdog poll. The
  // harness blanks every credential; deck copy stays deterministic
  // (VIBERSYN_DECK_COPY_CLI unset = CLI failover off).
  roomOptions: async ({ rig }, use) => {
    await use({
      seedDemoFleet: false,
      env: {
        VIBERSYN_BUILD_BACKENDS: "smithers",
        VIBERSYN_CLAUDE_CLI: rig.claudePath,
        VIBERSYN_MOCK_ENRICH: "0",
        VIBERSYN_SMITHERS_GATEWAY_URL: `http://127.0.0.1:${rig.gatewayPort}`,
        VIBERSYN_RUN_POLL_MS: "500",
      },
    });
  },
});

type SnapshotProcess = ProjectorProcess & {
  builds?: Array<{ status?: string; previewUrl?: string | null; slideshowUrl?: string | null }>;
};

async function speakAndAccept(
  room: import("../src/testing/room-harness").RoomUnderTest,
  wall: { page: Page; open: (path?: string) => Promise<void> },
  nonce: string,
): Promise<SnapshotProcess> {
  await wall.open(WALL);
  const spoken = await room.speak({
    utterances: [
      { text: `we should build a habit garden called ${nonce} that waters a plant per finished task` },
      { text: "and it needs a weekly review screen so the room can see streaks", pauseBeforeMs: 600 },
    ],
  });
  const lastFinalAtMs = spoken.emits.filter((emit) => emit.final).at(-1)?.emittedAtMs ?? spoken.endedAtMs;
  const tray = wall.page.locator('[data-testid="idea-item"][data-status="ready"]');
  await expect(tray.first(), "a ready idea painted on the wall").toBeVisible({ timeout: IDEA_BUDGET_MS + 12_000 });
  console.log(`[deck-decide] last final → ready idea painted: ${Date.now() - lastFinalAtMs}ms (budget ${IDEA_BUDGET_MS}ms)`);
  await expect(tray.first(), "the idea is about what was said").toContainText(nonce);
  await wall.page.locator('[data-testid="idea-build-button"]').first().click();
  const target = (
    await room.waitFor((snapshot) => snapshot.processes[0] as SnapshotProcess | undefined, {
      label: "the accepted process",
      timeoutMs: 10_000,
    })
  ).value;
  return target;
}

/** Wait server-side for the lane's deck to publish (the deck-ready oracle). */
async function waitForDeck(
  room: import("../src/testing/room-harness").RoomUnderTest,
): Promise<{ slideshowUrl: string; previewUrl: string }> {
  const pressAtMs = Date.now();
  const ready = await room.waitFor(
    (snapshot) => {
      const build = (snapshot.processes[0] as SnapshotProcess | undefined)?.builds?.[0];
      return build?.status === "ready" &&
        typeof build.slideshowUrl === "string" &&
        typeof build.previewUrl === "string"
        ? { slideshowUrl: build.slideshowUrl, previewUrl: build.previewUrl }
        : false;
    },
    { label: "mock lane ready with a published deck", timeoutMs: READY_BUDGET_MS },
  );
  console.log(`[deck-decide] accept → mock ready + deck published: ${ready.elapsedMs + (Date.now() - pressAtMs - ready.elapsedMs)}ms (budget ${READY_BUDGET_MS}ms)`);
  return ready.value;
}

/**
 * SSE frame-loss guard. The wall applies snapshots pushed over /api/events; a
 * single missed frame with no follow-up publish leaves the wall stale until
 * the next state change (observed in this spec's first runs: the server said
 * "ready" while the menu still showed "queued…"). The room's own recovery is
 * a /api/state resync on stream reconnect — this helper performs the same
 * resync through the sanctioned e2e hook, and the spec PRINTS when it was
 * needed so the lag stays visible instead of silently papered over.
 */
async function resyncWallSnapshot(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const response = await fetch("/api/state", { headers: { accept: "application/json" } });
    if (response.ok) {
      const snapshot = (await response.json()) as Parameters<NonNullable<typeof window.__VIBERSYN__>["applySnapshot"]>[0];
      window.__VIBERSYN__?.applySnapshot(snapshot);
    }
  });
}

/** Wait until the WALL's own snapshot shows the wanted state, resyncing on lag. */
async function waitForWallBuild(
  page: Page,
  upid: string,
  wanted: { slideshowUrl?: string; executionBuilt?: boolean },
  label: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let resyncs = 0;
  for (;;) {
    const satisfied = await page.evaluate(
      ({ id, slideshowUrl, executionBuilt }) => {
        const processes = (window.__VIBERSYN__?.getSnapshot().processes ?? []) as Array<{
          upid: string;
          builds?: Array<{ status?: string; slideshowUrl?: string | null }>;
          execution?: { status?: string; previewUrl?: string | null };
        }>;
        const match = processes.find((process) => process.upid === id);
        if (match === undefined) {
          return false;
        }
        if (executionBuilt === true) {
          return match.execution?.status === "built" && typeof match.execution.previewUrl === "string";
        }
        const build = match.builds?.[0];
        if (build?.status !== "ready" || typeof build.slideshowUrl !== "string") {
          return false;
        }
        return slideshowUrl === undefined || build.slideshowUrl === slideshowUrl;
      },
      { id: upid, slideshowUrl: wanted.slideshowUrl, executionBuilt: wanted.executionBuilt },
    );
    if (satisfied) {
      break;
    }
    if (Date.now() > deadline) {
      throw new Error(`the wall never showed: ${label} (even after ${resyncs} /api/state resyncs)`);
    }
    resyncs += 1;
    await resyncWallSnapshot(page);
    await page.waitForTimeout(300);
  }
  if (resyncs > 0) {
    console.log(`[deck-decide] NOTE: wall snapshot lagged behind the server for "${label}" — resynced ${resyncs}x via /api/state`);
  }
}

/**
 * The deck iframe is TALLER than the deck window's scrollport (64vh frame in
 * a body that shares the card with fixed chrome) — its own footer dots and
 * mid-slide buttons sit below the fold. Only .slideshow-body scrolls (the
 * card's design contract), so a person scrolls to reach them; the spec does
 * the same before every in-frame interaction.
 */
async function revealDeckBottom(page: Page): Promise<void> {
  await page.locator('[data-testid="slideshow-body"]').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
}

/**
 * The dwell-reachability probe, inlined from scripts/self-exercise.ts (same
 * contract: center inside the viewport AND elementsFromPoint resolves to the
 * target). A decision button a dwell cursor cannot reach is not shipped.
 */
async function probeDwellReachability(
  page: Page,
  selector: string,
): Promise<Array<{ text: string; reachable: boolean; why: string }>> {
  return page.evaluate((sel) => {
    const rows: Array<{ text: string; reachable: boolean; why: string }> = [];
    for (const node of Array.from(document.querySelectorAll(sel))) {
      const rect = node.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const text = ((node as HTMLElement).innerText ?? "").slice(0, 40).replace(/\s+/gu, " ");
      if (rect.width < 2 || rect.height < 2) {
        rows.push({ text, reachable: false, why: `zero-size rect ${Math.round(rect.width)}x${Math.round(rect.height)}` });
        continue;
      }
      if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) {
        rows.push({ text, reachable: false, why: `center off-viewport at ${Math.round(cx)},${Math.round(cy)}` });
        continue;
      }
      const stack = document.elementsFromPoint(cx, cy);
      const hit = stack.some((el) => el === node || node.contains(el) || el.contains(node));
      rows.push({ text, reachable: hit, why: hit ? "ok" : `occluded by <${(stack[0]?.tagName ?? "nothing").toLowerCase()}>` });
    }
    return rows;
  }, selector);
}

test("deck journey: answer reshapes the mock, commission runs a real implementation, the built app lands on the wall", async ({
  room,
  wall,
  rig,
}) => {
  await reportCoverage(room, "deck-decide");
  const nonce = `garden${Math.random().toString(36).slice(2, 7)}`;
  const target = await speakAndAccept(room, wall, nonce);
  const deck = await waitForDeck(room);

  // --- open the deck the way a person does: tree menu → ready lane ---------
  await waitForWallBuild(wall.page, target.upid, { slideshowUrl: deck.slideshowUrl }, "the ready lane with its deck");
  await wall.page.evaluate((id) => window.__VIBERSYN__?.select(id), target.callsign);
  const lane = wall.page.locator('button[data-testid="tree-menu-lane"][data-status="ready"]');
  await expect(lane.first(), "the tree menu offers the ready lane as a real button").toBeVisible({ timeout: 10_000 });
  await lane.first().click();
  await expect(wall.page.locator('[data-testid="slideshow-overlay"]')).toBeVisible();
  const frame = wall.page.frameLocator('[data-testid="slideshow-live-frame"]');
  await expect(frame.locator("[data-slide]").first()).toBeAttached({ timeout: 15_000 });

  // PROVENANCE: no model anywhere (Cerebras blank, CLI failover off) — the
  // deck says so instead of passing template prose off as model copy.
  const deckHtml = await (await fetch(deck.slideshowUrl)).text();
  expect(deckHtml, "the deck footer carries the template-copy provenance marker").toContain("template copy — no model");
  expect(deckHtml, "the honest rebuild badge ships in the mock gallery").toContain("data-mock-rebuilding");

  // --- a QUESTION CARD exists and is idea-shaped, not starved ---------------
  // Judge questions (the heuristic emits real >=2-option forks now) come
  // before the deterministic fallbacks; either way the deck ASKS something.
  const openCardSection = frame.locator("section[data-question-slide]:not([data-decided-slide])").first();
  await expect(openCardSection, "the deck asks at least one open question").toBeAttached();
  const ariaLabel = (await openCardSection.getAttribute("aria-label")) ?? "";
  const slideNo = Number(/Slide (\d+) of/u.exec(ariaLabel)?.[1] ?? "0");
  expect(slideNo, `question card has a slide number (aria-label was "${ariaLabel}")`).toBeGreaterThan(0);
  await revealDeckBottom(wall.page);
  await frame.locator(".dot").nth(slideNo - 1).click();
  await expect(openCardSection, "the question card is the active slide").toHaveClass(/active/u);

  // --- ANSWER it and watch the loop close -----------------------------------
  const firstAnswer = openCardSection.locator("[data-answer]").first();
  const answerLabel = (await firstAnswer.innerText()).trim();
  const answerResponsePromise = wall.page.waitForResponse(
    (response) => response.url().includes("/answer") && response.request().method() === "POST",
    { timeout: 10_000 },
  );
  const answeredAtMs = Date.now();
  await firstAnswer.click();
  const answerResponse = await answerResponsePromise;
  expect(answerResponse.ok(), `the in-iframe answer POST landed (status ${answerResponse.status()})`).toBe(true);
  // The card locks immediately (old frame) or already shows the regenerated
  // decided state (rebuild landed fast) — both are the honest states.
  await expect(frame.locator("[data-answer-status]").first()).toContainText(/Locked in|You chose/u);

  // The REBUILD oracle: the lane's version-stamped URLs change when the
  // correction lands (fake claude is instant, so this is seconds).
  const rebuilt = (
    await room.waitFor(
      (snapshot) => {
        const build = (snapshot.processes[0] as SnapshotProcess | undefined)?.builds?.[0];
        return build?.status === "ready" &&
          typeof build.slideshowUrl === "string" &&
          build.slideshowUrl !== deck.slideshowUrl &&
          typeof build.previewUrl === "string"
          ? { slideshowUrl: build.slideshowUrl, previewUrl: build.previewUrl }
          : false;
      },
      { label: "the answer-triggered mock rebuild (version bump)", timeoutMs: REBUILD_BUDGET_MS },
    )
  ).value;
  console.log(`[deck-decide] answer → rebuilt mock + regenerated deck: ${Date.now() - answeredAtMs}ms (budget ${REBUILD_BUDGET_MS}ms)`);

  // The mock on disk REALLY changed: the decision text is in the rebuilt app.
  const mockHtml = await (await fetch(rebuilt.previewUrl)).text();
  expect(mockHtml, "the rebuilt mock carries the applied decision").toContain("data-decision-applied");
  expect(mockHtml, "the decision text is the chosen answer").toContain(answerLabel);

  // The REGENERATED deck renders the card pre-decided, and the remounted
  // iframe kept the reader's place (slide memory) instead of resetting to 1.
  await waitForWallBuild(wall.page, target.upid, { slideshowUrl: rebuilt.slideshowUrl }, "the rebuilt deck URL (remount trigger)");
  await expect(frame.locator('[data-answers][data-decided="1"]').first(), "the regenerated deck pre-decides the answered card").toBeAttached({
    timeout: 15_000,
  });
  await expect(frame.locator('[data-answers][data-decided="1"]').first().locator("..").locator("[data-answer-status]")).toContainText(
    "You chose",
  );
  const counterText = (await frame.locator("[data-counter]").innerText()).trim();
  expect(counterText.startsWith("1 /"), `the deck kept the reader's place across the rebuild remount (counter "${counterText}")`).toBe(
    false,
  );

  // --- the decision bar is DWELL-REACHABLE (house grammar) ------------------
  const reach = await probeDwellReachability(wall.page, '[data-testid="deck-decision"] button');
  for (const row of reach) {
    console.log(`[deck-decide] dwell ${row.reachable ? "REACHABLE  " : "UNREACHABLE"} "${row.text}" — ${row.why}`);
  }
  expect(reach.length, "all three decision buttons exist").toBe(3);
  expect(reach.filter((row) => !row.reachable), "every decision button is dwell-reachable").toEqual([]);

  // --- COMMISSION: "Build it for real" --------------------------------------
  const executePromise = wall.page.waitForResponse(
    (response) => response.url().includes("/execute") && response.request().method() === "POST",
    { timeout: COMMISSION_BUDGET_MS },
  );
  const commissionAtMs = Date.now();
  await wall.page.locator('[data-testid="decision-commission"]').click();
  const executeResponse = await executePromise;
  expect(executeResponse.status(), "the commission POST answered 200").toBe(200);
  await expect(wall.page.locator('[data-testid="decision-status-commissioned"]'), "synchronous acknowledgement").toBeVisible();
  console.log(`[deck-decide] commission press → 200: ${Date.now() - commissionAtMs}ms (budget ${COMMISSION_BUDGET_MS}ms)`);

  // THE SMOKING-GUN oracle: a REAL vibersyn-process launch reached the
  // gateway (the live gateway's DB had ZERO of these, ever).
  expect(rig.launches.length, "exactly one durable run launched").toBe(1);
  expect(rig.launches[0]!.workflow).toBe("vibersyn-process");
  expect(rig.launches[0]!.input.upid).toBe(target.upid);

  // --- honest FOOTPRINT progress while executing ----------------------------
  const samples: Array<{ status: string; files: number | null; percent: number | null; label: string | null }> = [];
  let sawFootprintOnWall = false;
  const built = await (async () => {
    const deadline = Date.now() + BUILT_BUDGET_MS;
    while (Date.now() < deadline) {
      const snapshot = await room.state();
      const execution = executionOf(snapshot.processes[0] as ProjectorProcess);
      if (execution !== null) {
        samples.push({
          status: execution.status,
          files: execution.filesWritten,
          percent: execution.percent,
          label: execution.progressLabel,
        });
        if (execution.status === "built" && execution.previewUrl !== null) {
          return execution;
        }
        if (execution.status === "failed") {
          throw new Error(`the commission FAILED honestly: ${execution.summary ?? "(no reason)"}`);
        }
        if (execution.status === "executing" && !sawFootprintOnWall) {
          // Keep the wall current while sampling (SSE frame-loss guard) so the
          // chip assertion measures the CHIP, not stream luck.
          await resyncWallSnapshot(wall.page);
          if ((await wall.page.locator('[data-testid="execution-chip-footprint"]').count()) > 0) {
            const chipText = await wall.page.locator('[data-testid="execution-chip-footprint"]').innerText();
            sawFootprintOnWall = /on disk|no files yet/u.test(chipText);
          }
        }
      }
      await wall.page.waitForTimeout(150);
    }
    throw new Error(`the commission never built within ${BUILT_BUDGET_MS}ms — samples: ${JSON.stringify(samples.slice(-6))}`);
  })();
  console.log(`[deck-decide] commission → BUILT: ${Date.now() - commissionAtMs}ms (budget ${BUILT_BUDGET_MS}ms)`);
  console.log(`[deck-decide] executing samples (status/files/percent): ${JSON.stringify(samples.map((s) => `${s.status}:${s.files}:${s.percent}`))}`);

  const executingSamples = samples.filter((sample) => sample.status === "executing");
  expect(executingSamples.length, "the lane was observed executing before it built").toBeGreaterThan(0);
  expect(
    executingSamples.some((sample) => (sample.files ?? 0) > 0),
    `footprint progress: real files were reported while executing (samples ${JSON.stringify(executingSamples)})`,
  ).toBe(true);
  expect(sawFootprintOnWall, "the wall's execution chip showed the working-tree footprint").toBe(true);
  // The final footprint is the whole scripted app (3 real files).
  expect(built.filesWritten, "the built lane reports the run's true footprint").toBe(3);

  // --- the BUILT app is genuinely browsable ---------------------------------
  const appHtml = await (await fetch(built.previewUrl!)).text();
  expect(appHtml, "the served preview is the run's real index.html").toContain("FAKE-RUN-APP");

  // --- and it lands ON THE WALL: the dwell-reachable Live app row ----------
  await wall.page.locator('[data-testid="slideshow-close"]').click();
  await waitForWallBuild(wall.page, target.upid, { executionBuilt: true }, "the built execution lane");
  await wall.page.evaluate((id) => window.__VIBERSYN__?.select(id), target.callsign);
  const liveRow = wall.page.locator('[data-testid="tree-menu-live"]');
  await expect(liveRow, "the tree menu grew the Live app row off the built execution lane").toBeVisible({ timeout: 10_000 });
  const liveReach = await probeDwellReachability(wall.page, '[data-testid="tree-menu-live"]');
  expect(liveReach.filter((row) => !row.reachable), "the Live app row is dwell-reachable").toEqual([]);
  await liveRow.click();
  await expect(wall.page.locator('[data-testid="holo-panel"]')).toBeVisible();
  await expect(wall.page.locator('[data-testid="holo-frame"]')).toHaveAttribute("data-holo-source", "execution");
  const holoFrame = wall.page.frameLocator('[data-testid="holo-frame"]');
  await expect(holoFrame.locator("body"), "the holo panel shows the REAL built app").toContainText("FAKE-RUN-APP", {
    timeout: 10_000,
  });
});

test("in-deck decision slide commissions through the bridge, with an honest sent→confirmed status loop", async ({
  room,
  wall,
  rig,
}) => {
  await reportCoverage(room, "deck-decide-bridge");
  const nonce = `bridge${Math.random().toString(36).slice(2, 7)}`;
  const target = await speakAndAccept(room, wall, nonce);
  const deck = await waitForDeck(room);

  // Open the deck through the e2e hook (the same path the self-exercise
  // probe's --open-deck flag drives).
  await waitForWallBuild(wall.page, target.upid, { slideshowUrl: deck.slideshowUrl }, "the ready lane with its deck");
  await wall.page.evaluate((id) => window.__VIBERSYN__?.openDeck(id), target.callsign);
  await expect(wall.page.locator('[data-testid="slideshow-overlay"]')).toBeVisible();
  const frame = wall.page.frameLocator('[data-testid="slideshow-live-frame"]');
  await expect(frame.locator("[data-slide]").first()).toBeAttached({ timeout: 15_000 });

  // Navigate the deck (inside the iframe) to its decision slide via the dots.
  const decisionSection = frame.locator("section[data-slide]:has([data-decisions])");
  const ariaLabel = (await decisionSection.getAttribute("aria-label")) ?? "";
  const slideNo = Number(/Slide (\d+) of/u.exec(ariaLabel)?.[1] ?? "0");
  expect(slideNo, `decision slide has a slide number (aria-label "${ariaLabel}")`).toBeGreaterThan(0);
  await revealDeckBottom(wall.page);
  await frame.locator(".dot").nth(slideNo - 1).click();
  await expect(decisionSection).toHaveClass(/active/u);

  // Record EVERY status the slide shows (the sent→confirmed transition is
  // sub-second on localhost — an after-the-fact expect would miss the
  // transient), then click the in-iframe 🚀 button: bridge-only → the ROOM
  // fires the one POST.
  await frame.locator("[data-decision-status]").evaluate((element) => {
    const log: string[] = [];
    (window as unknown as { __statusLog: string[] }).__statusLog = log;
    new MutationObserver(() => log.push(element.textContent ?? "")).observe(element, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  });
  const executePromise = wall.page.waitForResponse(
    (response) => response.url().includes("/execute") && response.request().method() === "POST",
    { timeout: COMMISSION_BUDGET_MS },
  );
  await frame.locator('[data-decision="execute"]').click();
  const executeResponse = await executePromise;
  expect(executeResponse.status(), "the bridged commission POST answered 200").toBe(200);
  // HONESTY, step 2: the room's decision-result reply settles the slide on
  // the true confirmation, and the native chrome shows the same truth.
  await expect(frame.locator("[data-decision-status]")).toContainText("Commissioned — the real build is running");
  // HONESTY, step 1 (recorded): the slide first said the choice was SENT —
  // never claiming the build was running before the room's POST resolved.
  const statuses = await frame
    .locator("[data-decision-status]")
    .evaluate(() => (window as unknown as { __statusLog: string[] }).__statusLog);
  console.log(`[deck-decide] in-deck status sequence: ${JSON.stringify(statuses)}`);
  expect(
    statuses.some((status) => status.includes("Choice sent")),
    `the slide acknowledged "Choice sent" before the confirmation (saw ${JSON.stringify(statuses)})`,
  ).toBe(true);
  const sentAt = statuses.findIndex((status) => status.includes("Choice sent"));
  const confirmedAt = statuses.findIndex((status) => status.includes("Commissioned"));
  expect(confirmedAt, "confirmation came AFTER the sent ack").toBeGreaterThan(sentAt);
  await expect(frame.locator('[data-decision="execute"]')).toBeDisabled();
  await expect(wall.page.locator('[data-testid="decision-status-commissioned"]')).toBeVisible();

  // The bridge fired exactly ONE launch (never doubled into a false 400).
  expect(rig.launches.length, "exactly one durable run launched via the bridge").toBe(1);
  expect(rig.launches[0]!.workflow).toBe("vibersyn-process");
  expect(rig.launches[0]!.input.upid).toBe(target.upid);
  const execution = (
    await room.waitFor(
      (snapshot) => {
        const lane = executionOf(snapshot.processes[0] as ProjectorProcess);
        return lane !== null ? lane : false;
      },
      { label: "the executing lane in the snapshot", timeoutMs: 10_000 },
    )
  ).value;
  expect(["executing", "built"]).toContain(execution.status);
});
