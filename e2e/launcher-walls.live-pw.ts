// JOURNEY: THE OPERATOR STARTS THE ROOM AND LOOKS AT THE WALL.
//
// Every other spec in this suite opens `/?wall=A&flat=1`, which is the URL the
// operator typed by hand while debugging. This one opens the URLs the LAUNCHER
// itself builds — run-room.sh:457-458:
//
//   URL_A="…/?live=1&wall=A&view=ideas…$FLAT_QS"
//   URL_B="…/?live=1&wall=B&view=builds…$FLAT_QS"
//
// (`$HANDS_QS` is dropped here on purpose: it points the window at a TouchDesigner
// bridge that is not running in a test, and it does not touch either surface
// under test. `$GESTURE_QS`/`$MOCK_QS` are empty in the room's default launch.)
//
// The room has exactly two core surfaces: a microphone to talk into, and a
// transcript that proves the room heard you. This spec asserts each projected
// wall has the one it is supposed to have — driven by real speech, not fixtures.

import { expect, reportCoverage, test } from "./live-room";
import { measure } from "./journey";

/** Speech must be on the wall within one SSE frame plus a paint. */
const TRANSCRIPT_BUDGET_MS = 1_500;

const LAUNCHER_WALL_A = "/?live=1&wall=A&view=ideas&flat=1";
const LAUNCHER_WALL_B = "/?live=1&wall=B&view=builds&flat=1";

test("wall A, exactly as run-room.sh opens it, shows the words that were just spoken", async ({ room, wall }) => {
  await reportCoverage(room, "launcher-walls");
  await wall.open(LAUNCHER_WALL_A);

  // Provenance: a nonce nobody could have fixtured.
  const nonce = `zephyr ${Math.random().toString(36).slice(2, 8)}`;
  const spoken = await room.speak({ utterances: [{ text: `lets build a status board called ${nonce}` }] });
  const said = spoken.script.finals[0]!;

  // The server heard it — so any failure below is the WALL, not the ear.
  const onServer = await room.waitFor(
    (snapshot) => snapshot.transcript.some((line) => line.text.includes(nonce)),
    { label: "the nonce in /api/state.transcript", timeoutMs: 5_000 },
  );
  console.log(`[launcher-walls] server folded the nonce in ${onServer.elapsedMs}ms after the line committed`);

  const panel = wall.page.locator('[data-region="transcript"]');
  const mounted = await measure(async () => (await panel.count()) > 0, { timeoutMs: TRANSCRIPT_BUDGET_MS });
  console.log(`[launcher-walls] wall A transcript panel present=${mounted.ok} after ${mounted.elapsedMs}ms`);

  // The whole point of the room: you talk, and the wall proves it heard you.
  expect(
    mounted.ok,
    `the projected wall A (${LAUNCHER_WALL_A}) has a transcript region at all — App.tsx:1723 showBuildSurfaces = view !== "ideas" deletes the entire <aside class="rail"> that contains it`,
  ).toBe(true);
  await expect(panel, `wall A painted "${said}"`).toContainText(nonce, { timeout: TRANSCRIPT_BUDGET_MS });
});

test("wall B, exactly as run-room.sh opens it, can arm the microphone", async ({ room, wall }) => {
  await wall.open(LAUNCHER_WALL_B);

  const mic = wall.page.locator('[data-testid="mic-capture-button"]');
  const unmute = wall.page.locator('[data-testid="unmute-button"]');
  const present = await measure(async () => (await mic.count()) > 0, { timeoutMs: 2_000 });
  console.log(
    `[launcher-walls] wall B mic button present=${present.ok} (unmute present=${(await unmute.count()) > 0}) after ${present.elapsedMs}ms`,
  );

  // If the transcript only lives on B and the mic only lives on A, then neither
  // projected window is a room: one hears nothing, the other says nothing.
  expect(
    present.ok,
    `the projected wall B (${LAUNCHER_WALL_B}) can start listening — App.tsx:1722 showIdeaSurfaces = view !== "builds" deletes the mic, Auto-Build, Self-Rebuild, Research and Guided Demo`,
  ).toBe(true);

  // Sanity, so a red test above cannot be blamed on a broken boot: the wall did
  // render (the 3D garden is there), it is only the controls that are missing.
  await expect(wall.page.locator('[data-testid="room-scene"]')).toBeVisible();
  expect(await room.state()).toBeTruthy();
});
