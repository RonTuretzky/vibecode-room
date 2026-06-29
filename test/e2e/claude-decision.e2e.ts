import { describe, expect, test } from "bun:test";
import { ClaudeDecisionLLM, DEFAULT_CLAUDE_DECISION_MODEL } from "../../src/providers/llm/claude";
import { cueDecisionSchema } from "../../src/types";
import type { DecisionInput } from "../../src/providers/types";

const LIVE_SKIP_REASON = "LIVE Claude decision gate skipped - requires ANTHROPIC_API_KEY";
const CORRELATION_ID = "corr-claude-e2e-001";
const DECISION_POLICY = "claude-decider-e2e";

function hasAnthropicCredential(): boolean {
  return process.env.ANTHROPIC_API_KEY !== undefined && process.env.ANTHROPIC_API_KEY.length > 0;
}

const SYSTEM_PROMPT = [
  "You are Vibersyn's cue decider. You receive a single transcribed utterance and must return exactly one CueDecision via the emit_cue_decision tool.",
  "Return kind \"action\" with an action of type \"spawn\" when the operator clearly asks to build, create, or kick off work.",
  "Return kind \"pass\" otherwise (ambient chatter, near-miss, low confidence).",
  `Always set policy to \"${DECISION_POLICY}\", correlationId to \"${CORRELATION_ID}\" everywhere it appears, and a stable decisionId.`,
  "meta must be a JSON object. For an action, set action.targetUPID to null and action.correlationId to the same correlationId.",
].join(" ");

function liveDecisionInput(): DecisionInput {
  return {
    model: DEFAULT_CLAUDE_DECISION_MODEL,
    temperature: 0,
    correlationId: CORRELATION_ID,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: "Viber, build the thinnest walking skeleton for the new service." },
    ],
    metadata: { utteranceId: "utt-claude-e2e-001" },
  };
}

describe.skipIf(!hasAnthropicCredential())("LIVE Claude decision", () => {
  test(
    "a buildable utterance returns a spawn-or-pass decision",
    async () => {
      const llm = ClaudeDecisionLLM.fromModelCredentials({
        provider: "anthropic-claude",
        command: "claude --print",
      });

      const output = await llm.decide(liveDecisionInput());

      expect(output.temperature).toBe(0);
      expect(() => cueDecisionSchema.parse(output.decision)).not.toThrow();
      expect(["action", "pass"]).toContain(output.decision.kind);
      if (output.decision.kind === "action") {
        expect(["spawn", "pass"]).toContain(output.decision.action.type);
      }
    },
    30_000,
  );
});

describe.skipIf(hasAnthropicCredential())("LIVE Claude decision (skipped)", () => {
  test("self-skips when ANTHROPIC_API_KEY is unset", () => {
    expect(LIVE_SKIP_REASON).toContain("ANTHROPIC_API_KEY");
  });
});
