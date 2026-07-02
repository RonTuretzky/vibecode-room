import { deriveAssessment, type IdeaAssessment, type IdeaMaturity } from "./rubric";
import type { ContextSpan, DetectedIdea, IdeaCandidate, TranscriptTurn } from "./types";

// The idea LEDGER: cross-round state for every idea the room has expressed.
// Replaces the old one-shot reconciler with a lifecycle model:
//
//   forming ──(rubric surfaces + verification upholds)──► proposed/actionable
//      ▲                │ re-detected across rounds → elaborated (evidence grows)
//      └──(stance drops: retraction / verifier veto / staleness)
//
// Identity is stable across rounds (matchId from the judge, span-overlap as the
// fallback), evidence spans ACCUMULATE (the idea's trail through the
// conversation), maturity ratchets up only while the judge keeps supporting the
// idea and drops the moment the room's stance does.

export interface LedgerConfig {
  readyThreshold: number;
  readyHysteresis: number;
  maxMissedRounds: number;
  maxSpans: number;
}

export interface LedgerDelta {
  candidates: IdeaCandidate[];
  created: IdeaCandidate[];
  updated: IdeaCandidate[];
  superseded: IdeaCandidate[];
}

// For judgment-less detected ideas (test fakes, legacy detectors) derive a
// neutral assessment straight from the bare confidence so ledger behavior is
// uniform: surfaceable at/above the threshold, forming below.
function pseudoAssessment(confidence: number, threshold: number): IdeaAssessment {
  const surfaceable = confidence >= threshold;
  return {
    confidence,
    surfaceable,
    maturity: surfaceable ? "proposed" : "forming",
    blockedBy: surfaceable ? [] : ["below-threshold"],
  };
}

const MATURITY_ORDER: Record<IdeaMaturity, number> = { forming: 0, proposed: 1, elaborated: 2, actionable: 3 };

// Deep-enough copy for delta/candidate snapshots: later rounds must not mutate
// arrays inside snapshots handed to callers.
function snapshot(entry: IdeaCandidate): IdeaCandidate {
  return { ...entry, spans: [...entry.spans], questions: [...entry.questions], answers: [...entry.answers] };
}

export class IdeaLedger {
  readonly #config: LedgerConfig;
  readonly #idFactory: () => string;
  #entries: IdeaCandidate[] = [];

  constructor(config: LedgerConfig, idFactory: () => string) {
    this.#config = config;
    this.#idFactory = idFactory;
  }

  // Fold one detection round into the ledger. `detected` are this round's judged
  // ideas; entries not re-detected age and eventually supersede.
  reconcile(detected: readonly DetectedIdea[], turns: readonly TranscriptTurn[], nowMs: number): LedgerDelta {
    const matched = new Set<string>();
    const createdIds = new Set<string>();
    const created: IdeaCandidate[] = [];
    const updated: IdeaCandidate[] = [];

    for (const idea of detected) {
      // Entries created THIS round are never match targets: two distinct ideas
      // detected in one round must not merge into each other.
      const target = this.#resolveMatch(idea, matched, createdIds, turns);
      if (target !== null) {
        matched.add(target.id);
        this.#applyDetection(target, idea, nowMs);
        updated.push(snapshot(target));
        continue;
      }
      const entry = this.#createEntry(idea, nowMs);
      this.#entries.push(entry);
      createdIds.add(entry.id);
      created.push(snapshot(entry));
    }

    const superseded: IdeaCandidate[] = [];
    for (const entry of this.#entries) {
      if (matched.has(entry.id) || createdIds.has(entry.id)) {
        continue;
      }
      entry.missedRounds += 1;
      if (entry.missedRounds > this.#config.maxMissedRounds) {
        entry.status = "superseded";
        superseded.push(snapshot(entry));
      }
    }
    this.#entries = this.#entries.filter((entry) => entry.status !== "superseded");

    return { candidates: this.candidates(), created, updated, superseded };
  }

  candidates(): IdeaCandidate[] {
    return this.#entries.map((entry) => snapshot(entry));
  }

  find(id: string): IdeaCandidate | null {
    const entry = this.#entries.find((e) => e.id === id);
    return entry === undefined ? null : snapshot(entry);
  }

