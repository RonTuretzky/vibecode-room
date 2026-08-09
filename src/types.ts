import { z } from "zod";

export const cuePassReasons = ["ambient", "near-miss", "low-confidence", "dropped"] as const;
export const dispatchedActionTypes = ["spawn", "steer", "pause", "resume", "halt", "pauseAll", "status"] as const;
export const runEventKinds = ["state", "output", "blocker", "completed"] as const;
export const logLevels = ["debug", "info", "warn", "error"] as const;
export const earconIds = ["E1", "E2", "E3", "E4", "E5", "mute-tone"] as const;
export const ackIds = ["route-suggestion", "route-steer", "route-declined", "working"] as const;
export const muteReleaseTriggers = ["unmute-word", "unmute-button"] as const;

export const decisionMetaSchema = z.record(z.string(), z.unknown());
export type DecisionMeta = z.infer<typeof decisionMetaSchema>;

export const transcriptObservationSchema = z
  .object({
    text: z.string(),
    isFinal: z.boolean(),
    speaker: z.string().nullable(),
    sessionId: z.string().min(1),
    latencyMs: z.number().nonnegative(),
    utteranceId: z.string().min(1),
  })
  .strict();
export type TranscriptObservation = z.infer<typeof transcriptObservationSchema>;

export const dispatchedActionSchema = z
  .object({
    type: z.enum(dispatchedActionTypes),
    targetUPID: z.string().min(1).nullable(),
    payload: z.unknown(),
    correlationId: z.string().min(1),
  })
  .strict();
export type DispatchedAction = z.infer<typeof dispatchedActionSchema>;

export const cueDecisionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("pass"),
      addressed: z.boolean(),
      reason: z.enum(cuePassReasons),
      policy: z.string().min(1),
      decisionId: z.string().min(1),
      correlationId: z.string().min(1),
      meta: decisionMetaSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("action"),
      action: dispatchedActionSchema,
      policy: z.string().min(1),
      decisionId: z.string().min(1),
      correlationId: z.string().min(1),
      meta: decisionMetaSchema,
    })
    .strict(),
]);
export type CueDecision = z.infer<typeof cueDecisionSchema>;

export const credentialSourceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("host-subscription"),
      provider: z.enum(["openai-codex", "anthropic-claude"]),
      command: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("environment"),
      provider: z.enum(["deepgram", "tts"]),
      variable: z.string().min(1),
      redacted: z.literal(true),
    })
    .strict(),
]);
export type CredentialSource = z.infer<typeof credentialSourceSchema>;

// ── idea brief ──────────────────────────────────────────────────────────────
// The full context an accepted idea carries into the build pipeline: the pitch,
// the VERBATIM room speech it was grounded in (contextSpan.quote), the judge's
// rationale, and the deck-ready decision Q&A. Constructed ONCE at acceptance
// (src/server/idea-suggestion.ts) and threaded — as an optional field — through
// the spawn seed, the registry, the kickoff orchestrator, every backend prompt,
// the pitch deck, and the commission workflow. This is the canonical zod; the
// buildloop and slideshow tracks carry structural mirrors (no cross-track
// imports, per house convention).
export const ideaBriefQaSchema = z
  .object({
    id: z.string().min(1),
    prompt: z.string().min(1),
    answers: z.array(z.string()),
    // Set once the room has answered (deck swipe / spoken answer).
    chosen: z.string().optional(),
  })
  .strict();
export type IdeaBriefQa = z.infer<typeof ideaBriefQaSchema>;

// Prompt-growth clamps (constructors clamp BEFORE parse; the schema enforces).
export const IDEA_BRIEF_QUOTE_MAX_CHARS = 300;
export const IDEA_BRIEF_RATIONALE_MAX_CHARS = 200;

export const ideaBriefSchema = z
  .object({
    pitch: z.string().min(1),
    // Verbatim room speech the idea is grounded in, clamped at construction so
    // backend prompts never flood.
    sourceQuote: z.string().max(IDEA_BRIEF_QUOTE_MAX_CHARS),
    rationale: z.string().max(IDEA_BRIEF_RATIONALE_MAX_CHARS),
    qa: z.array(ideaBriefQaSchema),
    // Null until a spawn assigns the spoken handle.
    callsign: z.string().nullable(),
    maturity: z.enum(["forming", "proposed", "elaborated", "actionable"]).optional(),
  })
  .strict();
export type IdeaBrief = z.infer<typeof ideaBriefSchema>;

export const pendingSuggestionSchema = z
  .object({
    suggestionId: z.string().min(1),
    pitch: z.string().min(1),
    mcqs: z.array(z.string()),
    answers: z.array(z.string()),
    correlationId: z.string().min(1),
    expiresAt: z.number().finite(),
    // The idea's context brief (provenance quote, rationale, deck Q&A).
    // OPTIONAL: engine-synthesized and legacy suggestions carry none. It MUST
    // be declared here because this schema is .strict() — an undeclared brief
    // would fail every re-parse on the acceptance path (pending.ts) and the
    // context would die at acceptance exactly like before.
    brief: ideaBriefSchema.optional(),
  })
  .strict();
export type PendingSuggestion = z.infer<typeof pendingSuggestionSchema>;

export const runEventSchema = z
  .object({
    upid: z.string().min(1),
    runId: z.string().min(1),
    kind: z.enum(runEventKinds),
    text: z.string(),
    seq: z.number().int().nonnegative(),
  })
  .strict();
export type RunEvent = z.infer<typeof runEventSchema>;

export const logEventSchema = z
  .object({
    level: z.enum(logLevels),
    event: z.string().min(1).regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/u),
    sessionId: z.string().min(1),
    correlationId: z.string().min(1).optional(),
    upid: z.string().min(1).optional(),
    latencyMs: z.number().nonnegative().optional(),
    meta: z.record(z.string(), z.unknown()),
  })
  .strict()
  .superRefine((event, ctx) => {
    if (isLoopEventName(event.event) && event.correlationId === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["correlationId"],
        message: "Loop events must carry correlationId for causal-chain joins.",
      });
    }
  });
export type LogEvent = z.infer<typeof logEventSchema>;

export const earconIdSchema = z.enum(earconIds);
export type EarconId = z.infer<typeof earconIdSchema>;

export const ackIdSchema = z.enum(ackIds);
export type AckId = z.infer<typeof ackIdSchema>;

export const muteReleaseTriggerSchema = z.enum(muteReleaseTriggers);
export type MuteReleaseTrigger = z.infer<typeof muteReleaseTriggerSchema>;

export const outputDecisionSchema = z.discriminatedUnion("channel", [
  z.object({ channel: z.literal("silent") }).strict(),
  z.object({ channel: z.literal("earcon"), id: earconIdSchema }).strict(),
  z.object({ channel: z.literal("ack"), id: ackIdSchema }).strict(),
  z
    .object({
      channel: z.literal("tts"),
      text: z.string(),
      wordCount: z.number().int().nonnegative(),
      summarized: z.boolean(),
    })
    .strict(),
]);
export type OutputDecision = z.infer<typeof outputDecisionSchema>;

export function isLoopEventName(event: string): boolean {
  return /^(ack|command|earcon|mute|observe|output|process|route|safety)\./u.test(event);
}
