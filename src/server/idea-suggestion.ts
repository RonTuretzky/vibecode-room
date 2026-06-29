import type { IdeaCandidate } from "../detect";
import type { PendingSuggestion } from "../types";
import type { ProjectorSuggestion } from "../ui/types";

// How long a surfaced idea bubble stays acceptable before its pending suggestion
// expires (mirrors VIBERSYN_ACCEPT_WINDOW_SECONDS' 120s default).
export const DETECTION_BUBBLE_TTL_MS = 120_000;

// Map a detected idea candidate to the projector's idea-bubble shape. The bubble
// now carries its PROVENANCE — the turn span + verbatim quote the idea was
// grounded in — alongside the model's own confidence. The legacy `gate` field is
// repurposed to show confidence-as-progress so the existing gauge keeps working.
export function projectorSuggestionFromCandidate(candidate: IdeaCandidate): ProjectorSuggestion {
  const confidencePct = Math.round(clamp01(candidate.confidence) * 100);
  return {
    state: "queued",
    pitch: candidate.pitch,
    confidence: clamp01(candidate.confidence),
    gate: { words: confidencePct, minWords: 100, seconds: 0, minSeconds: 0 },
    questions: [...candidate.questions],
    contextSpan: { ...candidate.contextSpan },
    rationale: candidate.rationale,
  };
}

// Convert a detected idea candidate to a PendingSuggestion the acceptance/build
// path already understands. The suggestionId embeds the candidate id so the
// runtime can consume the right candidate after a build. pitch is guaranteed
// non-empty (the detector drops empty pitches); mcqs falls back to a default.
export function pendingSuggestionFromCandidate(
  candidate: IdeaCandidate,
  correlationId: string,
  expiresAt: number,
): PendingSuggestion {
  return {
    suggestionId: `sug-${candidate.id}`,
    pitch: candidate.pitch,
    mcqs: candidate.questions.length > 0 ? [...candidate.questions] : ["Proceed?"],
    answers: [...candidate.answers],
    correlationId,
    expiresAt,
  };
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}
