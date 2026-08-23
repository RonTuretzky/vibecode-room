// VERIFIER ADVERSARIAL PROBES for the deck-decide loop — beyond the journey:
//   A. offline questions reshape the mock (served BYTES change, POST recorded,
//      card locks — not just a spinner);
//   B. two surfaces, one vocabulary; a FORCED 500 on the execute route fails
//      loudly on both surfaces (silent-failure contract);
//   C. commission launches the scripted implementation ONCE even when both
//      surfaces are pressed; real files land in the artifacts dir while
//      executing;
//   D. progress honesty under a PAUSED runner: footprint/percent/label freeze
//      instead of inventing motion;
//   E. dwell/hit-test reachability of every decide/question/answer control at
//      1920x1080 on the gesture wall URL (&gesture=1, GestureLayer mounted).
//
// Zero quota: scripted claude + fake gateway (deck-rig-pausable.ts, a pausable
// superset of e2e/deck-rig.ts). Screenshots land in /tmp/deck-probe/.

import type { Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test as roomTest } from "./live-room";
import { startPausableDeckRig, type PausableDeckRig } from "./deck-rig-pausable";
import { executionOf } from "../src/ui/stage";
import type { ProjectorProcess } from "../src/ui/types";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = "/tmp/deck-probe";
mkdirSync(SHOTS, { recursive: true });

const WALL = "/?wall=A&flat=1&remote=0";
const GESTURE_WALL = "/?wall=A&flat=1&remote=0&gesture=1";

const test = roomTest.extend<{ rig: PausableDeckRig }>({
  rig: async ({}, use) => {
    const rig = await startPausableDeckRig({ repoRoot: REPO_ROOT });
    await use(rig);
    await rig.stop();
  },
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

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

async function speakAndAccept(
  room: import("../src/testing/room-harness").RoomUnderTest,
  wall: { page: Page; open: (path?: string) => Promise<void> },
  nonce: string,
  wallUrl = WALL,
): Promise<SnapshotProcess> {
  await wall.open(wallUrl);
  await room.speak({
    utterances: [
      { text: `we should build a habit garden called ${nonce} that waters a plant per finished task` },
      { text: "and it needs a weekly review screen so the room can see streaks", pauseBeforeMs: 600 },
    ],
  });
  const tray = wall.page.locator('[data-testid="idea-item"][data-status="ready"]');
  await expect(tray.first(), "a ready idea painted on the wall").toBeVisible({ timeout: 24_000 });
  await wall.page.locator('[data-testid="idea-build-button"]').first().click();
  return (
    await room.waitFor((snapshot) => snapshot.processes[0] as SnapshotProcess | undefined, {
      label: "the accepted process",
      timeoutMs: 10_000,
    })
  ).value;
}

async function waitForDeck(
  room: import("../src/testing/room-harness").RoomUnderTest,
): Promise<{ slideshowUrl: string; previewUrl: string }> {
  return (
    await room.waitFor(
      (snapshot) => {
        const build = (snapshot.processes[0] as SnapshotProcess | undefined)?.builds?.[0];
        return build?.status === "ready" && typeof build.slideshowUrl === "string" && typeof build.previewUrl === "string"
          ? { slideshowUrl: build.slideshowUrl, previewUrl: build.previewUrl }
          : false;
      },
      { label: "mock lane ready with a published deck", timeoutMs: 25_000 },
    )
  ).value;
}

async function resyncWallSnapshot(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const response = await fetch("/api/state", { headers: { accept: "application/json" } });
    if (response.ok) {
      const snapshot = (await response.json()) as Parameters<NonNullable<typeof window.__VIBERSYN__>["applySnapshot"]>[0];
      window.__VIBERSYN__?.applySnapshot(snapshot);
    }
  });
}

async function waitForWallDeck(page: Page, upid: string, slideshowUrl: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const seen = await page.evaluate(
      ({ id, url }) => {
        const processes = (window.__VIBERSYN__?.getSnapshot().processes ?? []) as Array<{
          upid: string;
          builds?: Array<{ status?: string; slideshowUrl?: string | null }>;
        }>;
        const match = processes.find((process) => process.upid === id);
        const build = match?.builds?.[0];
        return build?.status === "ready" && build.slideshowUrl === url;
      },
      { id: upid, url: slideshowUrl },
    );
    if (seen) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`the wall never showed deck ${slideshowUrl}`);
    }
    await resyncWallSnapshot(page);
    await page.waitForTimeout(300);
  }
}

