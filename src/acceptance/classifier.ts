import {
  evaluateSemanticIntentGate,
  type SemanticIntentGateOptions,
  type SemanticIntentGateResult,
} from "../cue/intent-gate";
import { loadRoutingVocabulary, matchPhrase, normalizeSpeech, type RoutingVocabulary } from "../routing/vocabulary";
import type { DispatchedAction, PendingSuggestion, TranscriptObservation } from "../types";
import { ACCEPTANCE_STATE_SUGGESTION_DELIVERY, type PendingSuggestionOwner } from "./pending";

export const DEFAULT_ACCEPTANCE_CLASSIFIER_POLICY = "acceptance-classifier.v0";

export type AcceptanceClassification =
  | {
      kind: "accept";
      suggestion: PendingSuggestion;
      correlationId: string;
      decisionId: string;
      gate: SemanticIntentGateResult;
    }
  | {
      kind: "decline";
      suggestion: PendingSuggestion;
      correlationId: string;
      decisionId: string;
      gate: SemanticIntentGateResult;
    }
  | {
      kind: "mcq-answer";
      mcqIndex: number;
      answer: string;
      correlationId: string;
      decisionId: string;
    }
  | {
      kind: "ignored";
      reason: "not-suggestion-delivery" | "intent-gate" | "no-question-open" | "empty";
      correlationId: string;
      decisionId: string;
      gate?: SemanticIntentGateResult;
    };

export interface AcceptanceClassifierOptions {
  pending: PendingSuggestionOwner;
  vocabulary?: RoutingVocabulary;
  semanticIntentGate?: SemanticIntentGateOptions;
  idFactory?: () => string;
}

export interface AcceptanceClassifierInput {
  observation: TranscriptObservation;
  correlationId?: string;
  decisionId?: string;
}

type CandidateKind = "accept" | "decline";

export class AcceptanceClassifier {
  readonly #pending: PendingSuggestionOwner;
  readonly #vocabulary: RoutingVocabulary;
  readonly #semanticIntentGate?: SemanticIntentGateOptions;
  readonly #idFactory: () => string;

  constructor(options: AcceptanceClassifierOptions) {
    this.#pending = options.pending;
    this.#vocabulary = options.vocabulary ?? loadRoutingVocabulary();
    this.#semanticIntentGate = options.semanticIntentGate;
    this.#idFactory = options.idFactory ?? (() => crypto.randomUUID());
  }

  async classify(input: AcceptanceClassifierInput): Promise<AcceptanceClassification> {
    const correlationId = input.correlationId ?? `corr-${this.#idFactory()}`;
    const decisionId = input.decisionId ?? `decision-${this.#idFactory()}`;
    const pending = this.#pending.pending();

    if (this.#pending.state() !== ACCEPTANCE_STATE_SUGGESTION_DELIVERY || pending === null) {
      return { kind: "ignored", reason: "not-suggestion-delivery", correlationId, decisionId };
    }

    const text = normalizeSpeech(input.observation.text);
    if (text.length === 0) {
      return { kind: "ignored", reason: "empty", correlationId, decisionId };
    }

    const candidate = this.#candidate(text);
    if (candidate !== null) {
      const action = candidateAction(candidate.kind, pending, correlationId);
      const gate = await evaluateSemanticIntentGate({
        observation: input.observation,
        cueDecision: { name: "text", metadata: { pattern: candidate.pattern } },
        action,
        correlationId,
        decisionId,
        options: this.#semanticIntentGate,
      });

      if (!gate.accepted) {
        return { kind: "ignored", reason: "intent-gate", correlationId, decisionId, gate };
      }

      return { kind: candidate.kind, suggestion: pending, correlationId, decisionId, gate };
    }

    if (!this.#pending.questionOpen()) {
      return { kind: "ignored", reason: "no-question-open", correlationId, decisionId };
    }

    const answer = this.#pending.appendAnswer(input.observation.text, correlationId);
    if (answer === null) {
      return { kind: "ignored", reason: "empty", correlationId, decisionId };
    }

    return {
      kind: "mcq-answer",
      mcqIndex: answer.mcqIndex,
      answer: answer.answer,
      correlationId,
      decisionId,
    };
  }

  #candidate(text: string): { kind: CandidateKind; pattern: string } | null {
    const accept = matchPhrase(text, this.#vocabulary.accept);
    if (accept !== undefined) {
      return { kind: "accept", pattern: accept };
    }

    const decline = matchPhrase(text, this.#vocabulary.decline);
    if (decline !== undefined) {
      return { kind: "decline", pattern: decline };
    }

    return null;
  }
}

function candidateAction(
  kind: CandidateKind,
  suggestion: PendingSuggestion,
  correlationId: string,
): DispatchedAction {
  return {
    type: kind === "accept" ? "spawn" : "status",
    targetUPID: null,
    payload: {
      suggestionId: suggestion.suggestionId,
      pitch: suggestion.pitch,
      mcqs: suggestion.mcqs,
      answers: suggestion.answers,
      source: `voice-${kind}`,
    },
    correlationId,
  };
}
