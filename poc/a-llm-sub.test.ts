import { describe, expect, test } from "bun:test";
import { createModelCredentialSource } from "../src/providers/credentials";
import {
  assertNoRawKeyPath,
  runHotLoopSubscriptionProbe,
  sanitizedSubscriptionCliEnv,
} from "./llm-subscription-probe";

describe("A-LLM-SUB host subscription reachability probe", () => {
  test("model access records host subscription provenance and rejects raw-key routing", () => {
    expect(createModelCredentialSource({ provider: "openai-codex" })).toEqual({
      kind: "host-subscription",
      provider: "openai-codex",
      command: "codex",
    });
    expect(createModelCredentialSource({ provider: "anthropic-claude", command: "claude --print" })).toEqual({
      kind: "host-subscription",
      provider: "anthropic-claude",
      command: "claude --print",
    });
    expect(assertNoRawKeyPath).not.toThrow();
    expect(sanitizedSubscriptionCliEnv({
      PATH: "/usr/bin",
      HOME: "/tmp/panopticon-home",
      OPENAI_API_KEY: ["sk", "proj", "A".repeat(48)].join("-"),
      ANTHROPIC_API_KEY: ["sk", "ant", "B".repeat(48)].join("-"),
    })).toEqual({
      PATH: "/usr/bin",
      HOME: "/tmp/panopticon-home",
      NO_COLOR: "1",
    });

    if (process.env.PANOP_LLM_PROBE_ROUTE_RAW_KEY === "1") {
      createModelCredentialSource({ provider: "openai-codex", rawApiKey: "fixture-raw-provider-key" });
    }
  });

  test("subscription-routed hot-loop access is either green or surfaced as a binding PRD conflict", async () => {
    const verdict = await runHotLoopSubscriptionProbe();

    if (process.env.PANOP_LLM_PROBE_REQUIRE_GREEN === "1") {
      expect(verdict.green, verdict.blockers.join("; ")).toBe(true);
    }

    expect(verdict.checks.noRawKeyRoute).toBe(true);
    expect(verdict.attempts.every((attempt) => attempt.command === "codex" || attempt.command === "claude --print")).toBe(true);
    if (!verdict.green) {
      expect(verdict.summary).toContain("binding PRD §6 conflict");
      expect(verdict.blockers.length).toBeGreaterThan(0);
    }
  }, 240000);
});
