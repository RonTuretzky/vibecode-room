// DecisionLLM registry / factory (ISSUE-0005).
//
// `selectDecisionLLM(env, opts)` is the single seam that maps VIBERSYN_DECISION_LLM
// onto a concrete DecisionLLM. It lives inside src/providers so it may import the
// concrete deciders directly (the provider boundary lint only forbids that
// outside src/providers — see providers/boundary.test.ts).
//
// Selection precedence (ISSUE-0023): an explicit VIBERSYN_DECISION_LLM always wins;
// with it unset the registry auto-selects the Claude decider when a model
// credential resolves, so the runtime makes model-quality decisions by default,
// and otherwise falls back to the heuristic decider. The heuristic remains the
// no-key default — with no credential the runtime must never ship an always-pass
// demo stub, so it still makes real, reproducible decisions.
//
//   heuristic -> HeuristicDecisionLLM   (no-credential default; deterministic)
//   claude    -> ClaudeDecisionLLM      (auto-selected when a credential resolves)
//   replay    -> ReplayDecisionLLM      (deterministic fixtures)
//
//   explicit env  >  credential auto-select  >  heuristic default

import { ClaudeDecisionLLM, createFetchTransport, type ClaudeMessagesTransport } from "./claude";
import { CueCerebrasDecisionLLM, type IdeaProposer } from "./cue-cerebras";
import { HeuristicDecisionLLM } from "./heuristic";
import { HostClaudeDecisionLLM, type ClaudeCliRunner } from "./host-claude";
import { ReplayDecisionLLM, type ReplayDecisionRecord } from "./replay";
import { WindowedDecisionLLM } from "./windowed";
import type { DecisionLLM } from "../types";

// "claude-cli" = genuine inference via the host's logged-in `claude` CLI (no key).
// "cue-cerebras" = idea inference through Cue's CerebrasLLMProvider (needs CEREBRAS_API_KEY).
export type DecisionLLMMode = "heuristic" | "claude" | "claude-cli" | "cue-cerebras" | "replay";

// Default sanctioned host-subscription invocation for the Claude decider. The
// model credential is never a raw key — access routes through the host's
// logged-in Claude subscription (see providers/credentials.ts).
export const DEFAULT_CLAUDE_DECISION_COMMAND = "claude --print";

export interface DecisionLLMSelectionEnv {
  VIBERSYN_DECISION_LLM?: string;
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
  /** Model id for the host-claude (CLI) decider (defaults to a fast model). */
  hostClaudeModel?: string;
  /** Injectable CLI runner for the host-claude decider (tests avoid shelling out). */
  hostClaudeRunner?: ClaudeCliRunner;
  /** Cerebras model id for the cue-cerebras decider. */
  cerebrasModel?: string;
  /** Injectable idea proposer for the cue-cerebras decider (tests avoid Cue/Cerebras). */
  cueProposer?: IdeaProposer;
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
    case "claude-cli":
      // HostClaudeDecisionLLM carries its own window + throttle (CLI is slow).
      return { mode, llm: new HostClaudeDecisionLLM({ model: options.hostClaudeModel, runner: options.hostClaudeRunner }) };
    case "cue-cerebras":
      // Idea inference through Cue's CerebrasLLMProvider, windowed for context.
      return {
        mode,
        llm: new WindowedDecisionLLM(
          new CueCerebrasDecisionLLM({ proposer: options.cueProposer, model: options.cerebrasModel }),
          { minIntervalMs: 1500 },
        ),
      };
    case "replay":
      return { mode, llm: new ReplayDecisionLLM(options.replayRecords ?? []) };
  }
}

function resolveDecisionMode(env: DecisionLLMSelectionEnv): DecisionLLMMode {
  const explicit = env.VIBERSYN_DECISION_LLM?.trim().toLowerCase();
  if (explicit !== undefined && explicit.length > 0) {
    if (
      explicit === "heuristic" ||
      explicit === "claude" ||
      explicit === "claude-cli" ||
      explicit === "cue-cerebras" ||
      explicit === "replay"
    ) {
      return explicit;
    }
    throw new Error(
      `Unknown VIBERSYN_DECISION_LLM "${env.VIBERSYN_DECISION_LLM}". Expected one of: heuristic, claude, claude-cli, cue-cerebras, replay.`,
    );
  }

  // Unset: auto-select the Claude decider when a model credential resolves so the
  // runtime decisions are model-quality by default; otherwise the heuristic —
  // deterministic, no key, no always-pass stub.
  return hasResolvableModelCredential(env) ? "claude" : "heuristic";
}

function createClaudeDecisionLLM(
  env: DecisionLLMSelectionEnv,
  options: DecisionLLMSelectionOptions,
): ClaudeDecisionLLM {
  if (!hasResolvableModelCredential(env)) {
    throw new Error(
      "VIBERSYN_DECISION_LLM=claude requires a resolvable model credential (ANTHROPIC_API_KEY). " +
        "Set it, log into the host Claude subscription, or use VIBERSYN_DECISION_LLM=heuristic for the no-key default.",
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
