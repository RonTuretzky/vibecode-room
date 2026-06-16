import type { DecisionInput, DecisionLLM, DecisionOutput } from "../providers";
import type { DispatchedAction, TranscriptObservation } from "../types";

export interface CueTextDecision {
  name?: string;
  metadata?: Record<string, unknown>;
}

export interface SemanticIntentGateOptions {
  llm?: DecisionLLM;
  model?: string;
}

export interface SemanticIntentGateInput {
  observation: TranscriptObservation;
  cueDecision?: CueTextDecision;
  action: DispatchedAction;
  correlationId: string;
  decisionId: string;
  options?: SemanticIntentGateOptions;
}

export interface SemanticIntentGateResult {
  accepted: boolean;
  source: "not-text-cue" | "prefilter" | "llm" | "fail-closed";
  reason: string;
  llmOutput?: DecisionOutput;
}

const DEFAULT_MODEL = "intent-gate-temp-0";
const ADVERSATIVE_WORDS = [
  "although",
  "but",
  "except",
  "however",
  "nevertheless",
  "nonetheless",
  "only",
  "though",
  "unless",
  "whereas",
  "yet",
] as const;
const MAX_DIRECT_COMMAND_WORDS = 8;

export async function evaluateSemanticIntentGate(input: SemanticIntentGateInput): Promise<SemanticIntentGateResult> {
  if (input.cueDecision?.name !== "text") {
    return { accepted: true, source: "not-text-cue", reason: "non-text-cue-action" };
  }

  const prefilter = prefilterTextCueIntent(input.observation.text, cuePattern(input.cueDecision));
  if (prefilter.accepted) {
    return { accepted: true, source: "prefilter", reason: prefilter.reason };
  }

  const llm = input.options?.llm;
  if (llm === undefined) {
    return { accepted: false, source: "fail-closed", reason: "semantic-intent-llm-unavailable" };
  }

  const llmOutput = await llm.decide(createSemanticIntentDecisionInput(input));
  return {
    accepted: llmOutput.decision.kind === "action",
    source: "llm",
    reason: llmOutput.decision.kind === "action" ? "llm-standalone-command" : "llm-conversational-filler",
    llmOutput,
  };
}

export function createSemanticIntentDecisionInput(input: SemanticIntentGateInput): DecisionInput {
  const matchedPattern = cuePattern(input.cueDecision);

  return {
    model: input.options?.model ?? DEFAULT_MODEL,
    temperature: 0,
    correlationId: input.correlationId,
    messages: [
      {
        role: "system",
        content:
          "Decide whether the transcript is a standalone user command/affirmation or conversational filler. Return action only for a standalone command; return pass for filler, hedging, quotation, or context such as adversative conjunctions.",
      },
      {
        role: "user",
        content: JSON.stringify({
          transcript: input.observation.text,
          matchedPattern,
          candidateAction: {
            type: input.action.type,
            targetUPID: input.action.targetUPID,
            payload: input.action.payload,
          },
        }),
      },
    ],
    metadata: {
      gate: "cue.semantic-intent",
      utteranceId: input.observation.utteranceId,
      actionType: input.action.type,
      matchedPattern,
      decisionId: input.decisionId,
    },
  };
}

export function prefilterTextCueIntent(
  transcript: string,
  matchedPattern: string | undefined,
): { accepted: boolean; reason: string } {
  const words = wordsIn(transcript);
  if (words.length === 0 || hasAdversative(words)) {
    return { accepted: false, reason: words.length === 0 ? "empty-transcript" : "adversative-context" };
  }

  const patternWords = wordsIn(matchedPattern ?? "");
  if (patternWords.length === 0) {
    return words.length <= MAX_DIRECT_COMMAND_WORDS
      ? { accepted: true, reason: "short-command" }
      : { accepted: false, reason: "requires-semantic-check" };
  }

  const patternIndex = indexOfSequence(words, patternWords);
  if (patternIndex === -1) {
    return { accepted: false, reason: "cue-pattern-not-in-transcript" };
  }

  const onlyPattern = words.length === patternWords.length;
  const startsWithPattern = patternIndex === 0;
  if (onlyPattern || (startsWithPattern && words.length <= MAX_DIRECT_COMMAND_WORDS)) {
    return { accepted: true, reason: onlyPattern ? "bare-cue-command" : "short-cue-command" };
  }

  return { accepted: false, reason: "requires-semantic-check" };
}

function cuePattern(cueDecision: CueTextDecision | undefined): string | undefined {
  const pattern = cueDecision?.metadata?.pattern;
  return typeof pattern === "string" ? pattern : undefined;
}

function wordsIn(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9']+/gu) ?? [];
}

function hasAdversative(words: readonly string[]): boolean {
  return words.some((word) => ADVERSATIVE_WORDS.includes(word as (typeof ADVERSATIVE_WORDS)[number]));
}

function indexOfSequence(words: readonly string[], pattern: readonly string[]): number {
  const maxStart = words.length - pattern.length;
  for (let start = 0; start <= maxStart; start += 1) {
    if (pattern.every((word, index) => words[start + index] === word)) {
      return start;
    }
  }
  return -1;
}
