import { z } from "zod";

// ── transcript turns ────────────────────────────────────────────────────────
// A single committed (FINAL) unit of room speech, with a STABLE id so a detected
// idea can point back at the exact span of conversation it came from. Unlike the
// old TranscriptObservation (one ASR final, scored in isolation), turns are kept
// in a rolling window and fed to inference together, so an idea that forms across
// several turns is judged as one arc — and grounded to the turns that justify it.
export const transcriptTurnSchema = z
  .object({
    id: z.string().min(1),
    speaker: z.string().nullable(),
    text: z.string().min(1),
    atMs: z.number().finite(),
  })
  .strict();
export type TranscriptTurn = z.infer<typeof transcriptTurnSchema>;

// ── provenance ──────────────────────────────────────────────────────────────
// WHICH part of the conversation a detected idea is grounded in: an inclusive
// turn-id range plus the verbatim evidence the model quoted. This is the whole
// point of the refactor — an idea is never a context-free 12-word blurb; it
// carries the span of talk that produced it.
export const contextSpanSchema = z
  .object({
    startTurnId: z.string().min(1),
    endTurnId: z.string().min(1),
    quote: z.string(),
  })
  .strict();
export type ContextSpan = z.infer<typeof contextSpanSchema>;

// ── detector output (pre-reconciliation) ────────────────────────────────────
// What an IdeaDetector returns for one buildable idea found in a window. The
// model may set `matchId` to the id of a known candidate it is UPDATING (an idea
// that was raised earlier and just got elaborated), or leave it null for a fresh
// idea. confidence is the model's own judgement, 0..1 — it REPLACES the word/time
// floor and the hand-tuned quality/cadence math entirely.
// The structured judgment behind the idea (see rubric.ts). Real detectors always
// attach it; test fakes may omit it, in which case the ledger derives a neutral
// pseudo-judgment from the bare confidence.
export const ideaRubricSchema = z
  .object({
    category: z.enum(["proposal", "existing-product", "hypothetical", "logistics", "recap", "chatter"]),
    concreteness: z.number().min(0).max(3),
    buildableAsSoftware: z.number().min(0).max(3),
    intent: z.number().min(0).max(3),
    novelty: z.number().min(0).max(3),
  })
  .strict();

export const ideaAssessmentSchema = z
  .object({
    confidence: z.number().min(0).max(1),
    surfaceable: z.boolean(),
    maturity: z.enum(["forming", "proposed", "elaborated", "actionable"]),
    blockedBy: z.array(z.string()).default([]),
  })
  .strict();

export const detectedIdeaSchema = z
  .object({
    matchId: z.string().min(1).nullable().default(null),
    pitch: z.string().min(1),
    confidence: z.number().min(0).max(1),
    questions: z.array(z.string()).default([]),
    answers: z.array(z.string()).default([]),
    contextSpan: contextSpanSchema,
    rationale: z.string().default(""),
    judgment: z.object({ rubric: ideaRubricSchema, assessment: ideaAssessmentSchema }).strict().optional(),
  })
  .strict();
export type DetectedIdea = z.infer<typeof detectedIdeaSchema>;
// An idea from a real rubric judge — the judgment is always present.
export type JudgedIdea = DetectedIdea & { judgment: NonNullable<DetectedIdea["judgment"]> };

export const detectionResultSchema = z
  .object({
    candidates: z.array(detectedIdeaSchema).default([]),
  })
  .strict();
export type DetectionResult = z.infer<typeof detectionResultSchema> & { raw?: unknown };

// A compact view of an in-flight candidate handed to the detector so it can
// reconcile (decide UPDATE vs NEW) instead of re-proposing the same idea.
export interface KnownCandidate {
  id: string;
  pitch: string;
  contextSpan: ContextSpan;
}

export interface DetectionInput {
  sessionId: string;
  correlationId: string;
  // The rolling window of turns inference runs over (chronological).
  turns: TranscriptTurn[];
  // Candidates already surfaced, so the model can update rather than duplicate.
  known: KnownCandidate[];
}

// A skeptic's verdict on a candidate about to surface (adversarial second pass).
export interface CandidateVerdict {
  uphold: boolean;
  reason: string;
}

// The minimal shape verification needs — satisfied by both DetectedIdea and the
// ledger's IdeaCandidate.
export interface VerifiableIdea {
  pitch: string;
  contextSpan: ContextSpan;
  judgment?: DetectedIdea["judgment"];
}

// The inference contract. One call judges a whole window and returns every
// idea-shaped span it finds, each grounded to a context span and (for real
// detectors) carrying its rubric judgment. Implementations: HostClaudeIdeaJudge
// (real `claude` CLI inference), HeuristicIdeaDetector (deterministic, no
// model), and test fakes.
//
// `verify` is the optional adversarial pass: the engine calls it exactly once
// when a candidate first crosses the surface threshold; a rejection vetoes the
// bubble. Detectors without it (heuristic, test fakes) surface unverified.
export interface IdeaDetector {
  detect(input: DetectionInput): Promise<DetectionResult>;
  verify?(idea: VerifiableIdea, input: DetectionInput): Promise<CandidateVerdict>;
}

// ── engine-side candidate ───────────────────────────────────────────────────
// "forming"   — seen, but below the surface threshold; held silently.
// "ready"     — confident enough to show as an idea bubble / be built.
// "superseded"— dropped: rebuilt into another candidate, or gone stale.
export type IdeaCandidateStatus = "forming" | "ready" | "superseded";

export interface IdeaCandidate {
  id: string;
  pitch: string;
  confidence: number;
  questions: string[];
  answers: string[];
  // The most recent grounding span; `spans` accumulates every span that has
  // supported this idea across rounds (evidence trail, capped).
  contextSpan: ContextSpan;
  spans: ContextSpan[];
  rationale: string;
  status: IdeaCandidateStatus;
  // Idea lifecycle from the rubric + history: forming → proposed → elaborated →
  // actionable. Ratchets up with re-detection; only decays with staleness.
  maturity: "forming" | "proposed" | "elaborated" | "actionable";
  // The latest structured judgment (absent only for judgment-less test fakes).
  judgment?: { rubric: z.infer<typeof ideaRubricSchema>; assessment: z.infer<typeof ideaAssessmentSchema> };
  // Adversarial verification state: unverified → verified | vetoed(reason).
  verified: boolean;
  vetoReason: string | null;
  // Confidence at the moment of the veto; the veto lifts (and verification
  // reruns) only if the idea returns materially stronger than this.
  vetoAtConfidence?: number;
  // Rounds this idea has been re-detected in (evidence of persistence).
  roundsSeen: number;
  firstSeenAtMs: number;
  updatedAtMs: number;
  // Consecutive detection rounds in which this candidate was NOT re-detected.
  // Drives stale-supersede so a momentary idea doesn't linger forever.
  missedRounds: number;
}
