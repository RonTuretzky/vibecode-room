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
export const detectedIdeaSchema = z
  .object({
    matchId: z.string().min(1).nullable().default(null),
    pitch: z.string().min(1),
    confidence: z.number().min(0).max(1),
    questions: z.array(z.string()).default([]),
    answers: z.array(z.string()).default([]),
    contextSpan: contextSpanSchema,
    rationale: z.string().default(""),
  })
  .strict();
export type DetectedIdea = z.infer<typeof detectedIdeaSchema>;

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

// The inference contract. One call judges a whole window and returns every
// buildable idea it finds, each grounded to a context span. Implementations:
// HostClaudeIdeaDetector (real `claude` CLI inference), HeuristicIdeaDetector
// (deterministic, no model), and test fakes.
export interface IdeaDetector {
  detect(input: DetectionInput): Promise<DetectionResult>;
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
  contextSpan: ContextSpan;
  rationale: string;
  status: IdeaCandidateStatus;
  firstSeenAtMs: number;
  updatedAtMs: number;
  // Consecutive detection rounds in which this candidate was NOT re-detected.
  // Drives stale-supersede so a momentary idea doesn't linger forever.
  missedRounds: number;
}
