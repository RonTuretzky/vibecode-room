// THE HEADLINE JOURNEY: somebody talks in the room, and the wall shows it.
//
// This is the spec the operator's first complaint maps onto — "the TRANSCRIPT
// panel renders EMPTY while GET /api/state carries 40 live transcript lines".
// Nothing in the repo could see that before: every browser spec loads ?live=0
// and pushes fixtures through window.__VIBERSYN__.applySnapshot, so a
// server↔wall divergence is structurally invisible to them.
//
// Here the server is real, the speech is injected through the real /api/mic
// WebSocket, and the assertion is the real wall's DOM. The two halves of the
// wait — spoken→published (SSE) and spoken→painted (DOM) — are measured
// separately so a slow room can be blamed on the right side.

import { expect, reportCoverage, test } from "./live-room";
import { formatStreamCost, formatSummary, joinLatency, missingFinals, streamCost, summarize } from "../src/testing/latency-ledger";

// Budgets. A green test that took four seconds is a finding, not a pass.
const SSE_P95_BUDGET_MS = 1_000;
const DOM_P95_BUDGET_MS = 2_000;

test("spoken lines reach the wall's transcript panel, and the wall shows everything the server has", async ({
  room,
  wall,
}) => {
  await reportCoverage(room, "speech-to-wall");
  await wall.open();

  // Somebody says three things, with real pauses between them. Interim
  // hypotheses tick at ~220ms and each line commits after the room's own
  // 900ms endpointing window (src/server/composition.ts MIC_ENDPOINTING_BASE_MS).
  const spoken = await room.speak({
    utterances: [
      { text: "we should build a blocker announcer for the room" },
      { text: "and a status wall that shows every running agent", pauseBeforeMs: 600 },
      { text: "then hang the deploy links on each tree", pauseBeforeMs: 600 },
    ],
  });

  // --- the server heard it ---------------------------------------------------
  const snapshot = await room.state();
  const serverLines = snapshot.transcript.filter((line) => line.kind === "room").map((line) => line.text);
  for (const said of spoken.script.finals) {
    expect(serverLines, "the server folded every committed utterance into its transcript").toContain(said);
  }

  // --- the wall shows it -----------------------------------------------------
  const panel = wall.page.locator('[data-region="transcript"]');
  await expect(panel, "the wall renders a transcript panel at all").toBeVisible();
  for (const said of spoken.script.finals) {
    await expect(panel, `the wall painted "${said}"`).toContainText(said, { timeout: DOM_P95_BUDGET_MS + 3_000 });
  }

  // --- THE reported bug, as a direct assertion -------------------------------
  // Not "some text appeared" but "the DOM is a superset of what /api/state
  // carries". An empty panel over a populated snapshot fails right here.
  const painted = await wall.transcriptLines();
  const paintedBlob = painted.join("\n");
  const dropped = serverLines.filter((line) => !paintedBlob.includes(line));
  expect(dropped, "every /api/state transcript line is on the wall").toEqual([]);

  // --- responsivity, as numbers ---------------------------------------------
  const observations = [...room.sseTranscriptObservations(), ...(await wall.paints())];
  const samples = joinLatency(spoken.emits, observations);
  const sse = summarize(samples, "sse");
  const dom = summarize(samples, "dom");
  const cost = streamCost(
    room.sseFrames().map((frame) => ({ bytes: frame.bytes })),
    room.sseWindowMs(),
    spoken.script.finals.length,
  );
  console.log(`[speech-to-wall] ${formatSummary(sse)}`);
  console.log(`[speech-to-wall] ${formatSummary(dom)}  (DOM clock quantized to the 16ms paint scan)`);
  console.log(`[speech-to-wall] ${formatStreamCost(cost)}`);
  console.log(`[speech-to-wall] mic bytes pushed over the real /api/mic socket: ${spoken.bytesSent}`);

  expect(missingFinals(spoken.emits, observations, "dom"), "no committed line was lost between server and wall").toEqual(
    [],
  );
  expect(sse.count, "every committed line was observed on the SSE stream").toBe(spoken.script.finals.length);
  expect(sse.p95Ms, `spoken→published p95 within ${SSE_P95_BUDGET_MS}ms (measured ${sse.p95Ms}ms)`).toBeLessThanOrEqual(
    SSE_P95_BUDGET_MS,
  );
  expect(dom.p95Ms, `spoken→painted p95 within ${DOM_P95_BUDGET_MS}ms (measured ${dom.p95Ms}ms)`).toBeLessThanOrEqual(
    DOM_P95_BUDGET_MS,
  );
});

test("an interim hypothesis is visible on the wall before the line commits", async ({ room, wall }) => {
  await wall.open();

  // Started, not awaited: assertions run WHILE the person is still talking.
  const session = await room.startSpeaking({
    utterances: [{ text: "lets put a live deploy badge on the atlas tree", interimEveryMs: 300, endpointMs: 1_500 }],
  });
  const panel = wall.page.locator('[data-region="transcript"]');

  // A partial hypothesis paints long before the final commits.
  await expect(panel, "a partial hypothesis is on the wall mid-sentence").toContainText("lets put a live", {
    timeout: 8_000,
  });
  const midSentence = await wall.transcriptLines();

  await session.done;
  const spoken = await session.close();
  await expect(panel).toContainText(spoken.script.finals[0]!, { timeout: 5_000 });

  // HONEST FINDING, asserted rather than narrated: the wall gives an interim
  // and a committed line the SAME treatment. TranscriptLine (src/ui/types.ts)
  // has no interim flag, composition stamps both kind:"room", and
  // TranscriptStream renders them identically — so a half-heard sentence is
  // indistinguishable from something the room actually committed.
  const interimLine = midSentence.find((line) => line.startsWith("lets put a live"));
  expect(interimLine, "an interim was rendered as a normal transcript line").toBeDefined();
  const interimClasses = await wall.page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-region="transcript"] .tx-line')).map((node) => node.className),
  );
  expect(
    new Set(interimClasses).size,
    "interim and committed lines carry the same class — the wall cannot distinguish them",
  ).toBeLessThanOrEqual(2);
});
