import { describe, expect, test } from "bun:test";
import {
  boolValue,
  firstJsonObject,
  parseQuestions,
  stringArray,
  unwrapSmithersOutput,
  visualizerKind,
} from "./smithers-parse.ts";

describe("SmithersBrain parsing helpers", () => {
  test("boolValue handles Smithers numeric boolean serialization", () => {
    expect(boolValue(1)).toBe(true);
    expect(boolValue(0)).toBe(false);
    expect(boolValue("true")).toBe(true);
    expect(boolValue("1")).toBe(true);
    expect(boolValue(true)).toBe(true);
    expect(boolValue("false")).toBe(false);
    expect(boolValue(undefined)).toBe(false);
  });

  test("stringArray parses common Smithers output shapes", () => {
    expect(stringArray("[\"alpha\",\"beta\",3]")).toEqual(["alpha", "beta"]);
    expect(stringArray("alpha, beta,,gamma")).toEqual(["alpha", "beta", "gamma"]);
    expect(stringArray(["alpha", "beta", 3])).toEqual(["alpha", "beta"]);
    expect(stringArray("")).toEqual([]);
  });

  test("parseQuestions parses valid questions and drops malformed entries", () => {
    const questions = JSON.stringify([
      { prompt: "Pick one", choices: ["A", "B"] },
      { prompt: "", choices: ["ignored"] },
      { prompt: "No choices", choices: [] },
      { prompt: "Comma choices", choices: "yes, no" },
      { choices: ["missing prompt"] },
      null,
    ]);

    expect(parseQuestions(questions)).toEqual([
      { prompt: "Pick one", choices: ["A", "B"] },
      { prompt: "Comma choices", choices: ["yes", "no"] },
    ]);
  });

  test("firstJsonObject extracts the first balanced object before trailing cta lines", () => {
    const stdout = [
      "{\"output\":{\"suggest\":1,\"title\":\"Use { braces } safely\"}}",
      "cta: smithers output run suggest --json",
      "cta: smithers ui run",
    ].join("\n");

    expect(firstJsonObject(stdout)).toEqual({
      output: { suggest: 1, title: "Use { braces } safely" },
    });
  });

  test("unwrapSmithersOutput unwraps known envelopes or returns the original object", () => {
    expect(unwrapSmithersOutput({ output: { ok: true } })).toEqual({ ok: true });
    expect(unwrapSmithersOutput({ value: { ok: true } })).toEqual({ ok: true });
    expect(unwrapSmithersOutput({ result: { ok: true } })).toEqual({ ok: true });
    expect(unwrapSmithersOutput({ ok: true })).toEqual({ ok: true });
  });

  test("visualizerKind preserves known visualizers and defaults unknown values", () => {
    expect(visualizerKind("code")).toBe("code");
    expect(visualizerKind("unknown")).toBe("web");
    expect(visualizerKind(undefined)).toBe("web");
  });
});