async function revealDeckBottom(page: Page): Promise<void> {
  await page.locator('[data-testid="slideshow-body"]').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
}

async function openDeckAt(
  wall: { page: Page },
  callsign: string,
): Promise<ReturnType<Page["frameLocator"]>> {
  await wall.page.evaluate((id) => window.__VIBERSYN__?.openDeck(id), callsign);
  await expect(wall.page.locator('[data-testid="slideshow-overlay"]')).toBeVisible();
  const frame = wall.page.frameLocator('[data-testid="slideshow-live-frame"]');
  await expect(frame.locator("[data-slide]").first()).toBeAttached({ timeout: 15_000 });
  return frame;
}

/** Navigate the in-deck slideshow to the slide holding `innerSelector`. */
async function gotoDeckSlide(
  page: Page,
  frame: ReturnType<Page["frameLocator"]>,
  sectionSelector: string,
): Promise<void> {
  const section = frame.locator(sectionSelector).first();
  const ariaLabel = (await section.getAttribute("aria-label")) ?? "";
  const slideNo = Number(/Slide (\d+) of/u.exec(ariaLabel)?.[1] ?? "0");
  expect(slideNo, `slide number for ${sectionSelector} (aria-label "${ariaLabel}")`).toBeGreaterThan(0);
  await revealDeckBottom(page);
  await frame.locator(".dot").nth(slideNo - 1).click();
  await expect(section).toHaveClass(/active/u);
}

/** Main-document dwell contract (mirrors scripts/self-exercise.ts). */
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

/**
 * Composite hit-test for IN-IFRAME controls (the deck is served cross-origin
 * from its own port). The deck iframe is TALLER than the deck window's
 * scrollport (the implementer's documented workaround (a)) — so a person
 * scrolls the card to reach a control, exactly what a real click does. The
 * probe honors that contract: scroll THIS control into view first, then
 * require (1) center inside the frame viewport, (2) un-occluded INSIDE the
 * frame document, (3) the same point in the OUTER page resolves to the deck
 * iframe itself (no fixed chrome overlays it at its scrolled-into-view spot).
 */
