import { describe, expect, test } from "bun:test";
import { cueDecisionSchema, type CredentialSource, type CueDecision } from "../../types";
import { createModelCredentialSource } from "../credentials";
import type { DecisionInput } from "../types";
import {
  ClaudeDecisionLLM,
  DEFAULT_CLAUDE_DECISION_MODEL,
  createFetchTransport,
  type AnthropicMessagesRequest,
  type AnthropicMessagesResponse,
  type ClaudeMessagesTransport,
} from "./claude";

const sanctionedCredentialSource = createModelCredentialSource({
  provider: "anthropic-claude",
  command: "claude --print",
});

function decisionInput(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return {
    model: "",
    temperature: 0,
    correlationId: "corr-claude-001",
    messages: [
      { role: "system", content: "You are the cue decider. Respond only via the tool." },
      { role: "user", content: "Panop build the thinnest walking skeleton." },
    ],
    metadata: { utteranceId: "utt-001" },
    ...overrides,
  };
}

function sampleDecision(): CueDecision {
  return cueDecisionSchema.parse({
    kind: "action",
    action: {
      type: "spawn",
      targetUPID: null,
      payload: { task: "thinnest walking skeleton" },
      correlationId: "corr-claude-001",
    },
    policy: "claude-decider",
    decisionId: "decision-claude-001",
    correlationId: "corr-claude-001",
    meta: { source: "claude" },
  });
}

function toolResponse(decision: CueDecision): AnthropicMessagesResponse {
  return {
    id: "msg_claude_001",
    model: DEFAULT_CLAUDE_DECISION_MODEL,
    content: [{ type: "tool_use", name: "emit_cue_decision", input: { decision } }],
  };
}

function recordingTransport(response: AnthropicMessagesResponse): {
  transport: ClaudeMessagesTransport;
  requests: AnthropicMessagesRequest[];
} {
  const requests: AnthropicMessagesRequest[] = [];
  const transport: ClaudeMessagesTransport = async (request) => {
    requests.push(request);
    return response;
  };
  return { transport, requests };
}

describe("ClaudeDecisionLLM unit", () => {
  test("maps DecisionInput to a temperature-0 structured Anthropic request and parses the decision", async () => {
    const decision = sampleDecision();
    const { transport, requests } = recordingTransport(toolResponse(decision));
    const llm = new ClaudeDecisionLLM({ credentialSource: sanctionedCredentialSource, transport });

    const output = await llm.decide(decisionInput());

    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request.temperature).toBe(0);
    expect(request.model).toBe(DEFAULT_CLAUDE_DECISION_MODEL);
    expect(request.system).toContain("cue decider");
    expect(request.messages).toEqual([
      { role: "user", content: "Panop build the thinnest walking skeleton." },
    ]);
    expect(request.tool_choice).toEqual({ type: "tool", name: "emit_cue_decision" });
    expect(request.tools[0].name).toBe("emit_cue_decision");
    expect((request.tools[0].input_schema as { type: string }).type).toBe("object");

    expect(output.temperature).toBe(0);
    expect(output.id).toBe("msg_claude_001");
    expect(output.model).toBe(DEFAULT_CLAUDE_DECISION_MODEL);
    expect(() => cueDecisionSchema.parse(output.decision)).not.toThrow();
    expect(output.decision).toEqual(decision);
    expect(output.raw).toEqual(toolResponse(decision));
  });

  test("honors a configurable model and a per-request model override", async () => {
    const decision = sampleDecision();
    const configured = recordingTransport(toolResponse(decision));
    const configuredLlm = new ClaudeDecisionLLM({
      credentialSource: sanctionedCredentialSource,
      transport: configured.transport,
      model: "claude-sonnet-4-6",
    });
    await configuredLlm.decide(decisionInput());
    expect(configured.requests[0].model).toBe("claude-sonnet-4-6");

    const overridden = recordingTransport(toolResponse(decision));
    const overriddenLlm = new ClaudeDecisionLLM({
      credentialSource: sanctionedCredentialSource,
      transport: overridden.transport,
    });
    await overriddenLlm.decide(decisionInput({ model: "claude-haiku-4-5-20251001" }));
    expect(overridden.requests[0].model).toBe("claude-haiku-4-5-20251001");
  });

  test("rejects non-zero temperature inputs", async () => {
    const { transport } = recordingTransport(toolResponse(sampleDecision()));
    const llm = new ClaudeDecisionLLM({ credentialSource: sanctionedCredentialSource, transport });

    await expect(llm.decide(decisionInput({ temperature: 1 as 0 }))).rejects.toThrow("temperature-0");
  });

  test("rejects a response that omits the structured tool call", async () => {
    const transport: ClaudeMessagesTransport = async () => ({
      id: "msg_claude_002",
      model: DEFAULT_CLAUDE_DECISION_MODEL,
      content: [{ type: "text", text: "I cannot use the tool." }],
    });
    const llm = new ClaudeDecisionLLM({ credentialSource: sanctionedCredentialSource, transport });

    await expect(llm.decide(decisionInput())).rejects.toThrow("emit_cue_decision");
  });
});

