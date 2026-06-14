// §8 invariant: reviewer.family ≠ implementer.family. RBG move: point review at the
// implementer's family → the module-load assertion throws.
import { describe, expect, test } from "bun:test";
import { ANTHROPIC, assertCrossFamily, OPENAI, ROLE_FAMILIES } from "./core.ts";

describe("cross-family-guard", () => {
  test("green — the shipped role table is cross-family (Anthropic impl, OpenAI review)", () => {
    expect(ROLE_FAMILIES.implementer).toBe(ANTHROPIC);
    expect(ROLE_FAMILIES.reviewer).toBe(OPENAI);
    expect(() => assertCrossFamily()).not.toThrow();
  });

  test("RBG — a same-family reviewer makes the guard throw", () => {
    expect(() => assertCrossFamily({ implementer: ANTHROPIC, reviewer: ANTHROPIC, verifier: ANTHROPIC })).toThrow(
      /cross-family invariant violated/i,
    );
  });

  test("RBG — an untagged reviewer family throws (no silent pass)", () => {
    expect(() => assertCrossFamily({ implementer: ANTHROPIC, reviewer: "", verifier: ANTHROPIC })).toThrow(
      /untagged/i,
    );
  });
});