  // Candidates that just need adversarial verification: ready, never verified,
  // not (still) vetoed.
  needingVerification(): IdeaCandidate[] {
    return this.candidates().filter((c) => c.status === "ready" && !c.verified && c.vetoReason === null);
  }

  markVerified(id: string): void {
    const entry = this.#entries.find((e) => e.id === id);
    if (entry !== undefined) {
      entry.verified = true;
      entry.vetoReason = null;
    }
  }

  // A verifier rejection: demote to forming and remember why + at what strength.
  // The veto lifts only if the idea comes back materially stronger (the room kept
  // talking and the judge's rubric rose), at which point verification reruns.
  veto(id: string, reason: string): void {
    const entry = this.#entries.find((e) => e.id === id);
    if (entry !== undefined) {
      entry.verified = false;
      entry.vetoReason = reason;
      entry.status = "forming";
      entry.maturity = "forming";
      entry.vetoAtConfidence = entry.confidence;
    }
  }

  accept(id: string): IdeaCandidate | null {
    const entry = this.#entries.find((e) => e.id === id);
    if (entry === undefined) {
      return null;
    }
    this.#entries = this.#entries.filter((e) => e.id !== id);
    return snapshot(entry);
  }

  clear(): void {
    this.#entries = [];
  }

  // ── internals ───────────────────────────────────────────────────────────────
  #assessmentFor(idea: DetectedIdea): IdeaAssessment {
    if (idea.judgment !== undefined) {
      // Re-derive against the LEDGER's threshold so engine config governs
      // surfacing even if the judge used a different default.
      return deriveAssessment(idea.judgment.rubric, this.#config.readyThreshold);
    }
    return pseudoAssessment(idea.confidence, this.#config.readyThreshold);
  }

  #createEntry(idea: DetectedIdea, nowMs: number): IdeaCandidate {
    const assessment = this.#assessmentFor(idea);
    return {
      id: this.#idFactory(),
      pitch: idea.pitch,
      confidence: assessment.confidence,
      questions: [...idea.questions],
      answers: [...idea.answers],
      contextSpan: { ...idea.contextSpan },
      spans: [{ ...idea.contextSpan }],
      rationale: idea.rationale,
      status: assessment.surfaceable ? "ready" : "forming",
      maturity: assessment.maturity,
      judgment: idea.judgment === undefined ? undefined : { rubric: { ...idea.judgment.rubric }, assessment },
      verified: false,
      vetoReason: null,
      roundsSeen: 1,
      firstSeenAtMs: nowMs,
      updatedAtMs: nowMs,
      missedRounds: 0,
    };
  }

  #applyDetection(entry: IdeaCandidate, idea: DetectedIdea, nowMs: number): void {
    const assessment = this.#assessmentFor(idea);
    const wasReady = entry.status === "ready";
    const priorPitch = entry.pitch;

    entry.pitch = idea.pitch;
    entry.confidence = assessment.confidence;
    entry.questions = [...idea.questions];
    entry.answers = [...idea.answers];
    entry.rationale = idea.rationale;
    entry.judgment = idea.judgment === undefined ? entry.judgment : { rubric: { ...idea.judgment.rubric }, assessment };
    entry.contextSpan = { ...idea.contextSpan };
    if (!this.#spanKnown(entry, idea.contextSpan)) {
      entry.spans.push({ ...idea.contextSpan });
      if (entry.spans.length > this.#config.maxSpans) {
        entry.spans = entry.spans.slice(entry.spans.length - this.#config.maxSpans);
      }
    }
    entry.roundsSeen += 1;
    entry.missedRounds = 0;
    entry.updatedAtMs = nowMs;

    // A materially different pitch means the idea itself changed (or a fallback
    // match landed on evolving talk): the previous verification no longer
    // applies — require the skeptic pass again before it can (re)surface.
    if (pitchSimilarity(priorPitch, idea.pitch) < PITCH_MATCH_THRESHOLD) {
      entry.verified = false;
    }

    // Status with hysteresis: once ready, stay ready until confidence drops
    // readyHysteresis below the threshold. A STANCE block (intent drop, hard
    // gate, too-vague — anything other than a pure confidence dip) un-surfaces
    // immediately, beating hysteresis; a pure below-threshold dip does not.
    const stanceBlocked = assessment.blockedBy.some((b) => b !== "below-threshold");
    let ready: boolean;
    if (stanceBlocked) {
      ready = false;
    } else if (assessment.confidence >= this.#config.readyThreshold) {
      ready = true;
    } else {
      ready = wasReady && assessment.confidence >= this.#config.readyThreshold - this.#config.readyHysteresis;
    }

    // A vetoed idea stays held unless it came back materially stronger — then the
    // veto lifts and verification will rerun.
    if (entry.vetoReason !== null) {
      const vetoedAt = entry.vetoAtConfidence ?? 1;
      if (assessment.confidence >= vetoedAt + 0.15) {
        entry.vetoReason = null;
        entry.verified = false;
      } else {
        ready = false;
      }
    }
    entry.status = ready ? "ready" : "forming";

    // Maturity: baseline from the judgment, promoted to "elaborated" once the
    // idea persists (multiple rounds or evidence spans), ratcheting while the
    // stance holds — and collapsing the moment it doesn't.
    if (!ready) {
      entry.maturity = "forming";
    } else {
      let maturity = assessment.maturity;
      if ((entry.roundsSeen >= 2 || entry.spans.length >= 2) && MATURITY_ORDER[maturity] < MATURITY_ORDER.elaborated) {
        maturity = "elaborated";
      }
      if (MATURITY_ORDER[entry.maturity] > MATURITY_ORDER[maturity] && entry.maturity !== "forming") {
        maturity = entry.maturity; // ratchet while still surfaceable
      }
      entry.maturity = maturity;
    }
  }

