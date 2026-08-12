// JOURNEY: THE ROOM DIES AND THE WALL KEEPS SMILING.
//
// The room restarts itself constantly — a self-steer cuts a branch and reboots
// the server (App.tsx trackBootId), `bun run build` swaps dist under the walls,
// and the machine gets closed and reopened. What a projector wall must never do
// is keep displaying a confident, stale picture of a room that is gone.
//
// The experiment: a live wall with real speech on it, then the server is killed.
// Nothing else changes. The assertion is that a person in the room can tell.
//
// The failure mode this pins (src/ui/App.tsx): the SSE `error` handler closes
// the stream and reconnects with capped backoff (1s → 15s) and NOTHING else —
// no state flag, no badge, no dimming. /api/events also has no heartbeat and
// publish() is content-deduped, so a healthy idle room and a dead room produce
// byte-identical streams: zero bytes.

import { expect, reportCoverage, test } from "./live-room";
import { measure, wallText } from "./journey";

const WALL = "/?wall=A&flat=1";

/** A wall that has lost its room has this long to admit it. */
const NOTICE_BUDGET_MS = 8_000;

const DISCONNECT_WORDS =
  /\b(disconnect|disconnected|offline|reconnect|reconnecting|stale|lost|no connection|not connected|unreachable|waiting for the room)\b/iu;

test("a wall whose room has died says so", async ({ room, wall }) => {
  await reportCoverage(room, "wall-disconnect");
  await wall.open(WALL);

  // Make the wall unambiguously live first: real speech, painted.
  const spoken = await room.speak({ utterances: [{ text: "the room is up and listening right now" }] });
  const said = spoken.script.finals[0]!;
  await expect(wall.page.locator('[data-region="transcript"]')).toContainText(said, { timeout: 8_000 });
  const beforeText = await wallText(wall.page);
  console.log(`[wall-disconnect] live wall says: "${beforeText.slice(0, 160)}"`);

  // The room goes away. (room.stop() is idempotent; the fixture calls it again.)
  const killedAtMs = Date.now();
  await room.stop();

  const noticed = await measure(async () => DISCONNECT_WORDS.test(await wallText(wall.page)), {
    timeoutMs: NOTICE_BUDGET_MS,
    pollMs: 250,
  });
  const afterText = await wallText(wall.page);
  console.log(
    `[wall-disconnect] server killed at t0; wall admitted it after ${noticed.ok ? `${noticed.elapsedMs}ms` : `NEVER (${NOTICE_BUDGET_MS}ms)`}`,
  );

  // The evidence a human would use: the wall is still claiming the room is
  // listening, and still showing the last thing it heard, minutes later.
  const stillClaimsListening = /listening|capturing|ready/iu.test(afterText);
  console.log(
    `[wall-disconnect] ${Date.now() - killedAtMs}ms after the room died the wall still reads: "${afterText.slice(0, 160)}" (claims-live=${stillClaimsListening})`,
  );

  expect(
    noticed.ok,
    `nothing on the wall changed when the room died — src/ui/App.tsx's SSE error handler only schedules a backoff ` +
      `reconnect (1s→15s) and sets no visible state; /api/events has no heartbeat, so a dead room and an idle room ` +
      `look identical. Measured: ${NOTICE_BUDGET_MS}ms with no indicator.`,
  ).toBe(true);
});