describe("ClaudeDecisionLLM credential seam (integration)", () => {
  test("rejects raw inline credentials and an unsanctioned credential source", () => {
    const rawAnthropic = ["sk", "ant", "A".repeat(48)].join("-");

    // Raw env keys are rejected at the sanctioned credential seam.
    expect(() =>
      ClaudeDecisionLLM.fromModelCredentials({
        provider: "anthropic-claude",
        env: { ANTHROPIC_API_KEY: rawAnthropic },
      }),
    ).toThrow(/ANTHROPIC_API_KEY/u);

    // A raw inline key is rejected outright.
    expect(() =>
      ClaudeDecisionLLM.fromModelCredentials({ provider: "anthropic-claude", rawApiKey: rawAnthropic }),
    ).toThrow(/Raw provider key/u);

    // The wrong provider is refused.
    expect(() =>
      ClaudeDecisionLLM.fromModelCredentials({ provider: "openai-codex" } as never),
    ).toThrow(/anthropic-claude/u);

    // Constructing directly with a non-host-subscription source is refused.
    const audioSource: CredentialSource = {
      kind: "environment",
      provider: "deepgram",
      variable: "DEEPGRAM_API_KEY",
      redacted: true,
    };
    expect(() => new ClaudeDecisionLLM({ credentialSource: audioSource })).toThrow(/host-subscription/u);
  });

  test("constructs through the sanctioned seam and decides via a stubbed transport with no network", async () => {
    const fetchCalls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      fetchCalls.push(String(input));
      throw new Error("network is forbidden in offline credential-seam tests");
    }) as unknown as typeof fetch;

    try {
      const decision = sampleDecision();
      const { transport, requests } = recordingTransport(toolResponse(decision));
      const llm = ClaudeDecisionLLM.fromModelCredentials(
        { provider: "anthropic-claude", command: "claude --print" },
        { transport },
      );

      expect(llm.credentialSource).toEqual({
        kind: "host-subscription",
        provider: "anthropic-claude",
        command: "claude --print",
      });

      const output = await llm.decide(decisionInput());

      expect(output.decision).toEqual(decision);
      expect(requests).toHaveLength(1);
      expect(fetchCalls).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("the default fetch transport requires ANTHROPIC_API_KEY and never stores it on the decider", async () => {
    const transport = createFetchTransport(
      (() => {
        throw new Error("fetch should not run without an API key");
      }) as unknown as typeof fetch,
      {},
    );

    await expect(
      transport({
        model: DEFAULT_CLAUDE_DECISION_MODEL,
        max_tokens: 1024,
        temperature: 0,
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "emit_cue_decision", description: "x", input_schema: {} }],
        tool_choice: { type: "tool", name: "emit_cue_decision" },
      }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/u);
  });

  test("the default fetch transport posts to the Anthropic Messages API with the key header", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify(toolResponse(sampleDecision())), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const transport = createFetchTransport(fetchImpl, { ANTHROPIC_API_KEY: "stub-key-value" });
    const response = await transport({
      model: DEFAULT_CLAUDE_DECISION_MODEL,
      max_tokens: 1024,
      temperature: 0,
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "emit_cue_decision", description: "x", input_schema: {} }],
      tool_choice: { type: "tool", name: "emit_cue_decision" },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("stub-key-value");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(response.id).toBe("msg_claude_001");
  });
});