  #spanKnown(entry: IdeaCandidate, span: ContextSpan): boolean {
    return entry.spans.some((s) => s.startTurnId === span.startTurnId && s.endTurnId === span.endTurnId);
  }

  #resolveMatch(
    idea: DetectedIdea,
    alreadyMatched: Set<string>,
    createdThisRound: Set<string>,
    turns: readonly TranscriptTurn[],
  ): IdeaCandidate | null {
    const excluded = (id: string): boolean => alreadyMatched.has(id) || createdThisRound.has(id);
    // 1) The judge echoed the tracked id.
    if (idea.matchId !== null) {
      const byId = this.#entries.find((e) => e.id === idea.matchId && !excluded(e.id));
      if (byId !== undefined) {
        return byId;
      }
    }
    // 2) Grounding spans overlap (same stretch of conversation).
    let best: { entry: IdeaCandidate; overlap: number } | null = null;
    for (const entry of this.#entries) {
      if (excluded(entry.id)) {
        continue;
      }
      const overlap = spanOverlap(entry.contextSpan, idea.contextSpan, turns);
      if (overlap > 0 && (best === null || overlap > best.overlap)) {
        best = { entry, overlap };
      }
    }
    if (best !== null) {
      return best.entry;
    }
    // 3) Pitch similarity — the SAME idea re-judged from a different stretch of
    // talk (e.g. a later retraction grounds only to the retraction turns, which
    // don't overlap the original span, and the judge forgot matchId). Without
    // this, a stance change would create a duplicate entry while the stale ready
    // one lives on.
    let bestPitch: { entry: IdeaCandidate; score: number } | null = null;
    for (const entry of this.#entries) {
      if (excluded(entry.id)) {
        continue;
      }
      const score = pitchSimilarity(entry.pitch, idea.pitch);
      if (score >= PITCH_MATCH_THRESHOLD && (bestPitch === null || score > bestPitch.score)) {
        bestPitch = { entry, score };
      }
    }
    return bestPitch?.entry ?? null;
  }
}

// Overlap coefficient over content words: |A∩B| / min(|A|,|B|). 1.0 for identical
// pitches; robust to one pitch being a longer rephrasing of the other.
export const PITCH_MATCH_THRESHOLD = 0.6;
const PITCH_STOPWORDS = new Set(["a", "an", "the", "for", "with", "and", "or", "of", "to", "in", "on", "that", "this", "it", "build", "make", "create", "app"]);

export function pitchSimilarity(a: string, b: string): number {
  const tokens = (s: string): Set<string> => {
    const words = s.toLowerCase().match(/[a-z0-9]+/gu) ?? [];
    return new Set(words.filter((w) => !PITCH_STOPWORDS.has(w)));
  };
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) {
    return 0;
  }
  let shared = 0;
  for (const w of ta) {
    if (tb.has(w)) {
      shared += 1;
    }
  }
  return shared / Math.min(ta.size, tb.size);
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
