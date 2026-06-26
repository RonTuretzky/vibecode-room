import { z } from "zod";
import { cueDecisionSchema, type CredentialSource, type CueDecision } from "../../types";
import { createModelCredentialSource, rejectRawModelCredentials, type ModelCredentialOptions } from "../credentials";
import type { DecisionInput, DecisionLLM, DecisionMessage, DecisionOutput } from "../types";

export const DEFAULT_CLAUDE_DECISION_MODEL = "claude-opus-4-8";
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DECISION_TOOL_NAME = "emit_cue_decision";
const DEFAULT_MAX_TOKENS = 1024;

// The Anthropic Messages API only accepts an object at the root of a tool's
// input_schema, so the discriminated CueDecision union is nested under a single
// `decision` property and unwrapped after the model responds.
const DECISION_TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    decision: z.toJSONSchema(cueDecisionSchema),
  },
  required: ["decision"],
  additionalProperties: false,
} as const;

export interface AnthropicToolDefinition {
  name: string;
  description: string;
  input_schema: unknown;
}

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AnthropicMessagesRequest {
  model: string;
  max_tokens: number;
  temperature: 0;
  system?: string;
  messages: AnthropicMessage[];
  tools: AnthropicToolDefinition[];
  tool_choice: { type: "tool"; name: string };
}

export interface AnthropicContentBlock {
  type: string;
  name?: string;
  input?: unknown;
  text?: string;
}

export interface AnthropicMessagesResponse {
  id: string;
  model: string;
  content: AnthropicContentBlock[];
}

/**
 * Injectable network seam. The default transport reads ANTHROPIC_API_KEY at
 * call time so the raw key never crosses the ClaudeDecisionLLM constructor;
 * unit tests substitute a stub so no real request is made.
 */
export type ClaudeMessagesTransport = (
  request: AnthropicMessagesRequest,
  signal?: AbortSignal,
) => Promise<AnthropicMessagesResponse>;

export interface ClaudeDecisionLLMOptions {
  credentialSource: CredentialSource;
  transport?: ClaudeMessagesTransport;
  model?: string;
  maxTokens?: number;
}

export class ClaudeDecisionLLM implements DecisionLLM {
  readonly credentialSource: CredentialSource;
  readonly #transport: ClaudeMessagesTransport;
  readonly #model: string;
  readonly #maxTokens: number;

  constructor(options: ClaudeDecisionLLMOptions) {
    this.credentialSource = assertSanctionedCredentialSource(options.credentialSource);
    this.#transport = options.transport ?? createFetchTransport();
    this.#model = options.model ?? DEFAULT_CLAUDE_DECISION_MODEL;
    this.#maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  /**
   * Build a decider through the sanctioned model credential seam. This routes
   * the credentials through createModelCredentialSource / rejectRawModelCredentials
   * so a raw inline key can never be smuggled in.
   */
  static fromModelCredentials(
    credentials: ModelCredentialOptions,
    options: Omit<ClaudeDecisionLLMOptions, "credentialSource"> = {},
  ): ClaudeDecisionLLM {
    if (credentials.provider !== "anthropic-claude") {
      throw new Error("ClaudeDecisionLLM requires the anthropic-claude credential provider.");
    }

    const credentialSource = createModelCredentialSource(credentials);
    return new ClaudeDecisionLLM({ ...options, credentialSource });
  }

  async decide(input: DecisionInput): Promise<DecisionOutput> {
    if (input.temperature !== undefined && input.temperature !== 0) {
      throw new Error("ClaudeDecisionLLM only issues temperature-0 requests.");
    }

    const request = this.buildRequest(input);
    const response = await this.#transport(request);
    const decision = parseDecision(response);

    return {
      id: response.id,
      model: response.model,
      temperature: 0,
      decision,
      raw: response,
    };
  }

  buildRequest(input: DecisionInput): AnthropicMessagesRequest {
    const system = collectSystemPrompt(input.messages);
    const messages = input.messages.filter((message) => message.role !== "system").map(toAnthropicMessage);

    if (messages.length === 0) {
      throw new Error("ClaudeDecisionLLM requires at least one non-system message.");
    }

    const request: AnthropicMessagesRequest = {
      model: input.model.length > 0 ? input.model : this.#model,
      max_tokens: this.#maxTokens,
      temperature: 0,
      messages,
      tools: [
        {
          name: DECISION_TOOL_NAME,
          description:
            "Return the cue decision for the supplied transcript. Always call this tool with a single CueDecision.",
          input_schema: DECISION_TOOL_INPUT_SCHEMA,
        },
      ],
      tool_choice: { type: "tool", name: DECISION_TOOL_NAME },
    };

    if (system.length > 0) {
      request.system = system;
    }

    return request;
  }
}

function assertSanctionedCredentialSource(source: CredentialSource): CredentialSource {
  if (source.kind !== "host-subscription" || source.provider !== "anthropic-claude") {
    throw new Error(
      "ClaudeDecisionLLM requires a host-subscription credential source for anthropic-claude; raw keys are rejected.",
    );
  }

  return source;
}

function collectSystemPrompt(messages: readonly DecisionMessage[]): string {
  return messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n")
    .trim();
}

function toAnthropicMessage(message: DecisionMessage): AnthropicMessage {
  // Anthropic exposes only user/assistant roles; tool turns are folded into the
  // user side so transcripts with tool feedback still map cleanly.
  const role = message.role === "assistant" ? "assistant" : "user";
  return { role, content: message.content };
}

function parseDecision(response: AnthropicMessagesResponse): CueDecision {
  const block = response.content.find(
    (entry): entry is AnthropicContentBlock => entry.type === "tool_use" && entry.name === DECISION_TOOL_NAME,
  );

  if (block === undefined) {
    throw new Error("Anthropic response did not include the emit_cue_decision tool call.");
  }

  const input = block.input;
  if (typeof input !== "object" || input === null || !("decision" in input)) {
    throw new Error("emit_cue_decision tool call is missing the decision payload.");
  }

  return cueDecisionSchema.parse((input as { decision: unknown }).decision);
}

export function createFetchTransport(
  fetchImpl: typeof fetch = fetch,
  env: Record<string, string | undefined> = process.env,
): ClaudeMessagesTransport {
  return async (request, signal) => {
    const apiKey = env.ANTHROPIC_API_KEY;
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error("ANTHROPIC_API_KEY is not set; cannot reach the Anthropic Messages API.");
    }

    const response = await fetchImpl(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(request),
      signal,
    });

    if (!response.ok) {
      throw new Error(`Anthropic Messages API request failed with status ${response.status}.`);
    }

    return (await response.json()) as AnthropicMessagesResponse;
  };
}