async function probeFrameReachability(
  page: Page,
  frame: ReturnType<Page["frameLocator"]>,
  innerSelector: string,
): Promise<Array<{ text: string; reachable: boolean; why: string }>> {
  const rows: Array<{ text: string; reachable: boolean; why: string }> = [];
  const total = await frame.locator(innerSelector).count();
  for (let index = 0; index < total; index += 1) {
    const control = frame.locator(innerSelector).nth(index);
    const innerPoint = await control.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return { cy: rect.top + rect.height / 2 };
    });
    // Scroll the OUTER slideshow-body so this control's frame-point sits
    // mid-scrollport (scrollIntoViewIfNeeded cannot cross the OOPIF boundary;
    // this is the scroll a person performs — the card's design contract).
    await page.evaluate(({ cy }) => {
      const body = document.querySelector('[data-testid="slideshow-body"]');
      const iframe = document.querySelector('[data-testid="slideshow-live-frame"]');
      if (body === null || iframe === null) {
        return;
      }
      const bodyRect = body.getBoundingClientRect();
      const frameRect = iframe.getBoundingClientRect();
      const contentY = frameRect.top - bodyRect.top + body.scrollTop + cy;
      body.scrollTop = Math.max(0, contentY - bodyRect.height / 2);
    }, innerPoint);
    await page.waitForTimeout(120);
    const box = await page.locator('[data-testid="slideshow-live-frame"]').boundingBox();
    if (box === null) {
      rows.push({ text: "(iframe)", reachable: false, why: "deck iframe has no bounding box" });
      continue;
    }
    const inner = await control.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const text = ((node as HTMLElement).innerText ?? "").slice(0, 40).replace(/\s+/gu, " ");
      if (rect.width < 2 || rect.height < 2) {
        return { text, cx, cy, innerOk: false, why: `zero-size rect ${Math.round(rect.width)}x${Math.round(rect.height)}` };
      }
      if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) {
        return { text, cx, cy, innerOk: false, why: `center outside frame viewport at ${Math.round(cx)},${Math.round(cy)}` };
      }
      const stack = document.elementsFromPoint(cx, cy);
      const hit = stack.some((el) => el === node || node.contains(el) || el.contains(node));
      return { text, cx, cy, innerOk: hit, why: hit ? "ok" : `occluded in-frame by <${(stack[0]?.tagName ?? "nothing").toLowerCase()}>` };
    });
    if (!inner.innerOk) {
      rows.push({ text: inner.text, reachable: false, why: inner.why });
      continue;
    }
    const outerX = box.x + inner.cx;
    const outerY = box.y + inner.cy;
    const outer = await page.evaluate(
      ({ x, y }) => {
        if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
          return { ok: false, why: `outer point off-viewport at ${Math.round(x)},${Math.round(y)}` };
        }
        const stack = document.elementsFromPoint(x, y);
        const top = stack[0] ?? null;
        const isFrame = stack.some(
          (el) => el instanceof HTMLIFrameElement && el.getAttribute("data-testid") === "slideshow-live-frame",
        );
        return isFrame
          ? { ok: true, why: "ok" }
          : { ok: false, why: `outer point lands on <${top?.tagName.toLowerCase() ?? "nothing"}> not the deck iframe` };
      },
      { x: outerX, y: outerY },
    );
    rows.push({ text: inner.text, reachable: outer.ok, why: outer.ok ? "ok (after scroll-into-view)" : outer.why });
  }
  return rows;
}

function listRunFiles(upid: string): string[] {
  const dir = join(REPO_ROOT, "artifacts", "vibersyn-runs", upid);
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir).sort();
}

// ─── A ───────────────────────────────────────────────────────────────────────
test("A: offline deck still asks questions; answering records the POST, locks the card, and CHANGES the served mock bytes", async ({
  room,
  wall,
}) => {
  const nonce = `probea${Math.random().toString(36).slice(2, 7)}`;
  const target = await speakAndAccept(room, wall, nonce);
  const deck = await waitForDeck(room);

  // Model seam is dark (harness blanks credentials; VIBERSYN_DECK_COPY_CLI
  // unset) — the deck must SAY so and still ask questions.
  const deckHtml = await (await fetch(deck.slideshowUrl)).text();
  expect(deckHtml, "fallback provenance in the deck footer").toContain("template copy — no model");
  const questionCount = (deckHtml.match(/data-question-slide/gu) ?? []).length;
  console.log(`[probe-A] offline deck question slides: ${questionCount}`);
  expect(questionCount, "the offline deck still carries at least one question card").toBeGreaterThan(0);

  // BEFORE bytes of the served mock (the reshape oracle).
  const mockBefore = await (await fetch(deck.previewUrl)).text();
  console.log(`[probe-A] mock BEFORE: ${mockBefore.length} bytes sha256/16=${sha256(mockBefore)} url=${deck.previewUrl}`);
  expect(mockBefore, "no decision marker before any answer").not.toContain("data-decision-applied");

  await waitForWallDeck(wall.page, target.upid, deck.slideshowUrl);
  const frame = await openDeckAt(wall, target.callsign);
  await gotoDeckSlide(wall.page, frame, "section[data-question-slide]:not([data-decided-slide])");

  const openCard = frame.locator("section[data-question-slide]:not([data-decided-slide])").first();
  const firstAnswer = openCard.locator("[data-answer]").first();
  const answerLabel = (await firstAnswer.innerText()).trim();
  const answerResponsePromise = wall.page.waitForResponse(
    (response) => response.url().includes("/answer") && response.request().method() === "POST",
    { timeout: 10_000 },
  );
  const answeredAtMs = Date.now();
  await firstAnswer.click();
  const answerResponse = await answerResponsePromise;
  console.log(
    `[probe-A] recorded answer POST: ${answerResponse.request().method()} ${answerResponse.url()} → ${answerResponse.status()} payload=${answerResponse.request().postData() ?? "(none)"}`,
  );
  expect(answerResponse.ok(), "the answer POST landed").toBe(true);
  await expect(frame.locator("[data-answer-status]").first(), "the card locks").toContainText(/Locked in|You chose/u);
  await wall.page.screenshot({ path: join(SHOTS, "A-card-locked.png") });

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
      { label: "the answer-triggered rebuild (version bump)", timeoutMs: 25_000 },
    )
  ).value;
  const rebuildMs = Date.now() - answeredAtMs;

  const mockAfter = await (await fetch(rebuilt.previewUrl)).text();
  console.log(
    `[probe-A] answer "${answerLabel}" → rebuild in ${rebuildMs}ms; mock AFTER: ${mockAfter.length} bytes sha256/16=${sha256(mockAfter)} url=${rebuilt.previewUrl}`,
  );
  expect(mockAfter, "the served mock bytes actually changed").not.toBe(mockBefore);
  expect(sha256(mockAfter)).not.toBe(sha256(mockBefore));
  expect(mockAfter, "the rebuilt mock carries the decision marker").toContain("data-decision-applied");
  expect(mockAfter, "the decision text is the chosen answer").toContain(answerLabel);
  // Old URL vs new URL: the version stamp moved (build-stamp check).
  expect(rebuilt.previewUrl, "the preview URL version-bumped").not.toBe(deck.previewUrl);
  await wall.page.screenshot({ path: join(SHOTS, "A-mock-rebuilt.png") });
});

