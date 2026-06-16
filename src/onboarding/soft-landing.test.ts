import { describe, expect, test } from "bun:test";
import type { TranscriptObservation } from "../types";
import { NEAR_MISS_DISABLE_AFTER_MS, NearMissSoftLanding, documentedCommandPhrases, levenshtein } from "./soft-landing";

describe("near-miss soft landing", () => {
  test("suggests documented commands within Levenshtein distance two", () => {
    const softLanding = new NearMissSoftLanding({
      sessionStartedAtMs: 0,
      clock: () => 60_000,
    });

    expect(softLanding.evaluate("Panop stats")).toEqual({
      kind: "near-miss",
      commandId: "status",
      phrase: "status",
      distance: 1,
      text: 'Did you mean "status"?',
      disabled: false,
    });
    expect(softLanding.evaluate("mut")).toEqual(expect.objectContaining({ kind: "near-miss", phrase: "mute" }));
    expect(softLanding.evaluate("status")).toEqual({ kind: "none", disabled: false });
  });

  test("is disabled after twenty minutes", () => {
    const softLanding = new NearMissSoftLanding({
      sessionStartedAtMs: 0,
      clock: () => NEAR_MISS_DISABLE_AFTER_MS,
    });

    expect(softLanding.evaluate("stats")).toEqual({ kind: "disabled", disabled: true });
  });

  test("near-miss can be represented as an addressed pass decision", () => {
    const softLanding = new NearMissSoftLanding({ sessionStartedAtMs: 0, clock: () => 1_000 });
    const result = softLanding.evaluate("stats");
    const observation: TranscriptObservation = {
      text: "stats",
      isFinal: true,
      speaker: null,
      sessionId: "session-soft",
      latencyMs: 5,
      utteranceId: "utt-soft",
    };

    expect(softLanding.toCueDecision(observation, result, "decision-soft", "corr-soft")).toEqual(
      expect.objectContaining({
        kind: "pass",
        addressed: true,
        reason: "near-miss",
        meta: expect.objectContaining({
          suggestion: 'Did you mean "status"?',
          distance: 1,
        }),
      }),
    );
  });

  test("documents only concrete spoken command phrases", () => {
    const phrases = documentedCommandPhrases().map((phrase) => phrase.normalized);

    expect(phrases).toContain("panop");
    expect(phrases).toContain("mute");
    expect(phrases).not.toContain("[callsign]");
    expect(levenshtein("stats", "status")).toBe(1);
  });
});
