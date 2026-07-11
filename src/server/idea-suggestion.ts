import type { IdeaCandidate } from "../detect";
import type { PendingSuggestion } from "../types";
import type { IdeaTrayItem, ProjectorSuggestion } from "../ui/types";

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

// The idea TRAY surfaces the WHOLE ledger — every in-flight candidate, not just
// the single primary bubble — so the room can explicitly build/dismiss instead of
// trusting one auto-surfaced idea. Ordering (contract): ready candidates first,
// then by confidence descending within each group.
export function ideaTrayFromCandidates(candidates: readonly IdeaCandidate[]): IdeaTrayItem[] {
  return candidates
    .map(ideaTrayItemFromCandidate)
    .sort((a, b) => {
      if (a.status !== b.status) {
        return a.status === "ready" ? -1 : 1;
      }
      return b.confidence - a.confidence;
    });
}

// Map one ledger candidate to its tray item. Evidence (contract): the latest
// span quote when the span text is available, else the contextSpan quote.
export function ideaTrayItemFromCandidate(candidate: IdeaCandidate): IdeaTrayItem {
  const latestQuote = candidate.spans.at(-1)?.quote ?? "";
  const evidence = latestQuote.length > 0 ? latestQuote : candidate.contextSpan.quote;
  return {
    id: candidate.id,
    pitch: candidate.pitch,
    confidence: clamp01(candidate.confidence),
    // Superseded candidates are pruned from the ledger; anything not ready is
    // still forming from the tray's point of view.
    status: candidate.status === "ready" ? "ready" : "forming",
    maturity: candidate.maturity,
    verified: candidate.verified,
    rationale: candidate.rationale.length > 0 ? candidate.rationale : undefined,
    evidence: evidence.length > 0 ? evidence : undefined,
  };
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}
