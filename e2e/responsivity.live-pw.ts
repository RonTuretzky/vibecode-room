// RESPONSIVITY — the operator's "the responsivity sucks", as a number.
//
// A real conversation is spoken into a real room and every committed line is
// tracked spoken → published (SSE) → painted (DOM). The output is a latency
// table and a stream-cost line, both printed on every run, plus budgets that
// fail the test when the room gets slower.
//
// The second test in this file drives the transcript to its 40-line cap and
// then records a change — the state a room reaches after a few minutes of
// conversation, which no existing test can reach because no existing test
// speaks.

import { expect, reportCoverage, test } from "./live-room";
import { formatStreamCost, formatSummary, joinLatency, missingFinals, streamCost, summarize } from "../src/testing/latency-ledger";

const SSE_P95_BUDGET_MS = 1_000;
const DOM_P95_BUDGET_MS = 2_000;

/** src/server/composition.ts MAX_LIVE_TRANSCRIPT_LINES. */
const MAX_LIVE_TRANSCRIPT_LINES = 40;

// See e2e/popup-lifetime.live-pw.ts: the tree menu self-closes in ~1.8s on the
// default wall URL, which would eat the record window before this spec could
// assert anything about it. `&remote=0` isolates the defect under test here.
const WALL_WITHOUT_POPUP_BUG = "/?wall=A&flat=1&remote=0";

test("a sustained conversation stays inside the responsivity budget", async ({ room, wall }) => {
  await reportCoverage(room, "responsivity");
  await wall.open();

  const lines = [
    "the deploy keeps failing on the staging box",
    "we should build a blocker announcer for the room",
    "it needs to read the last failure out loud",
    "and a status wall that shows every running agent",
    "put the deploy links on each tree as fruit",
    "the garden should show which branch is live",
    "add a panel for the open pull requests",
    "then let us merge one by talking to it",
  ];
  const spoken = await room.speak({
    utterances: lines.map((text, index) => ({ text, pauseBeforeMs: index === 0 ? 0 : 450 })),
  });

  const panel = wall.page.locator('[data-region="transcript"]');
  await expect(panel).toContainText(lines[lines.length - 1]!, { timeout: 8_000 });

  const observations = [...room.sseTranscriptObservations(), ...(await wall.paints())];
  const samples = joinLatency(spoken.emits, observations);
  const sse = summarize(samples, "sse");
  const dom = summarize(samples, "dom");
  const cost = streamCost(
    room.sseFrames().map((frame) => ({ bytes: frame.bytes })),
    room.sseWindowMs(),
    spoken.script.finals.length,
  );

  console.log(`[responsivity] ${formatSummary(sse)}`);
  console.log(`[responsivity] ${formatSummary(dom)}`);
  console.log(`[responsivity] ${formatStreamCost(cost)}`);
  console.log(
    `[responsivity] publish amplification: ${cost.frames} SSE frames for ${spoken.script.finals.length} committed lines` +
      ` — publish() is unthrottled and every INTERIM republishes the whole snapshot (processes, trace ring, dialogue, topics).`,
  );

  expect(missingFinals(spoken.emits, observations, "dom"), "no line was lost between the room and the wall").toEqual([]);
  expect(sse.p95Ms, `spoken→published p95 (measured ${sse.p95Ms}ms)`).toBeLessThanOrEqual(SSE_P95_BUDGET_MS);
  expect(dom.p95Ms, `spoken→painted p95 (measured ${dom.p95Ms}ms)`).toBeLessThanOrEqual(DOM_P95_BUDGET_MS);
});

test("after the transcript hits its 40-line cap, the record window still echoes what it hears", async ({
  room,
  wall,
}) => {
  await wall.open(WALL_WITHOUT_POPUP_BUG);

  // Fill past the cap. Short, interim-free utterances so this costs seconds,
  // not minutes — the cadence is unrealistic here on purpose; the STATE it
  // produces (transcript pinned at MAX_LIVE_TRANSCRIPT_LINES) is the point.
  const filler = Array.from({ length: MAX_LIVE_TRANSCRIPT_LINES + 5 }, (_unused, index) => ({
    text: `filler line number ${index + 1} about the deploy`,
    interims: [] as string[],
    interimEveryMs: 60,
    endpointMs: 60,
  }));
  await room.speak({ utterances: filler });

  const capped = await room.state();
  expect(capped.transcript.length, "the live transcript is pinned at its cap").toBe(MAX_LIVE_TRANSCRIPT_LINES);

  // Now do the thing the operator does: record a change.
  const target = capped.processes[0]!;
  await wall.page.evaluate((callsign) => window.__VIBERSYN__?.select(callsign), target.callsign);
  await wall.page.locator('[data-testid="record-steer-start"]').first().click();
  await room.waitFor((snapshot) => snapshot.steeringUpid === target.upid, { label: "record armed", timeoutMs: 5_000 });

  const spoken = await room.speak({ utterances: [{ text: "swap the hero image for the new render" }] });

  // The server heard it — collect fired.
  const traces = await room.traces();
  expect(
    traces.filter((entry) => entry.event === "steering.window.collect"),
    "the window collected the new line",
  ).toHaveLength(1);

  // ...and this is where it breaks. RecordSteerToggle watermarks the window by
  // ARRAY LENGTH (`armMark = transcript.length`, then `transcript.slice(armMark)`).
  // At the cap the array stops growing, so `heard` is permanently empty: the
  // panel shows its "listening — say the whole change" empty state while the
  // operator is talking, and the frozen "✓ got it" panel afterwards lists
  // nothing. This is literally "the room lost my recording".
  const echo = wall.page.locator('[data-testid="record-steer-heard"]');
  await expect(echo, `the record panel echoed "${spoken.script.finals[0]}" after the cap`).toContainText(
    spoken.script.finals[0]!,
    { timeout: 6_000 },
  );
});
