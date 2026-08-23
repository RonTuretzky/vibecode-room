// THE WAKE WORD — the room's deliberate override channel.
//
// "vibersyn, build it" must be executed as a COMMAND and must NOT be folded
// into the ambient idea material (src/server/composition.ts ingestTranscript:
// the wake router takes first claim, before the cue bridge, the record-window
// seal, callsign addressing and detection). Nothing in the repo tests this
// through speech — the wake matcher has unit tests over strings, but no test
// has ever spoken a wake phrase into a running room and watched what the room
// did with it.

import { expect, reportCoverage, test } from "./live-room";

test("a wake-addressed utterance routes as a command and is not treated as room material", async ({ room, wall }) => {
  await reportCoverage(room, "wake-word");
  await wall.open();

  // Say an ordinary sentence first, so there IS ambient material to contrast
  // against, then address the room by name.
  const spoken = await room.speak({
    utterances: [
      { text: "the deploy keeps failing on the staging box" },
      { text: "vibersyn build it", pauseBeforeMs: 700 },
    ],
  });

  const command = await room.waitFor(
    (snapshot) => snapshot.trace.find((entry) => entry.event === "voice.command"),
    { label: "the wake router to claim the utterance", timeoutMs: 5_000 },
  );
  console.log(`[wake-word] wake phrase → voice.command in ${command.elapsedMs}ms of polling`);
  expect(command.value.meta?.matched, "the matcher reports which token window it heard as the name").toBe("vibersyn");
  expect(command.value.meta?.command, "'build it' parses to the build command").toBe("build");

  // Both lines are still on the wall — the room shows you what it heard even
  // when it treats a line as a command.
  const panel = wall.page.locator('[data-region="transcript"]');
  for (const said of spoken.script.finals) {
    await expect(panel).toContainText(said, { timeout: 5_000 });
  }

  // ...but the command must not have become an idea. The heuristic detector is
  // the only detector on this boot (no `claude` CLI is spawned), so any idea
  // present had to come from the ambient line, never from the wake utterance.
  const snapshot = await room.state();
  const ideaText = JSON.stringify(snapshot.suggestion ?? {});
  expect(ideaText.includes("vibersyn build it"), "the wake command was not recycled as room material").toBe(false);
});
