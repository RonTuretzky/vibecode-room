import { describe, expect, test } from "bun:test";
import { CORPUS, corpusCase } from "./corpus";

// CI-safe checks: the corpus is well-formed and balanced. The MODEL-quality
// measurement lives in run-live.ts (`bun run eval:detect`), which needs the real
// `claude` CLI and is run manually / when tuning the prompt or rubric weights.
describe("idea-detection corpus", () => {
  test("cases are unique, non-empty, and every positive carries pitch hints", () => {
    const ids = new Set<string>();
    for (const c of CORPUS) {
      expect(ids.has(c.id)).toBe(false);
      ids.add(c.id);
      expect(c.turns.length).toBeGreaterThan(0);
      for (const t of c.turns) {
        expect(t.text.trim().length).toBeGreaterThan(0);
        expect(t.speaker.trim().length).toBeGreaterThan(0);
      }
      if (c.kind === "positive") {
        expect(c.pitchHints ?? []).not.toHaveLength(0);
      }
    }
  });

  test("covers both classes with enough hard negatives to measure precision", () => {
    const positives = CORPUS.filter((c) => c.kind === "positive");
    const negatives = CORPUS.filter((c) => c.kind === "negative");
    expect(positives.length).toBeGreaterThanOrEqual(5);
    expect(negatives.length).toBeGreaterThanOrEqual(7);
    // The named hard-negative failure modes all present:
    for (const id of ["existing-product-review", "joke-startup", "logistics-planning", "hardware-treehouse", "recap-of-built-work", "retracted-idea", "vague-wish"]) {
      expect(corpusCase(id).kind).toBe("negative");
    }
  });

  test("corpusCase throws on unknown ids", () => {
    expect(() => corpusCase("nope")).toThrow(/No corpus case/u);
  });
});
