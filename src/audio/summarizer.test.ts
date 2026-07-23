import { describe, expect, test } from "bun:test";
import { DEFAULT_OUTPUT_SUMMARY_MODEL, ttsDecision, type SummaryInput } from "./output-policy";
import {
  CerebrasSummarizer,
  DEFAULT_CEREBRAS_SUMMARIZER_MODEL,
  DeterministicClampSummarizer,
  clampWords,
  selectSummarizer,
  type CerebrasChatRequest,
  type CerebrasChatResponse,
  type CerebrasChatTransport,
} from "./summarizer";

const LONG_TEXT =
  "The build completed after the agent updated the fixture, reran the failing suite, and confirmed every " +
  "acceptance path now passes without any manual intervention from the operator";

function stubTransport(reply: string, calls: CerebrasChatRequest[] = []): CerebrasChatTransport {
  return async (request) => {
    calls.push(request);
    return { choices: [{ message: { content: reply } }] } satisfies CerebrasChatResponse;
  };
}

describe("clampWords", () => {
  test("returns trimmed text unchanged when within the budget", () => {
    expect(clampWords("  one two three  ", 5)).toBe("one two three");
  });

  test("truncates to exactly maxWords when over", () => {
    expect(clampWords("one two three four five six", 3)).toBe("one two three");
  });
});

describe("DeterministicClampSummarizer", () => {
  test("summarize is the deterministic clamp", () => {
    const input: SummaryInput = { text: "one two three four", maxWords: 2, model: DEFAULT_OUTPUT_SUMMARY_MODEL };
    expect(new DeterministicClampSummarizer().summarize(input)).toBe("one two");
  });
});

describe("CerebrasSummarizer", () => {
  test("one-shot summarize: substitutes the real model for the policy placeholder and clamps the reply", async () => {
    const calls: CerebrasChatRequest[] = [];
    const summarizer = new CerebrasSummarizer({ transport: stubTransport('"Build passed; suite green." ', calls) });

    const spoken = await summarizer.summarize({ text: LONG_TEXT, maxWords: 15, model: DEFAULT_OUTPUT_SUMMARY_MODEL });

    expect(spoken).toBe("Build passed; suite green.");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toBe(DEFAULT_CEREBRAS_SUMMARIZER_MODEL);
    expect(calls[0]?.temperature).toBe(0);
    expect(calls[0]?.messages.at(-1)?.content).toContain(LONG_TEXT);
  });

  test("a concrete VIBERSYN_OUTPUT_SUMMARY_MODEL model id passes through untouched", async () => {
    const calls: CerebrasChatRequest[] = [];
    const summarizer = new CerebrasSummarizer({ transport: stubTransport("ok", calls) });

    await summarizer.summarize({ text: LONG_TEXT, maxWords: 15, model: "gpt-oss-120b" });

    expect(calls[0]?.model).toBe("gpt-oss-120b");
  });

  test("an overlong model reply is clamped to the word budget", async () => {
    const summarizer = new CerebrasSummarizer({ transport: stubTransport("alpha beta gamma delta epsilon") });

    await expect(summarizer.summarize({ text: LONG_TEXT, maxWords: 3, model: DEFAULT_OUTPUT_SUMMARY_MODEL })).resolves.toBe(
      "alpha beta gamma",
    );
  });

  test("empty reply falls back to the deterministic clamp", async () => {
    const summarizer = new CerebrasSummarizer({ transport: stubTransport("   ") });

    await expect(summarizer.summarize({ text: "one two three four", maxWords: 2, model: DEFAULT_OUTPUT_SUMMARY_MODEL })).resolves.toBe(
      "one two",
    );
  });

  test("transport failure falls back to the deterministic clamp and never throws", async () => {
    const summarizer = new CerebrasSummarizer({
      transport: async () => {
        throw new Error("network down");
      },
    });

    await expect(summarizer.summarize({ text: "one two three four", maxWords: 2, model: DEFAULT_OUTPUT_SUMMARY_MODEL })).resolves.toBe(
      "one two",
    );
  });
});

describe("selectSummarizer", () => {
  test("no credential defaults to the deterministic clamp", () => {
    const selection = selectSummarizer({});
    expect(selection.mode).toBe("deterministic");
    expect(selection.summarizer).toBeInstanceOf(DeterministicClampSummarizer);
  });

  test("CEREBRAS_API_KEY auto-selects the Cerebras summarizer", () => {
    const selection = selectSummarizer({ CEREBRAS_API_KEY: "csk-test" }, { transport: stubTransport("ok") });
    expect(selection.mode).toBe("cerebras");
    expect(selection.summarizer).toBeInstanceOf(CerebrasSummarizer);
  });

  test("explicit deterministic wins over a resolvable credential", () => {
    expect(selectSummarizer({ VIBERSYN_SUMMARIZER: "deterministic", CEREBRAS_API_KEY: "csk-test" }).mode).toBe("deterministic");
  });

  test("explicit cerebras without a credential or injected transport throws with guidance", () => {
    expect(() => selectSummarizer({ VIBERSYN_SUMMARIZER: "cerebras" })).toThrow(/CEREBRAS_API_KEY/u);
  });

  test("unknown mode throws", () => {
    expect(() => selectSummarizer({ VIBERSYN_SUMMARIZER: "psychic" })).toThrow(/Unknown VIBERSYN_SUMMARIZER/u);
  });

  test("CEREBRAS_MODEL is forwarded to the Cerebras leg", async () => {
    const calls: CerebrasChatRequest[] = [];
    const selection = selectSummarizer(
      { CEREBRAS_API_KEY: "csk-test", CEREBRAS_MODEL: "gpt-oss-120b" },
      { transport: stubTransport("ok", calls) },
    );

    await selection.summarizer.summarize({ text: LONG_TEXT, maxWords: 15, model: DEFAULT_OUTPUT_SUMMARY_MODEL });

    expect(calls[0]?.model).toBe("gpt-oss-120b");
  });
});

describe("output-policy integration", () => {
  test("the selected summarizer satisfies ttsDecision's >maxWords guard end to end", async () => {
    const selection = selectSummarizer(
      { CEREBRAS_API_KEY: "csk-test" },
      { transport: stubTransport("Build failed; fixture needs an update before retry") },
    );

    const decision = await ttsDecision(LONG_TEXT, { summarizer: selection.summarizer });

    expect(decision.summarized).toBe(true);
    expect(decision.text).toBe("Build failed; fixture needs an update before retry");
    expect(decision.wordCount).toBeLessThanOrEqual(15);
  });

  test("the deterministic default still keeps the guard total (clamped, never wedged)", async () => {
    const selection = selectSummarizer({});

    const decision = await ttsDecision(LONG_TEXT, { summarizer: selection.summarizer });

    expect(decision.summarized).toBe(true);
    expect(decision.wordCount).toBeLessThanOrEqual(15);
  });
});
