import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  COST_BUDGET_PER_HOUR_USD,
  DECISION_BUDGET_MS,
  TRACE_ROOT,
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
    if (process.env.PANOP_LLM_PROBE_RBG_BREAK_DETERMINISM === "1") {
      expect(() => assertDeterministic([
        invocation("same-input-1", [
          decision("repeat-1", "ACT", "panopticon.steer", { callsign: "Daybreak", instruction: "status" }),
        ]),
        invocation("same-input-2", [
          decision("repeat-1", "PASS", "observe.pass", {}),
        ]),
      ])).not.toThrow();
      return;
    }

    expect(() => assertDeterministic([
      invocation("same-input-1", [
        decision("repeat-1", "ACT", "panopticon.steer", { callsign: "Daybreak", instruction: "status" }),
      ]),
      invocation("same-input-2", [
        decision("repeat-1", "PASS", "observe.pass", {}),
      ]),
    ])).toThrow("diverged");

    expect(() => assertP50Latency([attempt(DECISION_BUDGET_MS + 1)])).toThrow("exceeds");
    expect(() => assertP50Latency([attempt(DECISION_BUDGET_MS - 1), attempt(DECISION_BUDGET_MS + 10_000)])).not.toThrow();
    expect(() => assertMappedActionToolSchema([
      decision("repeat-1", "ACT", "observe.pass", {}),
    ])).toThrow("ACT decisions");
    expect(() => assertNoSecretText(`Authorization: Bearer ${"A".repeat(16)}`)).toThrow("secret-shaped");
    expect(() => assertCostGate(null)).toThrow("could not be measured");
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

    expect(verdict.ticketId).toBe("probe-hot-loop-llm-subscription");
    expect(verdict.metrics.budgetMs).toBe(DECISION_BUDGET_MS);
    expect(verdict.metrics.costBudgetPerHourUsd).toBe(COST_BUDGET_PER_HOUR_USD);
    expect(verdict.attempts.length).toBeGreaterThan(0);
    expect(verdict.attempts.some((attempt) => attempt.status === "passed" && attempt.subscriptionRouted)).toBe(true);
    expect(verdict.checks.deterministic, verdict.blockers.join("; ")).toBe(true);
    expect(verdict.checks.mappedActionToolSchema, verdict.blockers.join("; ")).toBe(true);
    expect(verdict.checks.actPromptAmendment, verdict.blockers.join("; ")).toBe(true);
    expect(verdict.checks.traceSecretClean).toBe(true);
    expect(verdict.checks.noRawKeyRoute).toBe(true);

    const traceText = await readFile(join(TRACE_ROOT, "llm-subscription-probe.jsonl"), "utf8");
    expect(traceText).toContain("llm_probe.verdict");
    expect(() => assertNoSecretText(traceText)).not.toThrow();

    if (!verdict.green) {
      expect(verdict.summary).toContain("binding PRD §6 conflict");
      expect(verdict.blockers.length).toBeGreaterThan(0);
      expect(verdict.blockers.every((blocker) => (
        blocker.includes("100 ms") || blocker.includes("$0.15/hr cost gate was not measured")
      ))).toBe(true);
      expect(verdict.checks.p50LatencyWithinBudget && verdict.checks.costWithinBudget).toBe(false);
    }
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