// ─── B ───────────────────────────────────────────────────────────────────────
test("B: both surfaces share the three verbs with subtitles; a forced 500 fails LOUDLY on both, and recovery works", async ({
  room,
  wall,
  rig,
}) => {
  const nonce = `probeb${Math.random().toString(36).slice(2, 7)}`;
  const target = await speakAndAccept(room, wall, nonce);
  const deck = await waitForDeck(room);
  await waitForWallDeck(wall.page, target.upid, deck.slideshowUrl);
  const frame = await openDeckAt(wall, target.callsign);

  // Park the deck on its decision slide FIRST (an inactive slide is
  // display:none — its innerText reads empty) so both surfaces are on screen.
  await gotoDeckSlide(wall.page, frame, "section[data-slide]:has([data-decisions])");

  // --- one vocabulary across both surfaces ---------------------------------
  const nativeVerbs = await wall.page.$$eval('[data-testid="deck-decision"] .decision-choice', (nodes) =>
    nodes.map((node) => (node.textContent ?? "").trim()),
  );
  const nativeDetails = await wall.page.$$eval('[data-testid="deck-decision"] .decision-detail', (nodes) =>
    nodes.map((node) => (node.textContent ?? "").trim()),
  );
  const deckVerbs = (await frame.locator("[data-decisions] [data-decision] .decision-label").allTextContents()).map((verb) =>
    verb.trim(),
  );
  const deckDetails = (await frame.locator("[data-decisions] [data-decision] .decision-detail").allTextContents()).map((detail) =>
    detail.trim(),
  );
  console.log(`[probe-B] native verbs: ${JSON.stringify(nativeVerbs)}`);
  console.log(`[probe-B] native subtitles: ${JSON.stringify(nativeDetails)}`);
  console.log(`[probe-B] in-deck verbs: ${JSON.stringify(deckVerbs)}`);
  console.log(`[probe-B] in-deck subtitles: ${JSON.stringify(deckDetails)}`);
  expect(nativeVerbs, "native bar renders three verbs").toHaveLength(3);
  expect(deckVerbs, "same three verbs on the in-deck slide").toEqual(nativeVerbs);
  expect(nativeDetails.filter((detail) => detail.length > 0), "every native verb has a visible subtitle").toHaveLength(3);
  expect(deckDetails.filter((detail) => detail.length > 0), "every in-deck verb has a visible subtitle").toHaveLength(3);
  await wall.page.screenshot({ path: join(SHOTS, "B-two-surfaces.png") });

  // --- forced 500 on the execute route (800ms delayed so the synchronous
  //     acknowledgement window is observable) ------------------------------
  await wall.page.route("**/execute", async (route) => {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 800));
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "forced 500 by verifier probe" }),
    });
  });

  // Native surface: press → synchronous ack (strip appears BEFORE the POST
  // resolves) → loud failure → the question re-opens. No launch recorded.
  await wall.page.locator('[data-testid="decision-commission"]').click();
  await expect(
    wall.page.locator('[data-testid="decision-status-commissioned"]'),
    "synchronous acknowledgement precedes the (delayed) response",
  ).toBeVisible({ timeout: 700 });
  await expect(wall.page.locator('[data-testid="guided-epilogue"]'), "the native failure notice is VISIBLE").toContainText(
    /Commission failed \(500\)/u,
    { timeout: 5_000 },
  );
  await expect(wall.page.locator('[data-testid="deck-decision"]'), "the decision bar re-opens after failure").toBeVisible();
  expect(rig.launches.length, "no launch on a failed native commission").toBe(0);
  await wall.page.screenshot({ path: join(SHOTS, "B-forced-500-native.png") });

  // In-deck surface: sent-ack → loud failure line → buttons re-enabled.
  await frame.locator("[data-decision-status]").evaluate((element) => {
    const log: string[] = [];
    (window as unknown as { __statusLog: string[] }).__statusLog = log;
    new MutationObserver(() => log.push(element.textContent ?? "")).observe(element, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  });
  await frame.locator('[data-decision="execute"]').click();
  await expect(frame.locator("[data-decision-status]"), "the in-deck failure line is VISIBLE").toContainText(/Commission failed/u, {
    timeout: 5_000,
  });
  const statuses = await frame
    .locator("[data-decision-status]")
    .evaluate(() => (window as unknown as { __statusLog: string[] }).__statusLog);
  console.log(`[probe-B] in-deck status sequence under forced 500: ${JSON.stringify(statuses)}`);
  expect(
    statuses.some((status) => status.includes("Choice sent")),
    "the in-deck press acknowledged synchronously (Choice sent)",
  ).toBe(true);
  await expect(frame.locator('[data-decision="execute"]'), "buttons re-enabled after the failure").toBeEnabled();
  expect(rig.launches.length, "still no launch after the bridged failure").toBe(0);
  await wall.page.screenshot({ path: join(SHOTS, "B-forced-500-indeck.png") });

  // --- recovery: drop the fault, press again, the real commission lands ----
  await wall.page.unroute("**/execute");
  const executePromise = wall.page.waitForResponse(
    (response) => response.url().includes("/execute") && response.request().method() === "POST",
    { timeout: 6_000 },
  );
  await frame.locator('[data-decision="execute"]').click();
  const executeResponse = await executePromise;
  console.log(`[probe-B] recovery commission POST → ${executeResponse.status()}`);
  expect(executeResponse.status(), "the recovery commission answered 200").toBe(200);
  await expect(frame.locator("[data-decision-status]")).toContainText("Commissioned — the real build is running");
  await expect(wall.page.locator('[data-testid="decision-status-commissioned"]')).toBeVisible();
  expect(rig.launches.length, "exactly one launch after recovery").toBe(1);
  await wall.page.screenshot({ path: join(SHOTS, "B-recovered-success.png") });
});

