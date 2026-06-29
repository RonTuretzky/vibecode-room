import type { ContextSpan, DetectedIdea, IdeaCandidate, IdeaCandidateStatus, TranscriptTurn } from "./types";

export interface ReconcileOptions {
  nowMs: number;
  // Confidence at/above which a candidate is "ready" (surfaceable / buildable).
  readyThreshold: number;
  // Once ready, stay ready until confidence drops below threshold - hysteresis.
  // Prevents the bubble flickering as the model's confidence wobbles round to round.
  readyHysteresis: number;
  // Drop a candidate after this many consecutive rounds without re-detection.
  maxMissedRounds: number;
  idFactory: () => string;
  // Current window turns, for span-overlap matching when the model omits matchId.
  turns: readonly TranscriptTurn[];
}

export interface ReconcileResult {
  candidates: IdeaCandidate[];
  created: IdeaCandidate[];
  updated: IdeaCandidate[];
  superseded: IdeaCandidate[];
}

// Fold a fresh round of detected ideas into the in-flight candidate set:
//   • matchId (or span overlap) → UPDATE the existing candidate in place
//   • no match                  → CREATE a new candidate
//   • existing not re-detected   → age it; supersede after maxMissedRounds
// Status is confidence-driven with hysteresis, so a forming idea promotes to
// ready when the model gets confident and never thrashes on the boundary.
export function reconcile(
  existing: readonly IdeaCandidate[],
  detected: readonly DetectedIdea[],
  options: ReconcileOptions,
): ReconcileResult {
  const byId = new Map(existing.map((c) => [c.id, c]));
  const matchedIds = new Set<string>();
  const created: IdeaCandidate[] = [];
  const updated: IdeaCandidate[] = [];
  // Preserve original order for stable rendering; new candidates append.
  const order: string[] = existing.map((c) => c.id);

  for (const idea of detected) {
    const target = resolveMatch(idea, existing, matchedIds, options.turns);
    if (target !== null) {
      matchedIds.add(target.id);
      const next = applyDetection(target, idea, options, target.status === "ready");
      byId.set(target.id, next);
      updated.push(next);
      continue;
    }
    const id = options.idFactory();
    const fresh = applyDetection(
      {
        id,
        pitch: idea.pitch,
        confidence: idea.confidence,
        questions: idea.questions,
        answers: idea.answers,
        contextSpan: idea.contextSpan,
        rationale: idea.rationale,
        status: "forming",
        firstSeenAtMs: options.nowMs,
        updatedAtMs: options.nowMs,
        missedRounds: 0,
      },
      idea,
      options,
      false,
    );
    byId.set(id, fresh);
    order.push(id);
    created.push(fresh);
  }

  const superseded: IdeaCandidate[] = [];
  for (const candidate of existing) {
    if (matchedIds.has(candidate.id)) {
      continue;
    }
    const missedRounds = candidate.missedRounds + 1;
    if (missedRounds > options.maxMissedRounds) {
      byId.set(candidate.id, { ...candidate, status: "superseded", missedRounds });
      superseded.push({ ...candidate, status: "superseded", missedRounds });
    } else {
      byId.set(candidate.id, { ...candidate, missedRounds });
    }
  }

  const candidates = order
    .map((id) => byId.get(id))
    .filter((c): c is IdeaCandidate => c !== undefined && c.status !== "superseded");
  return { candidates, created, updated, superseded };
}

export function statusForConfidence(
  confidence: number,
  wasReady: boolean,
  readyThreshold: number,
  readyHysteresis: number,
): IdeaCandidateStatus {
  if (confidence >= readyThreshold) {
    return "ready";
  }
  if (wasReady && confidence >= readyThreshold - readyHysteresis) {
    return "ready";
  }
  return "forming";
}

function applyDetection(
  base: IdeaCandidate,
  idea: DetectedIdea,
  options: ReconcileOptions,
  wasReady: boolean,
): IdeaCandidate {
  return {
    ...base,
    pitch: idea.pitch,
    confidence: idea.confidence,
    questions: idea.questions,
    answers: idea.answers,
    contextSpan: idea.contextSpan,
    rationale: idea.rationale,
    status: statusForConfidence(idea.confidence, wasReady, options.readyThreshold, options.readyHysteresis),
    updatedAtMs: options.nowMs,
    missedRounds: 0,
  };
}

function resolveMatch(
  idea: DetectedIdea,
  existing: readonly IdeaCandidate[],
  alreadyMatched: Set<string>,
  turns: readonly TranscriptTurn[],
): IdeaCandidate | null {
  if (idea.matchId !== null) {
    const byMatchId = existing.find((c) => c.id === idea.matchId && !alreadyMatched.has(c.id));
    if (byMatchId !== undefined) {
      return byMatchId;
    }
  }
  // Fall back to context-span overlap so an elaborated idea merges even when the
  // model forgets to echo the matchId.
  let best: { candidate: IdeaCandidate; overlap: number } | null = null;
  for (const candidate of existing) {
    if (alreadyMatched.has(candidate.id)) {
      continue;
    }
    const overlap = spanOverlap(candidate.contextSpan, idea.contextSpan, turns);
    if (overlap > 0 && (best === null || overlap > best.overlap)) {
      best = { candidate, overlap };
    }
  }
  return best?.candidate ?? null;
}

function spanOverlap(a: ContextSpan, b: ContextSpan, turns: readonly TranscriptTurn[]): number {
  const index = (id: string): number => turns.findIndex((t) => t.id === id);
  const a0 = index(a.startTurnId);
  const a1 = index(a.endTurnId);
  const b0 = index(b.startTurnId);
  const b1 = index(b.endTurnId);
  if ([a0, a1, b0, b1].some((i) => i === -1)) {
    return 0;
  }
  const lo = Math.max(Math.min(a0, a1), Math.min(b0, b1));
  const hi = Math.min(Math.max(a0, a1), Math.max(b0, b1));
  return Math.max(0, hi - lo + 1);
}
