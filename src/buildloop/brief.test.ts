import { describe, expect, test } from "bun:test";
import { briefContextBlock } from "./brief";
import type { BuildBrief } from "./types";

// The shared PURE renderer every backend appends to its build prompt. Contract:
// sections render only when they have content; empty/absent briefs render "".

function brief(overrides: Partial<BuildBrief> = {}): BuildBrief {
  return {
    pitch: "Build a citi bike radar",
    sourceQuote: "i want an app that shows me all the citi bikes in brooklyn",
    rationale: "Concrete, scoped, buildable as a small map app.",
    qa: [
      { id: "q-map", prompt: "Map or list first?", answers: ["Map", "List"] },
      { id: "q-live", prompt: "Live data?", answers: ["Yes", "Snapshot"], chosen: "Yes" },
    ],
    callsign: null,
    maturity: "proposed",
    ...overrides,
  };
}

describe("briefContextBlock (pure)", () => {
  test("renders the four labeled sections: quote, rationale, decided, open", () => {
    const block = briefContextBlock(brief());
    expect(block).toContain(
      'AS HEARD IN THE ROOM (verbatim): "i want an app that shows me all the citi bikes in brooklyn"',
    );
    expect(block).toContain("WHY IT IS BUILDABLE: Concrete, scoped, buildable as a small map app.");
    expect(block).toContain("DECISIONS ALREADY MADE:\n- Live data? → Yes");
    expect(block).toContain("OPEN QUESTIONS:\n- Map or list first? (options: Map / List)");
  });

  test("null and undefined render to the empty string (callers append unconditionally)", () => {
    expect(briefContextBlock(null)).toBe("");
    expect(briefContextBlock(undefined)).toBe("");
  });

  test("a fully degenerate brief (forced accept: quote only) renders only the quote line", () => {
    const block = briefContextBlock(brief({ sourceQuote: "cats need rides across town", rationale: "", qa: [] }));
    expect(block).toBe('AS HEARD IN THE ROOM (verbatim): "cats need rides across town"');
  });

  test("an all-empty brief renders to the empty string", () => {
    expect(briefContextBlock(brief({ sourceQuote: "  ", rationale: "", qa: [] }))).toBe("");
  });

  test("a question with no options renders bare; blank prompts and options are dropped", () => {
    const block = briefContextBlock(
      brief({
        qa: [
          { id: "q-a", prompt: "Who is v1 for?", answers: [] },
          { id: "q-b", prompt: "   ", answers: ["Ghost"] },
          { id: "q-c", prompt: "Polish level?", answers: ["  ", "Demo-ready"] },
        ],
      }),
    );
    expect(block).toContain("- Who is v1 for?");
    expect(block).not.toContain("Ghost");
    expect(block).toContain("- Polish level? (options: Demo-ready)");
  });

  test("an answered question moves out of OPEN QUESTIONS entirely", () => {
    const block = briefContextBlock(
      brief({ qa: [{ id: "q-live", prompt: "Live data?", answers: ["Yes", "Snapshot"], chosen: "Yes" }] }),
    );
    expect(block).toContain("DECISIONS ALREADY MADE:");
    expect(block).not.toContain("OPEN QUESTIONS:");
  });
});