// ─── C ───────────────────────────────────────────────────────────────────────
test("C: commission starts the scripted implementation ONCE (both surfaces pressed); real files land while executing", async ({
  room,
  wall,
  rig,
}) => {
  const nonce = `probec${Math.random().toString(36).slice(2, 7)}`;
  const target = await speakAndAccept(room, wall, nonce);
  const deck = await waitForDeck(room);
  await waitForWallDeck(wall.page, target.upid, deck.slideshowUrl);
  const frame = await openDeckAt(wall, target.callsign);
  await gotoDeckSlide(wall.page, frame, "section[data-slide]:has([data-decisions])");

  // File-timeline sampler: what is REALLY on disk, every 120ms.
  const timeline: Array<{ atMs: number; files: string[] }> = [];
  const sampler = setInterval(() => {
    const files = listRunFiles(target.upid);
    const last = timeline.at(-1);
    if (last === undefined || last.files.join(",") !== files.join(",")) {
      timeline.push({ atMs: Date.now(), files });
    }
  }, 120);

  const commissionAtMs = Date.now();
  const firstPostPromise = wall.page.waitForResponse(
    (response) => response.url().includes("/execute") && response.request().method() === "POST",
    { timeout: 6_000 },
  );
  await wall.page.locator('[data-testid="decision-commission"]').click();
  const firstPost = await firstPostPromise;
  console.log(`[probe-C] native commission POST → ${firstPost.status()} in ${Date.now() - commissionAtMs}ms`);
  expect(firstPost.status()).toBe(200);
  expect(rig.launches.length, "one launch after the native press").toBe(1);

  // Adversarial second surface: the in-deck 🚀 is still enabled (no bridge
  // result was addressed to it) — press it while the run executes.
  const secondPostPromise = wall.page.waitForResponse(
    (response) => response.url().includes("/execute") && response.request().method() === "POST",
    { timeout: 6_000 },
  );
  await frame.locator('[data-decision="execute"]').click();
  const secondPost = await secondPostPromise;
  const secondBody = await secondPost.text();
  console.log(`[probe-C] cross-surface second press → ${secondPost.status()} body=${secondBody.slice(0, 160)}`);
  const indeckStatusAfterSecond = await frame.locator("[data-decision-status]").innerText();
  const nativeStripVisible = await wall.page.locator('[data-testid="decision-status-commissioned"]').isVisible();
  console.log(
    `[probe-C] after second press: in-deck status="${indeckStatusAfterSecond.trim()}" nativeCommissionedStrip=${nativeStripVisible}`,
  );

  // THE criterion: exactly ONE launch ever reached the gateway.
  expect(rig.launches.length, "no double-fire across surfaces").toBe(1);
  expect(rig.launches[0]!.workflow).toBe("vibersyn-process");
  expect(rig.launches[0]!.input.upid).toBe(target.upid);

  // Files land over REAL time while status is executing.
  const built = (
    await room.waitFor(
      (snapshot) => {
        const execution = executionOf(snapshot.processes[0] as ProjectorProcess);
        if (execution?.status === "failed") {
          throw new Error(`commission failed: ${execution.summary ?? "(no reason)"}`);
        }
        return execution?.status === "built" && execution.previewUrl !== null ? execution : false;
      },
      { label: "the built execution lane", timeoutMs: 30_000 },
    )
  ).value;
  clearInterval(sampler);
  const relative = timeline.map((entry) => `${entry.atMs - commissionAtMs}ms:[${entry.files.join(",")}]`);
  console.log(`[probe-C] on-disk file timeline (commission-relative): ${relative.join(" → ")}`);
  console.log(`[probe-C] commission → BUILT: ${Date.now() - commissionAtMs}ms; final footprint filesWritten=${built.filesWritten}`);
  const partials = timeline.filter((entry) => entry.files.length > 0 && entry.files.length < 3);
  expect(partials.length, "files appeared INCREMENTALLY on disk during the run (not all at once)").toBeGreaterThan(0);
  expect(timeline.at(-1)!.files, "the finished run's real footprint").toEqual(["app.js", "index.html", "style.css"]);
  expect(built.filesWritten).toBe(3);
  expect(rig.launches.length, "STILL exactly one launch after built").toBe(1);
  await wall.page.screenshot({ path: join(SHOTS, "C-built-once.png") });
});

