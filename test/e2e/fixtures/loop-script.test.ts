import { describe, expect, test } from "bun:test";
import { transcriptObservationSchema } from "../../../src/types";
import {
  AFFIRMATION,
  AFFIRMATION_UTTERANCE_ID,
  BUILDABLE_UTTERANCE,
  BUILDABLE_UTTERANCE_ID,
  LOOP_SCRIPT_SESSION_ID,
  buildBuildableOnlyScript,
  buildLoopScript,
  serializeLoopScript,
} from "./loop-script";

// ISSUE-0015 (unit): the shared loop fixture must yield the exact buildable +
// affirmative observation sequence the composition e2e/integration tests depend
// on. If this script drifts, the loop assertions key off the wrong utterance ids
// (or stop firing/accepting), so pin every field here.

describe("loop-script fixture — buildable + affirmative replay script", () => {
  test("buildLoopScript yields a buildable FINAL then an affirmative FINAL", () => {
    const script = buildLoopScript();
    expect(script).toHaveLength(2);

    const [buildable, affirmation] = script;
    // Every observation is a valid, FINAL transcript observation (strict schema).
    for (const observation of script) {
      expect(() => transcriptObservationSchema.parse(observation)).not.toThrow();
      expect(observation.isFinal).toBe(true);
      expect(observation.sessionId).toBe(LOOP_SCRIPT_SESSION_ID);
    }

    // 1) The buildable utterance: an explicit "build" intent with real substance,
    //    keyed by the id the trace assertions use for route.suggestion.
    expect(buildable?.text).toBe(BUILDABLE_UTTERANCE);
    expect(buildable?.text).toContain("build");
    expect(buildable?.utteranceId).toBe(BUILDABLE_UTTERANCE_ID);
    expect(buildable?.text.split(/\s+/).length).toBeGreaterThanOrEqual(3);

    // 2) The affirmation: a bare "yes", keyed by the id the acceptance correlation
    //    chain is reconstructed from.
    expect(affirmation?.text).toBe(AFFIRMATION);
    expect(affirmation?.text).toBe("yes");
    expect(affirmation?.utteranceId).toBe(AFFIRMATION_UTTERANCE_ID);

    // The two utterances are distinct ids so the trace chain can separate the
    // suggestion turn from the acceptance turn.
    expect(buildable?.utteranceId).not.toBe(affirmation?.utteranceId);
  });

  test("buildBuildableOnlyScript yields just the buildable utterance", () => {
    const script = buildBuildableOnlyScript();
    expect(script).toHaveLength(1);
    expect(script[0]?.text).toBe(BUILDABLE_UTTERANCE);
    expect(script[0]?.utteranceId).toBe(BUILDABLE_UTTERANCE_ID);
    expect(script[0]?.isFinal).toBe(true);
  });

  test("a custom sessionId propagates to every observation", () => {
    const script = buildLoopScript({ sessionId: "custom-session" });
    for (const observation of script) {
      expect(observation.sessionId).toBe("custom-session");
    }
  });

  test("serializeLoopScript round-trips to valid JSONL observations", () => {
    const script = buildLoopScript();
    const lines = serializeLoopScript(script).split("\n");
    expect(lines).toHaveLength(script.length);
    const parsed = lines.map((line) => transcriptObservationSchema.parse(JSON.parse(line)));
    expect(parsed).toEqual(script);
  });
});
