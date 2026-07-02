// Pure eval scorers for the idea-detection loop. These are the deterministic
// quality checks behind the Smithers evals: the `.smithers/workflows/idea-detection.tsx`
// workflow wraps them with `createScorer(...)` (so scores land in the Smithers
// `_smithers_scorers` table on every live run), and `scorers.test.ts` exercises
// them directly over fixtures. Keeping the logic here (pure, dependency-free) lets
// BOTH the live workflow and CI grade detection output with identical rules.

// The normalized shape a scorer grades — the union of the runtime `DetectedIdea`
// (contextSpan.{startTurnId,endTurnId,quote}) and the workflow's flat output
// ({startTurnId,endTurnId,quote}). Callers normalize into this.
export interface ScorableIdea {
  pitch: string;
  confidence: number;
  startTurnId: string;
  endTurnId: string;
  quote: string;
}

export interface ScoreResult {
  score: number; // normalized 0..1
  reason: string;
  meta?: Record<string, unknown>;
}

const MAX_PITCH_WORDS = 14;

// Grounding accuracy: every detected idea must cite turn ids that actually exist in
// the window it was detected over, and carry a non-empty verbatim quote. An empty
// candidate set is vacuously grounded (score 1). Score = fraction fully grounded.
export function scoreGrounding(ideas: readonly ScorableIdea[], turnIds: ReadonlySet<string>): ScoreResult {
  if (ideas.length === 0) {
    return { score: 1, reason: "no candidates (vacuously grounded)", meta: { grounded: 0, total: 0 } };
  }
  let grounded = 0;
  for (const idea of ideas) {
    const startOk = turnIds.has(idea.startTurnId);
    const endOk = turnIds.has(idea.endTurnId);
    const quoteOk = idea.quote.trim().length > 0;
    if (startOk && endOk && quoteOk) {
      grounded += 1;
    }
  }
  return {
    score: grounded / ideas.length,
    reason: `${grounded}/${ideas.length} candidates cite real turns with a quote`,
    meta: { grounded, total: ideas.length },
  };
}

// Structural validity: each candidate has a non-empty pitch and a confidence in
// [0,1]. Empty candidate set is valid (score 1). Score = fraction well-formed.
export function scoreStructure(ideas: readonly ScorableIdea[]): ScoreResult {
  if (ideas.length === 0) {
    return { score: 1, reason: "no candidates (structurally valid)", meta: { valid: 0, total: 0 } };
  }
  let valid = 0;
  for (const idea of ideas) {
    const pitchOk = idea.pitch.trim().length > 0;
    const confOk = Number.isFinite(idea.confidence) && idea.confidence >= 0 && idea.confidence <= 1;
    if (pitchOk && confOk) {
      valid += 1;
    }
  }
  return {
    score: valid / ideas.length,
    reason: `${valid}/${ideas.length} candidates are well-formed (pitch + confidence)`,
    meta: { valid, total: ideas.length },
  };
}

// Pitch quality proxy (deterministic stand-in for the LLM judge, used in CI): a
// good pitch is a crisp <=14-word imperative — non-empty, within the word cap, and
// not apologetic/hedged. Empty candidate set scores 1.
const HEDGE = /\b(?:maybe|perhaps|sorry|apolog|i think|might|possibly|not sure)\b/iu;
export function scorePitchQuality(ideas: readonly ScorableIdea[]): ScoreResult {
  if (ideas.length === 0) {
    return { score: 1, reason: "no candidates", meta: { crisp: 0, total: 0 } };
  }
  let crisp = 0;
  for (const idea of ideas) {
    const words = idea.pitch.trim().split(/\s+/u).filter(Boolean);
    if (words.length > 0 && words.length <= MAX_PITCH_WORDS && !HEDGE.test(idea.pitch)) {
      crisp += 1;
    }
  }
  return {
    score: crisp / ideas.length,
    reason: `${crisp}/${ideas.length} pitches are crisp (<=${MAX_PITCH_WORDS} words, imperative)`,
    meta: { crisp, total: ideas.length },
  };
}

// Normalize the runtime detector's DetectedIdea (nested contextSpan) into a
// ScorableIdea. Accepts a loose shape so it works on both runtime candidates and
// parsed workflow output.
export function toScorableIdea(raw: unknown): ScorableIdea | null {
  if (raw === null || typeof raw !== "object") {
    return null;
  }
  const r = raw as Record<string, unknown>;
  const span = (r.contextSpan ?? {}) as Record<string, unknown>;
  const startTurnId = str(r.startTurnId ?? span.startTurnId);
  const endTurnId = str(r.endTurnId ?? span.endTurnId);
  const pitch = str(r.pitch);
  if (pitch.length === 0 || startTurnId.length === 0 || endTurnId.length === 0) {
    return null;
  }
  return {
    pitch,
    confidence: typeof r.confidence === "number" ? r.confidence : 0,
    startTurnId,
    endTurnId,
    quote: str(r.quote ?? span.quote),
  };
}

// Combined grade: the mean of the three deterministic scorers. Handy single number
// for a quick pass/fail eval or a regression gate.
export function scoreDetection(ideas: readonly ScorableIdea[], turnIds: ReadonlySet<string>): ScoreResult {
  const grounding = scoreGrounding(ideas, turnIds);
  const structure = scoreStructure(ideas);
  const quality = scorePitchQuality(ideas);
  const score = (grounding.score + structure.score + quality.score) / 3;
  return {
    score,
    reason: `grounding ${round2(grounding.score)}, structure ${round2(structure.score)}, pitch ${round2(quality.score)}`,
    meta: { grounding: grounding.score, structure: structure.score, pitchQuality: quality.score },
  };
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
