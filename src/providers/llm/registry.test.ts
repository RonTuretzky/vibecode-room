import { describe, expect, test } from "bun:test";
import { ClaudeDecisionLLM } from "./claude";
import { HeuristicDecisionLLM } from "./heuristic";
import { ReplayDecisionLLM } from "./replay";
import {
  DEFAULT_CLAUDE_DECISION_COMMAND,
  selectDecisionLLM,
  type DecisionLLMSelectionEnv,
} from "./registry";
// Barrel reachability (AC4): the concrete deciders + the registry must be
// constructible only through the providers barrel, like every other provider.
import * as providers from "../index";

// Anthropic-key-shaped string. The registry only reads it to gate selection; it
// is never forwarded through the credential constructor, so any non-empty value
// stands in for "a model credential is resolvable".
const ANTHROPIC_KEY = "sk-ant-test-0123456789abcdef0123456789";

describe("selectDecisionLLM — explicit PANOP_DECISION_LLM mapping (unit)", () => {
  test("maps 'heuristic' to HeuristicDecisionLLM", () => {
    const selection = selectDecisionLLM({ PANOP_DECISION_LLM: "heuristic" });

    expect(selection.mode).toBe("heuristic");
    expect(selection.llm).toBeInstanceOf(HeuristicDecisionLLM);
  });

  test("maps 'claude' to ClaudeDecisionLLM when a credential is resolvable", () => {
    const selection = selectDecisionLLM({ PANOP_DECISION_LLM: "claude", ANTHROPIC_API_KEY: ANTHROPIC_KEY });

    expect(selection.mode).toBe("claude");
    expect(selection.llm).toBeInstanceOf(ClaudeDecisionLLM);
    expect((selection.llm as ClaudeDecisionLLM).credentialSource).toEqual({
      kind: "host-subscription",
      provider: "anthropic-claude",
      command: DEFAULT_CLAUDE_DECISION_COMMAND,
    });
  });

  test("maps 'replay' to ReplayDecisionLLM", () => {
    const selection = selectDecisionLLM({ PANOP_DECISION_LLM: "replay" });

    expect(selection.mode).toBe("replay");
    expect(selection.llm).toBeInstanceOf(ReplayDecisionLLM);
  });

  test("is case/whitespace tolerant for the explicit value", () => {
    const selection = selectDecisionLLM({ PANOP_DECISION_LLM: "  Heuristic  " });

    expect(selection.mode).toBe("heuristic");
    expect(selection.llm).toBeInstanceOf(HeuristicDecisionLLM);
  });

  test("rejects an unknown PANOP_DECISION_LLM value", () => {
    expect(() => selectDecisionLLM({ PANOP_DECISION_LLM: "gpt" })).toThrow(/Unknown PANOP_DECISION_LLM/u);
  });
});

describe("selectDecisionLLM — default + credential gating (integration)", () => {
  test("no PANOP_DECISION_LLM -> heuristic (deterministic, no key)", () => {
    const selection = selectDecisionLLM({});

    expect(selection.mode).toBe("heuristic");
    expect(selection.llm).toBeInstanceOf(HeuristicDecisionLLM);
  });

  test("an empty PANOP_DECISION_LLM falls back to the heuristic default", () => {
    const selection = selectDecisionLLM({ PANOP_DECISION_LLM: "" });

    expect(selection.mode).toBe("heuristic");
    expect(selection.llm).toBeInstanceOf(HeuristicDecisionLLM);
  });

  test("'claude' without a resolvable credential surfaces a clear error", () => {
    expect(() => selectDecisionLLM({ PANOP_DECISION_LLM: "claude" })).toThrow(
      /requires a resolvable model credential/u,
    );
  });

  test("an empty ANTHROPIC_API_KEY counts as unresolvable for 'claude'", () => {
    const env: DecisionLLMSelectionEnv = { PANOP_DECISION_LLM: "claude", ANTHROPIC_API_KEY: "" };

    expect(() => selectDecisionLLM(env)).toThrow(/requires a resolvable model credential/u);
  });

  test("'claude' never smuggles the raw key through the credential constructor", () => {
    // A raw key in env must not be forwarded to createModelCredentialSource (which
    // rejects raw keys). Selection succeeds via the host-subscription command.
    const selection = selectDecisionLLM({ PANOP_DECISION_LLM: "claude", ANTHROPIC_API_KEY: ANTHROPIC_KEY });

    expect(selection.llm).toBeInstanceOf(ClaudeDecisionLLM);
    expect((selection.llm as ClaudeDecisionLLM).credentialSource.kind).toBe("host-subscription");
  });
});

