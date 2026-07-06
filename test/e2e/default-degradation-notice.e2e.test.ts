import { describe, expect, test } from "bun:test";
import { createProjectorRuntime } from "../../src/server/composition";
import { formatDegradationNotice } from "../../src/server/degradation-notice";

// e2e: a default-config runtime (no credentials, no gateway) boots emitting a
// notice that enumerates every stubbed leg — silent TTS, no-op sink, heuristic
// decider, replay ASR, and in-memory Smithers — so a degraded deployment is
// explicit rather than silent.
describe("default-degradation-notice", () => {
  test("the default runtime enumerates all five stubbed legs", async () => {
    const runtime = await createProjectorRuntime({});

    const notice = runtime.degradation;
    expect(notice.allReal).toBe(false);
    expect(notice.degraded.map((d) => d.leg).sort()).toEqual(["asr", "decider", "sink", "smithers", "tts"]);

    const text = formatDegradationNotice(notice);
    expect(text).toContain("replay ASR");
    expect(text).toContain("silent TTS");
    expect(text).toContain("no-op audio sink");
    expect(text).toContain("heuristic DecisionLLM");
    expect(text).toContain("in-memory Smithers");
  });
});