// ─── D ───────────────────────────────────────────────────────────────────────
test("D: pausing the scripted runner FREEZES footprint/percent/label — no invented motion", async ({ room, wall, rig }) => {
  const nonce = `probed${Math.random().toString(36).slice(2, 7)}`;
  const target = await speakAndAccept(room, wall, nonce);
  const deck = await waitForDeck(room);
  await waitForWallDeck(wall.page, target.upid, deck.slideshowUrl);
  await openDeckAt(wall, target.callsign);

  rig.armHold(2); // pause the scripted implementation after 2 files
  await wall.page.locator('[data-testid="decision-commission"]').click();
  await expect(wall.page.locator('[data-testid="decision-status-commissioned"]')).toBeVisible();
  await rig.whenHeld();
  console.log(`[probe-D] runner parked after 2 files (hold armed before commission)`);

  // Wait for the room's footprint probe (1.5s cadence) to see both files.
  await room.waitFor(
    (snapshot) => {
      const execution = executionOf(snapshot.processes[0] as ProjectorProcess);
      return execution?.status === "executing" && execution.filesWritten === 2 ? true : false;
    },
    { label: "footprint caught up to the 2 real files", timeoutMs: 10_000 },
  );

  // FREEZE WINDOW: 6s of samples while the runner is genuinely idle. The loop
  // is kept LIGHT (one state GET + one combined evaluate per lap) so the
  // sample cadence stays near the intended ~350ms.
  const freeze: Array<{ files: number | null; percent: number | null; label: string | null; status: string; chip: string }> = [];
  const freezeStartMs = Date.now();
  while (Date.now() - freezeStartMs < 6_000) {
    const snapshot = await room.state();
    const execution = executionOf(snapshot.processes[0] as ProjectorProcess);
    const chip = await wall.page.evaluate(async () => {
      const response = await fetch("/api/state", { headers: { accept: "application/json" } });
      if (response.ok) {
        const fresh = (await response.json()) as Parameters<NonNullable<typeof window.__VIBERSYN__>["applySnapshot"]>[0];
        window.__VIBERSYN__?.applySnapshot(fresh);
      }
      return (document.querySelector('[data-testid="execution-chip-footprint"]')?.textContent ?? "(no chip)").trim();
    });
    if (execution !== null) {
      freeze.push({
        files: execution.filesWritten,
        percent: execution.percent,
        label: execution.progressLabel,
        status: execution.status,
        chip,
      });
    }
    await wall.page.waitForTimeout(250);
  }
  console.log(
    `[probe-D] freeze-window samples (${freeze.length}): ${JSON.stringify(freeze.map((s) => `${s.status}:${s.files}f:${s.percent}%:"${s.label}":chip"${s.chip}"`))}`,
  );
  await wall.page.screenshot({ path: join(SHOTS, "D-frozen-mid-run.png") });
  // The honesty criterion is TIME-based: ≥4 samples spread over the 6s idle
  // window (each lap costs a real state GET + a wall resync round trip).
  expect(freeze.length).toBeGreaterThanOrEqual(4);
  for (const sample of freeze) {
    expect(sample.status, "the lane stays executing while paused").toBe("executing");
    expect(sample.files, "footprint does NOT move while the runner is paused").toBe(2);
    expect(sample.percent, "percent does NOT invent motion while paused").toBe(freeze[0]!.percent);
    expect(sample.label, "the label stays on the last real event").toBe(freeze[0]!.label);
  }
  const chipFiles = freeze.map((sample) => /(\d+) files? on disk/u.exec(sample.chip)?.[1] ?? "(none)");
  expect(
    chipFiles.every((count) => count === "2"),
    `the wall chip pinned to the REAL 2-file footprint all through the pause (saw ${JSON.stringify([...new Set(chipFiles)])})`,
  ).toBe(true);

  // RELEASE: the run completes, footprint settles at the true 3.
  rig.release();
  const built = (
    await room.waitFor(
      (snapshot) => {
        const execution = executionOf(snapshot.processes[0] as ProjectorProcess);
        return execution?.status === "built" ? execution : false;
      },
      { label: "the released run building", timeoutMs: 20_000 },
    )
  ).value;
  console.log(`[probe-D] released → built with filesWritten=${built.filesWritten} percent=${built.percent}`);
  expect(built.filesWritten).toBe(3);
  expect(built.percent).toBe(100);
  await wall.page.screenshot({ path: join(SHOTS, "D-released-built.png") });
});

