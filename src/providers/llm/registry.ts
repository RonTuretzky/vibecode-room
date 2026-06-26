// DecisionLLM registry / factory (ISSUE-0005).
//
// `selectDecisionLLM(env, opts)` is the single seam that maps PANOP_DECISION_LLM
// onto a concrete DecisionLLM. It lives inside src/providers so it may import the
// concrete deciders directly (the provider boundary lint only forbids that
// outside src/providers — see providers/boundary.test.ts).
//
// Default selection is the heuristic decider: a no-key, deterministic policy.
// This is deliberate — with no PANOP_DECISION_LLM set the runtime must never ship
// an always-pass demo stub, so the no-credential default still makes real,
// reproducible decisions.
//
//   heuristic -> HeuristicDecisionLLM   (default; no key, deterministic)
//   claude    -> ClaudeDecisionLLM      (explicit; only when a credential resolves)
//   replay    -> ReplayDecisionLLM      (deterministic fixtures)
//
// NOTE: this issue only delivers + tests the factory and its barrel exposure.
// composition.ts / the live loop are intentionally NOT rewired here; that
// injection happens in ISSUE-0008.

import { ClaudeDecisionLLM, createFetchTransport, type ClaudeMessagesTransport } from "./claude";
import { HeuristicDecisionLLM } from "./heuristic";
import { ReplayDecisionLLM, type ReplayDecisionRecord } from "./replay";
import type { DecisionLLM } from "../types";

export type DecisionLLMMode = "heuristic" | "claude" | "replay";

// Default sanctioned host-subscription invocation for the Claude decider. The
// model credential is never a raw key — access routes through the host's
// logged-in Claude subscription (see providers/credentials.ts).
export const DEFAULT_CLAUDE_DECISION_COMMAND = "claude --print";

export interface DecisionLLMSelectionEnv {
  PANOP_DECISION_LLM?: string;
  // Deterministic signal that a Claude model credential is resolvable for the
  // API path. The host-subscription command is the sanctioned seam; this key is
  // only read to gate selection, never forwarded as a raw credential.
  ANTHROPIC_API_KEY?: string;
  [key: string]: string | undefined;
}

export interface DecisionLLMSelectionOptions {
  /** Override the heuristic policy label. */
  heuristicPolicy?: string;
  /** Model id for the Claude decider (defaults to the decider's own default). */
  claudeModel?: string;
  /** max_tokens for the Claude decider. */
  claudeMaxTokens?: number;
  /** Sanctioned host-subscription command for the Claude decider. */
  claudeCommand?: string;
  /** Injectable Anthropic transport (tests/e2e substitute a stub for no network). */
  claudeTransport?: ClaudeMessagesTransport;
  /** Replay records for the replay backend (deterministic fixtures). */
  replayRecords?: readonly ReplayDecisionRecord[];
}

export interface DecisionLLMSelection {
  mode: DecisionLLMMode;
  llm: DecisionLLM;
}

export function selectDecisionLLM(
  env: DecisionLLMSelectionEnv,
  options: DecisionLLMSelectionOptions = {},
): DecisionLLMSelection {
  const mode = resolveDecisionMode(env);
  switch (mode) {
    case "heuristic":
      return { mode, llm: new HeuristicDecisionLLM({ policy: options.heuristicPolicy }) };
    case "claude":
      return { mode, llm: createClaudeDecisionLLM(env, options) };
    case "replay":
      return { mode, llm: new ReplayDecisionLLM(options.replayRecords ?? []) };
  }
}

function resolveDecisionMode(env: DecisionLLMSelectionEnv): DecisionLLMMode {
  const explicit = env.PANOP_DECISION_LLM?.trim().toLowerCase();
  if (explicit !== undefined && explicit.length > 0) {
    if (explicit === "heuristic" || explicit === "claude" || explicit === "replay") {
      return explicit;
    }
    throw new Error(
      `Unknown PANOP_DECISION_LLM "${env.PANOP_DECISION_LLM}". Expected one of: heuristic, claude, replay.`,
    );
  }

  // Unset: heuristic — deterministic, no key, no always-pass stub.
  return "heuristic";
}

function createClaudeDecisionLLM(
  env: DecisionLLMSelectionEnv,
  options: DecisionLLMSelectionOptions,
): ClaudeDecisionLLM {
  if (!hasResolvableModelCredential(env)) {
    throw new Error(
      "PANOP_DECISION_LLM=claude requires a resolvable model credential (ANTHROPIC_API_KEY). " +
        "Set it, log into the host Claude subscription, or use PANOP_DECISION_LLM=heuristic for the no-key default.",
    );
  }

  // The credential itself is the host subscription, not the raw key: the command
  // routes through the sanctioned seam and the transport reads ANTHROPIC_API_KEY
  // at call time. The raw key is never passed through the credential constructor.
  const transport = options.claudeTransport ?? createFetchTransport(fetch, env);
  return ClaudeDecisionLLM.fromModelCredentials(
    { provider: "anthropic-claude", command: options.claudeCommand ?? DEFAULT_CLAUDE_DECISION_COMMAND },
    { transport, model: options.claudeModel, maxTokens: options.claudeMaxTokens },
  );
}

function hasResolvableModelCredential(env: DecisionLLMSelectionEnv): boolean {
  return typeof env.ANTHROPIC_API_KEY === "string" && env.ANTHROPIC_API_KEY.length > 0;
}
