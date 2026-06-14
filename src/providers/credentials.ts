import type { CredentialSource } from "../types";
import { hasSecretLikeString } from "../security/secrets";

export type ModelSubscriptionProvider = "openai-codex" | "anthropic-claude";
export type AudioCredentialProvider = "deepgram" | "tts";

export interface ModelCredentialOptions {
  provider: ModelSubscriptionProvider;
  command?: string;
  env?: Record<string, string | undefined>;
  rawApiKey?: string;
}

export interface AudioCredentialOptions {
  provider: AudioCredentialProvider;
  variable: string;
  env?: Record<string, string | undefined>;
}

const RAW_MODEL_KEY_VARIABLES = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"] as const;

export function createModelCredentialSource(options: ModelCredentialOptions): CredentialSource {
  rejectRawModelCredentials(options);

  return {
    kind: "host-subscription",
    provider: options.provider,
    command: options.command ?? defaultHostCommand(options.provider),
  };
}

export function createAudioCredentialSource(options: AudioCredentialOptions): CredentialSource {
  const value = options.env?.[options.variable];
  if (value !== undefined && value.length > 0 && !hasSecretLikeString(value, [options.variable])) {
    throw new Error(`Credential variable ${options.variable} does not look like a provider token; refusing ambiguous credential.`);
  }

  return {
    kind: "environment",
    provider: options.provider,
    variable: options.variable,
    redacted: true,
  };
}

export function rejectRawModelCredentials(options: {
  env?: Record<string, string | undefined>;
  rawApiKey?: string;
}): void {
  if (options.rawApiKey !== undefined && options.rawApiKey.length > 0) {
    throw new Error("Raw provider key rejected. Model access must use the host's logged-in Codex/Claude subscriptions.");
  }

  for (const variable of RAW_MODEL_KEY_VARIABLES) {
    if (options.env?.[variable] !== undefined && options.env[variable] !== "") {
      throw new Error(`Raw provider key variable ${variable} rejected. Model access must use host subscriptions.`);
    }
  }
}

function defaultHostCommand(provider: ModelSubscriptionProvider): string {
  return provider === "openai-codex" ? "codex" : "claude";
}