// ─── E ───────────────────────────────────────────────────────────────────────
test("E: every decide/question/answer control is reachable at 1920x1080 on the GESTURE wall", async ({ room, wall }) => {
  const nonce = `probee${Math.random().toString(36).slice(2, 7)}`;
  const target = await speakAndAccept(room, wall, nonce, GESTURE_WALL);
  const deck = await waitForDeck(room);
  await waitForWallDeck(wall.page, target.upid, deck.slideshowUrl);
  await wall.page.screenshot({ path: join(SHOTS, "E-gesture-wall.png") });
  const frame = await openDeckAt(wall, target.callsign);

  const failures: string[] = [];
  const report = (name: string, rows: Array<{ text: string; reachable: boolean; why: string }>) => {
    for (const row of rows) {
      console.log(`[probe-E] ${name} ${row.reachable ? "REACHABLE  " : "UNREACHABLE"} "${row.text}" — ${row.why}`);
      if (!row.reachable) {
        failures.push(`${name}: "${row.text}" (${row.why})`);
      }
    }
  };

  // 1. The native decision bar (the dwell layer's sanctioned decide surface).
  const decisionRows = await probeDwellReachability(wall.page, '[data-testid="deck-decision"] button');
  expect(decisionRows.length, "three native decision buttons").toBe(3);
  report("native-decision", decisionRows);

  // 2. Native deck chrome a dwell user needs mid-decision: slide nav + close.
  await revealDeckBottom(wall.page);
  report("native-deck-nav", await probeDwellReachability(wall.page, '[data-testid="slide-prev"], [data-testid="slide-next"]'));
  report("native-deck-dots", await probeDwellReachability(wall.page, ".slide-dot"));
  report("native-deck-close", await probeDwellReachability(wall.page, '[data-testid="slideshow-close"]'));
  await wall.page.screenshot({ path: join(SHOTS, "E-deck-decision-bar.png") });

  // 3. QUESTION card answers (in-iframe; pointer/touch contract — the dwell
  //    layer's DOM sweep is main-document only, decisions are bridged natively).
  await gotoDeckSlide(wall.page, frame, "section[data-question-slide]:not([data-decided-slide])");
  const answerRows = await probeFrameReachability(wall.page, frame, "section.active [data-answer]");
  expect(answerRows.length, "the active question card offers answers").toBeGreaterThan(1);
  report("in-deck-answer", answerRows);
  await wall.page.screenshot({ path: join(SHOTS, "E-question-card.png") });

  // 4. The in-deck decision slide buttons (same composite contract).
  await gotoDeckSlide(wall.page, frame, "section[data-slide]:has([data-decisions])");
  const deckDecisionRows = await probeFrameReachability(wall.page, frame, "section.active [data-decision]");
  expect(deckDecisionRows.length, "the in-deck decision slide offers the three verbs").toBe(3);
  report("in-deck-decision", deckDecisionRows);
  await wall.page.screenshot({ path: join(SHOTS, "E-decision-slide.png") });

  // 5. Commission for real (native bar) so the tree's Live-app row exists,
  //    then probe it — the journey's ending must be dwell-reachable too.
  await wall.page.locator('[data-testid="decision-commission"]').click();
  await expect(wall.page.locator('[data-testid="decision-status-commissioned"]')).toBeVisible();
  await room.waitFor(
    (snapshot) => {
      const execution = executionOf(snapshot.processes[0] as ProjectorProcess);
      return execution?.status === "built" && execution.previewUrl !== null ? true : false;
    },
    { label: "the built execution lane", timeoutMs: 30_000 },
  );
  await wall.page.locator('[data-testid="slideshow-close"]').click();
  const deadline = Date.now() + 15_000;
  for (;;) {
    await resyncWallSnapshot(wall.page);
    await wall.page.evaluate((id) => window.__VIBERSYN__?.select(id), target.callsign);
    if ((await wall.page.locator('[data-testid="tree-menu-live"]').count()) > 0) {
      break;
    }
    if (Date.now() > deadline) {
      throw new Error("the Live app row never grew on the gesture wall");
    }
    await wall.page.waitForTimeout(300);
  }
  const liveRows = await probeDwellReachability(wall.page, '[data-testid="tree-menu-live"]');
  expect(liveRows.length, "the Live app row exists").toBe(1);
  report("tree-menu-live", liveRows);
  await wall.page.screenshot({ path: join(SHOTS, "E-live-app-row.png") });

  expect(failures, "every probed control is reachable").toEqual([]);
});