describe("selectDecisionLLM — credential auto-select precedence (unit)", () => {
  // explicit env > credential auto-select > heuristic default.
  test("no explicit env + resolvable credential -> Claude is auto-selected", () => {
    const selection = selectDecisionLLM({ ANTHROPIC_API_KEY: ANTHROPIC_KEY });

    expect(selection.mode).toBe("claude");
    expect(selection.llm).toBeInstanceOf(ClaudeDecisionLLM);
    expect((selection.llm as ClaudeDecisionLLM).credentialSource).toEqual({
      kind: "host-subscription",
      provider: "anthropic-claude",
      command: DEFAULT_CLAUDE_DECISION_COMMAND,
    });
  });

  test("no explicit env + no credential -> heuristic default", () => {
    const selection = selectDecisionLLM({});

    expect(selection.mode).toBe("heuristic");
    expect(selection.llm).toBeInstanceOf(HeuristicDecisionLLM);
  });

  test("no explicit env + empty credential counts as no credential -> heuristic", () => {
    const selection = selectDecisionLLM({ ANTHROPIC_API_KEY: "" });

    expect(selection.mode).toBe("heuristic");
    expect(selection.llm).toBeInstanceOf(HeuristicDecisionLLM);
  });

  test("explicit PANOP_DECISION_LLM=heuristic overrides credential auto-select", () => {
    const selection = selectDecisionLLM({ PANOP_DECISION_LLM: "heuristic", ANTHROPIC_API_KEY: ANTHROPIC_KEY });

    expect(selection.mode).toBe("heuristic");
    expect(selection.llm).toBeInstanceOf(HeuristicDecisionLLM);
  });

  test("explicit PANOP_DECISION_LLM=replay overrides credential auto-select", () => {
    const selection = selectDecisionLLM({ PANOP_DECISION_LLM: "replay", ANTHROPIC_API_KEY: ANTHROPIC_KEY });

    expect(selection.mode).toBe("replay");
    expect(selection.llm).toBeInstanceOf(ReplayDecisionLLM);
  });

  test("auto-selected Claude decider never smuggles the raw key through the constructor", () => {
    const selection = selectDecisionLLM({ ANTHROPIC_API_KEY: ANTHROPIC_KEY });

    expect(selection.llm).toBeInstanceOf(ClaudeDecisionLLM);
    expect((selection.llm as ClaudeDecisionLLM).credentialSource.kind).toBe("host-subscription");
  });
});

describe("decision registry is reachable through the providers barrel (AC4)", () => {
  test("the deciders and selectDecisionLLM are exported from the barrel", () => {
    expect(typeof providers.selectDecisionLLM).toBe("function");
    expect(providers.HeuristicDecisionLLM).toBe(HeuristicDecisionLLM);
    expect(providers.ClaudeDecisionLLM).toBe(ClaudeDecisionLLM);
    expect(providers.ReplayDecisionLLM).toBe(ReplayDecisionLLM);

    const selection = providers.selectDecisionLLM({});
    expect(selection.mode).toBe("heuristic");
    expect(selection.llm).toBeInstanceOf(providers.HeuristicDecisionLLM);
  });
});
