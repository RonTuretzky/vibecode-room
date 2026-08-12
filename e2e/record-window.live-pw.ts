// THE RECORD-A-CHANGE WINDOW — the room's one steering surface.
//
// Journey: dwell a tree → press Record → say the change → press Stop → the room
// acts on the whole thing ONCE. Three separate contracts hide in there and the
// harness drives all three through the real UI:
//   1. COLLECT-ONLY — nothing may dispatch while the window is armed
//      (src/server/composition.ts routeSteering; a sentence that fuzzy-matched a
//      callsign used to fire a commission mid-recording, twice, in the live room).
//   2. THE GRACE — a final that lands within STEER_GRACE_MS (2500ms) after Stop
//      still joins the same dispatch.
//   3. THE ACKNOWLEDGEMENT — after Stop, the room must visibly act.
//
// Contract 3 currently FAILS, and this spec is how it was found. See the
// "the room visibly acts" test below for the measured evidence.

import { expect, reportCoverage, test } from "./live-room";

// STEER_GRACE_MS (src/server/composition.ts) + the timer's own 100ms slack.
// Mirrored as a literal rather than imported: pulling composition.ts into a
// Playwright worker would drag the whole server runtime in with it.
const STEER_GRACE_MS = 2_500;
/** After Stop, the dispatch must be observable within the grace plus slack. */
const DISPATCH_BUDGET_MS = STEER_GRACE_MS + 2_500;

// NOTE ON THE URL: this spec opens the wall with `&remote=0`. That is NOT the
// operator's URL — it is a workaround for a DIFFERENT defect, owned and
// measured by e2e/popup-lifetime.live-pw.ts: on the default wall URL the tree
// menu closes itself after ~1.8s with nobody in the room, so the Record/Stop
// buttons disappear mid-sentence and this contract cannot be reached at all.
// Isolating it here keeps one defect per spec instead of one red test that
// blames everything.
const WALL_WITHOUT_POPUP_BUG = "/?wall=A&flat=1&remote=0";

test("everything said inside the record window is collected and NOTHING dispatches until Stop", async ({
  room,
  wall,
}) => {
  await reportCoverage(room, "record-window");
  await wall.open(WALL_WITHOUT_POPUP_BUG);

  const target = (await room.state()).processes[0]!;

  // Open the tree's anchored menu the way a pick does (App.tsx renders TreeMenu
  // off `selectedProcess`), then press the real Record button in the real menu.
  await wall.page.evaluate((callsign) => window.__VIBERSYN__?.select(callsign), target.callsign);
  await expect(wall.page.locator('[data-testid="tree-menu"]')).toBeVisible();
  await wall.page.locator('[data-testid="record-steer-start"]').first().click();

  const armed = await room.waitFor((snapshot) => snapshot.steeringUpid === target.upid, {
    label: `POST /select to arm ${target.callsign}`,
    timeoutMs: 5_000,
  });
  console.log(`[record-window] arm acknowledged by the server in ${armed.elapsedMs}ms`);
  await expect(wall.page.locator('[data-testid="record-steer-stop"]').first()).toBeVisible();

  const spoken = await room.speak({
    utterances: [
      { text: "make the header blue and give it a footer" },
      { text: "and rename the primary button to launch", pauseBeforeMs: 500 },
    ],
  });

  // (1) COLLECT-ONLY: one collect per committed line, zero dispatches.
  const duringTraces = await room.traces();
  const collects = duringTraces.filter((entry) => entry.event === "steering.window.collect");
  expect(collects, "one collect per committed line inside the window").toHaveLength(spoken.script.finals.length);
  expect(
    duringTraces.filter((entry) => entry.event === "process.steer" || entry.event === "steering.route.error"),
    "nothing is dispatched while the window is still armed",
  ).toEqual([]);

  // The operator must SEE what the window has heard before pressing Stop — the
  // live-room request "show me the text I spoke in the recording component".
  const echo = wall.page.locator('[data-testid="record-steer-heard"]');
  for (const said of spoken.script.finals) {
    await expect(echo, `the record panel echoed "${said}"`).toContainText(said, { timeout: 5_000 });
  }
});

