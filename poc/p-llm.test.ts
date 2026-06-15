import { describe, expect, test } from "bun:test";
import {
  COST_BUDGET_PER_HOUR_USD,
  DECISION_BUDGET_MS,
  assertActPromptAmendment,
  assertCostGate,
  assertDeterministic,
  assertMappedActionToolSchema,
  assertNoSecretText,
  assertP50Latency,
  parseDecisions,
  runHotLoopSubscriptionProbe,
  type CliAttempt,
  type CliInvocation,
  type HotLoopToolCall,
} from "./llm-subscription-probe";

describe("P-LLM hot-loop subscription model probe", () => {
  test("decision-model assertions are independently failable", () => {
    expect(() => assertDeterministic([
      invocation("same-input-1", [
        decision("repeat-1", "ACT", "panopticon.steer", { callsign: "Daybreak", instruction: "status" }),
      ]),
      invocation("same-input-2", [
        decision("repeat-1", "PASS", "observe.pass", {}),
      ]),
    ])).toThrow("diverged");

    expect(() => assertP50Latency([attempt(DECISION_BUDGET_MS + 1)])).toThrow("exceeds");
    expect(() => assertMappedActionToolSchema([
      decision("repeat-1", "ACT", "observe.pass", {}),
    ])).toThrow("ACT decisions");
    expect(() => assertNoSecretText(`Authorization: Bearer ${"A".repeat(16)}`)).toThrow("secret-shaped");
    expect(() => assertCostGate(COST_BUDGET_PER_HOUR_USD + 0.01)).toThrow("exceeds");
    expect(() => assertActPromptAmendment([
      decision("repeat-1", "PASS", "observe.pass", {}),
    ])).toThrow("status query");
    expect(() => parseDecisions(JSON.stringify({
      decisions: [{ id: "repeat-1", decision: "ACT", tool: "unknown.tool", arguments: {}, confidence: 1, reason: "bad" }],
    }))).toThrow("MappedActionTool-compatible");
  });

  test("host subscription CLI decision probe records determinism, latency, schema, prompt, cost, and trace-secret verdict", async () => {
    const verdict = await runHotLoopSubscriptionProbe();

    if (process.env.PANOP_LLM_PROBE_REQUIRE_GREEN === "1") {
      expect(verdict.green, verdict.blockers.join("; ")).toBe(true);
    }

    expect(verdict.ticketId).toBe("probe-hot-loop-llm-subscription");
    expect(verdict.metrics.budgetMs).toBe(DECISION_BUDGET_MS);
    expect(verdict.metrics.costBudgetPerHourUsd).toBe(COST_BUDGET_PER_HOUR_USD);
    expect(verdict.attempts.length).toBeGreaterThan(0);
    expect(verdict.checks.traceSecretClean).toBe(true);
    expect(verdict.checks.noRawKeyRoute).toBe(true);
    expect(verdict.green || verdict.blockers.some((blocker) => blocker.includes("100 ms") || blocker.includes("No host"))).toBe(true);
  }, 240000);
});

function decision(
  id: string,
  decisionValue: HotLoopToolCall["decision"],
  tool: HotLoopToolCall["tool"],
  args: Record<string, unknown>,
): HotLoopToolCall {
  return { id, decision: decisionValue, tool, arguments: args, confidence: 1, reason: "fixture" };
}

function attempt(latencyMs: number): CliAttempt {
  return {
    provider: "openai-codex",
    command: "codex",
    status: "passed",
    subscriptionRouted: true,
    latencyMs,
    decisions: [
      decision("repeat-1", "ACT", "panopticon.steer", { callsign: "Daybreak", instruction: "status" }),
    ],
    invocations: [
      invocation("same-input-1", [
        decision("repeat-1", "ACT", "panopticon.steer", { callsign: "Daybreak", instruction: "status" }),
      ], latencyMs),
      invocation("same-input-2", [
        decision("repeat-1", "ACT", "panopticon.steer", { callsign: "Daybreak", instruction: "status" }),
      ], latencyMs),
    ],
    stdoutPreview: "{}",
  };
}

function invocation(id: string, decisions: HotLoopToolCall[], latencyMs = 1): CliInvocation {
  return {
    id,
    latencyMs,
    decisions,
    stdoutPreview: "{}",
  };
}
