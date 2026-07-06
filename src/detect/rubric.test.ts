import { describe, expect, test } from "bun:test";
import { clampLevel, deriveAssessment, normalizeRubric, type IdeaRubric } from "./rubric";

function rubric(over: Partial<IdeaRubric> = {}): IdeaRubric {
  return { category: "proposal", concreteness: 2, buildableAsSoftware: 2, intent: 2, novelty: 2, ...over };
}

describe("hard gates", () => {
  test("non-proposal categories are zeroed with the reason", () => {
    for (const category of ["existing-product", "hypothetical", "logistics", "recap", "chatter"] as const) {
      const a = deriveAssessment(rubric({ category }));
      expect(a.confidence).toBe(0);
      expect(a.surfaceable).toBe(false);
      expect(a.blockedBy).toContain(`category:${category}`);
    }
  });

  test("not-software, joke, and already-exists gates", () => {
    expect(deriveAssessment(rubric({ buildableAsSoftware: 1 })).blockedBy).toContain("not-software");
    expect(deriveAssessment(rubric({ intent: 0 })).blockedBy).toContain("not-meant");
    expect(deriveAssessment(rubric({ novelty: 0 })).blockedBy).toContain("already-exists");
    // gates zero confidence even with everything else maxed
    expect(deriveAssessment(rubric({ concreteness: 3, intent: 3, novelty: 0 })).confidence).toBe(0);
  });

  test("multiple gates all reported", () => {
    const a = deriveAssessment(rubric({ category: "hypothetical", intent: 0 }));
    expect(a.blockedBy).toEqual(expect.arrayContaining(["category:hypothetical", "not-meant"]));
  });
});

describe("derived confidence + surfacing", () => {
  test("the laundromat shape (2/2/2/2) clears the default threshold", () => {
    const a = deriveAssessment(rubric());
    expect(a.confidence).toBeCloseTo(0.667, 2);
    expect(a.surfaceable).toBe(true);
    expect(a.maturity).toBe("proposed");
  });

  test("a maxed rubric derives 1.0 and is actionable", () => {
    const a = deriveAssessment(rubric({ concreteness: 3, buildableAsSoftware: 3, intent: 3, novelty: 3 }));
    expect(a.confidence).toBe(1);
    expect(a.maturity).toBe("actionable");
  });

  test("vague musing is held as forming (below threshold)", () => {
    const a = deriveAssessment(rubric({ concreteness: 1, intent: 1 }));
    expect(a.surfaceable).toBe(false);
    expect(a.maturity).toBe("forming");
    expect(a.blockedBy).toEqual(expect.arrayContaining(["below-threshold", "intent-too-low"]));
    expect(a.confidence).toBeGreaterThan(0); // held, not gated
  });

  test("concrete but idle-musing intent is HELD even above threshold (intent floor)", () => {
    // concreteness 3, buildable 3, intent 1, novelty 2 → blend ~0.8 but intent < 2
    const a = deriveAssessment(rubric({ concreteness: 3, buildableAsSoftware: 3, intent: 1 }));
    expect(a.confidence).toBeGreaterThan(0.6);
    expect(a.surfaceable).toBe(false);
    expect(a.blockedBy).toEqual(["intent-too-low"]);
  });

  test("retraction (final stance) drops intent and un-surfaces the idea", () => {
    const floated = deriveAssessment(rubric({ intent: 2 }));
    const retracted = deriveAssessment(rubric({ intent: 1 }));
    expect(floated.surfaceable).toBe(true);
    expect(retracted.surfaceable).toBe(false);
  });

  test("custom threshold is honored", () => {
    expect(deriveAssessment(rubric(), 0.7).surfaceable).toBe(false);
    expect(deriveAssessment(rubric(), 0.5).surfaceable).toBe(true);
  });
});

describe("normalizeRubric / clampLevel", () => {
  test("clamps, rounds, and defaults junk", () => {
    expect(clampLevel(2.6)).toBe(3);
    expect(clampLevel(-1)).toBe(0);
    expect(clampLevel("2")).toBe(2);
    expect(clampLevel("junk")).toBe(0);
    const r = normalizeRubric({ category: "nonsense", concreteness: 9, intent: -2 });
    expect(r.category).toBe("chatter");
    expect(r.concreteness).toBe(3);
    expect(r.intent).toBe(0);
  });
});