/** Arm the record window on the first tree and say one sentence into it. */
async function recordOneChange(
  room: import("../src/testing/room-harness").RoomUnderTest,
  wall: { page: import("@playwright/test").Page },
  sentence: string,
): Promise<{ upid: string; said: string }> {
  const target = (await room.state()).processes[0]!;
  await wall.page.evaluate((callsign) => window.__VIBERSYN__?.select(callsign), target.callsign);
  await wall.page.locator('[data-testid="record-steer-start"]').first().click();
  await room.waitFor((snapshot) => snapshot.steeringUpid === target.upid, { label: "record armed", timeoutMs: 5_000 });
  const spoken = await room.speak({ utterances: [{ text: sentence }] });
  await wall.page.locator('[data-testid="record-steer-stop"]').first().click();
  await room.waitFor((snapshot) => snapshot.steeringUpid === null, { label: "record disarmed", timeoutMs: 5_000 });
  return { upid: target.upid, said: spoken.script.finals[0]! };
}

test('the "✓ got it" panel lists the change that was just recorded', async ({ room, wall }) => {
  await wall.open(WALL_WITHOUT_POPUP_BUG);
  const { said } = await recordOneChange(room, wall, "make the header blue and give it a footer");

  // The sticky panel exists precisely so stopping never reads as the room
  // losing the recording. It appears — and it is EMPTY.
  //
  // Measured here: the panel renders "✓ got it — shaping this build" followed
  // straight by "🎙 Record another change", with none of the spoken lines
  // between them, even though the LIVE echo showed them a second earlier (see
  // the collect-only test above, which passes).
  //
  // Cause, in src/ui/RecordSteerToggle.tsx: `heard` is gated on `recording`
  //   const heard = recording && ... ? transcript.slice(armMark) : [];
  // and the freeze effect only runs on the recording→stopped edge
  //   useEffect(() => { if (!recording && armMark !== null) setDispatched(heard...) }, [recording])
  // By the time that effect body runs, `recording` is already false, so the
  // `heard` it closes over is the empty branch. `dispatched` is therefore
  // ALWAYS [] — the panel can never show anything, in any room, ever.
  const dispatchedPanel = wall.page.locator('[data-testid="record-steer-dispatched"]');
  await expect(dispatchedPanel, "the wall claims it got the recording").toBeVisible({ timeout: 5_000 });
  await expect(dispatchedPanel, "…and says WHAT it got").toContainText(said);
});

test("pressing Stop makes the room visibly act on the whole recording, once", async ({ room, wall }) => {
  await wall.open(WALL_WITHOUT_POPUP_BUG);
  await recordOneChange(room, wall, "make the header blue and give it a footer");

  // The grace drain DOES run and DOES call registry.steer — the registry record
  // is mutated (lastAction:"steer") and a process.steer trace is written — but
  // #drainSteerGrace never calls publish(), so the cached snapshot behind GET
  // /api/state and the SSE stream never learn about it. Nothing reaches the
  // wall until some UNRELATED event republishes; on a quiet room after Stop,
  // that is never.
  //
  // Measured directly against the runtime: 6s after Stop the snapshot still
  // reads lastAction:"selected-progress" and carries no process.steer trace;
  // speaking one more unrelated sentence makes both appear at once.
  const dispatched = await room.waitFor(
    (snapshot) => snapshot.trace.some((entry) => entry.event === "process.steer"),
    { label: `the dispatch to become visible in /api/state within ${DISPATCH_BUDGET_MS}ms`, timeoutMs: DISPATCH_BUDGET_MS },
  );
  console.log(`[record-window] Stop → dispatch visible on the wire in ${dispatched.elapsedMs}ms`);

  const traces = await room.traces();
  expect(
    traces.filter((entry) => entry.event === "process.steer"),
    "the whole window dispatches EXACTLY once, not once per sentence",
  ).toHaveLength(1);
});
