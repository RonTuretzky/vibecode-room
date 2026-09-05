// JOURNEY: "is this room actually working, or is it pretending?"
//
// The room already computes the answer. GET /api/health returns
// `degradation.degraded[]` — every leg that is running on a stand-in (silent
// TTS, no-op audio sink, heuristic decision LLM instead of a model, in-memory
// Smithers whose "runs" are fixtures). The boot log prints it once.
//
// Nothing on the wall ever says it. There is no fetch of /api/health anywhere
// in src/ui, so a room with a fake build substrate and a fake judge looks
// EXACTLY like a fully-real room to everyone standing in it — which is the
// literal content of the operator's complaint that the app "is weirdly mocked
// in many places" and they cannot tell where.
//
// This spec asserts the wall renders what the server already knows. It uses the
// SAME legs the live room reports (tts:noop + sink:noop are degraded there too).

import { expect, reportCoverage, test } from "./live-room";
import { wallText } from "./journey";

const WALL = "/?wall=A&flat=1";

test("a degraded room admits it on the wall", async ({ room, wall }) => {
  await reportCoverage(room, "degradation");
  await wall.open(WALL);

  const health = await room.health();
  const degraded = health.degradation.degraded;
  console.log(
    `[degradation] /api/health: allReal=${health.degradation.allReal} degraded=[${degraded.map((leg) => `${leg.leg}:${leg.mode}`).join(", ")}]`,
  );
  expect(degraded.length, "this boot is degraded, so there is something to render").toBeGreaterThan(0);

  await wall.page.getByRole("button", { name: /^Projects \(/ }).click();
  await wall.page.getByText("Providers · fallback services active", { exact: true }).click();
  const text = await wallText(wall.page);
  for (const leg of degraded) expect(text).toContain(leg.leg);
});
