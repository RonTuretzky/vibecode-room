// §8 invariant: reviewer.family ≠ implementer.family. RBG move: point review at the
// implementer's family → the module-load assertion throws.
import { describe, expect, test } from "bun:test";
import { ANTHROPIC, assertCrossFamily, OPENAI, ROLE_FAMILIES } from "./core.ts";

describe("cross-family-guard", () => {
  test("green — the shipped role table is cross-family (OpenAI/Codex impl, Anthropic/Opus review)", () => {
    expect(ROLE_FAMILIES.implementer).toBe(OPENAI);
    expect(ROLE_FAMILIES.reviewer).toBe(ANTHROPIC);
    expect(() => assertCrossFamily()).not.toThrow();
  });

  test("RBG — a same-family reviewer makes the guard throw", () => {
    // Point the reviewer at OPENAI — the implementer's family — to trip the invariant.
    expect(() => assertCrossFamily({ implementer: OPENAI, reviewer: OPENAI, verifier: ANTHROPIC })).toThrow(
      /cross-family invariant violated/i,
    );
  });

  test("RBG — an untagged reviewer family throws (no silent pass)", () => {
    expect(() => assertCrossFamily({ implementer: OPENAI, reviewer: "", verifier: ANTHROPIC })).toThrow(
      /untagged/i,
    );
  });
});
