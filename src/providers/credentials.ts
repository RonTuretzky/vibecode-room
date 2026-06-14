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
const ALLOWED_HOST_COMMAND_ARGS: Record<ModelSubscriptionProvider, ReadonlySet<string>> = {
  "openai-codex": new Set(),
  "anthropic-claude": new Set(["--print"]),
};

export function createModelCredentialSource(options: ModelCredentialOptions): CredentialSource {
  rejectRawModelCredentials(options);
  const command = validateHostCommand(options.provider, options.command ?? defaultHostCommand(options.provider));

  return {
    kind: "host-subscription",
    provider: options.provider,
    command,
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

function validateHostCommand(provider: ModelSubscriptionProvider, command: string): string {
  if (hasSecretLikeString(command, ["command"])) {
    throw new Error("Host subscription command rejected because it contains credential-shaped text.");
  }

  const argv = parseHostCommand(command);
  const expectedExecutable = defaultHostCommand(provider);
  if (argv[0] !== expectedExecutable) {
    throw new Error(`Host subscription command must start with ${expectedExecutable}.`);
  }

  for (const arg of argv.slice(1)) {
    if (!isSafeHostCommandArg(provider, arg)) {
      throw new Error("Host subscription command contains an unsupported argument.");
    }
  }

  return argv.join(" ");
}

function parseHostCommand(command: string): string[] {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    throw new Error("Host subscription command cannot be empty.");
  }

  if (/[\0"'`\\;&|<>$(){}[\]\n\r]/u.test(trimmed) || /\b[A-Z][A-Z0-9_]*=/u.test(trimmed)) {
    throw new Error("Host subscription command is not a plain allowlisted CLI invocation.");
  }

  const argv = trimmed.split(/\s+/u);
  if (argv.length === 0) {
    throw new Error("Host subscription command cannot be empty.");
  }
  return argv;
}

function isSafeHostCommandArg(provider: ModelSubscriptionProvider, arg: string): boolean {
  return ALLOWED_HOST_COMMAND_ARGS[provider].has(arg);
}
