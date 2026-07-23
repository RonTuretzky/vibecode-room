import { z } from "zod";
import { contextSpanSchema, type ContextSpan, type TranscriptTurn } from "../detect/types";

// ── RESEARCH MODE domain ────────────────────────────────────────────────────
// A parallel loop to idea detection: instead of watching the conversation for
// BUILDABLE ideas, the research suggester watches it for RESEARCHABLE material
// — claims worth fact-checking, topics worth a sourced deep-dive, framings
// worth a bias scan. Each suggestion is grounded to the span of talk it came
// from (same ContextSpan contract as idea detection), surfaces on the wall as
// a proposed "quest", and only an explicit accept (click / dwell / voice
// "vibersyn research it") spawns the research agent. Results are a structured
// report — findings with verdicts, bias notes, sources — rendered as a
// self-contained HTML slideshow with a scannable QR code per source.

export const researchKinds = ["fact-check", "deep-dive", "bias-scan"] as const;
export type ResearchKind = (typeof researchKinds)[number];

// ── suggester output (pre-reconciliation) ───────────────────────────────────
// What a ResearchSuggester returns for one researchable thing found in the
// window. `matchId` names a known quest it is UPDATING (the room kept talking
// about the same claim), null for a fresh suggestion — mirrors DetectedIdea.
export const researchSuggestionSchema = z
  .object({
    matchId: z.string().min(1).nullable().default(null),
    kind: z.enum(researchKinds),
    // Short label for the wall node, e.g. "EU AI Act timeline".
    topic: z.string().min(1),
    // The specific claim/question the agent will research, e.g. "The EU AI Act
    // bans all facial recognition starting 2026 — is that true?"
    claim: z.string().min(1),
    rationale: z.string().default(""),
    confidence: z.number().min(0).max(1),
    contextSpan: contextSpanSchema,
  })
  .strict();
export type ResearchSuggestion = z.infer<typeof researchSuggestionSchema>;

// ── report (the agent's product) ────────────────────────────────────────────

export const researchVerdicts = ["supported", "refuted", "mixed", "unverified"] as const;
export type ResearchVerdict = (typeof researchVerdicts)[number];

export const researchSourceSchema = z
  .object({
    title: z.string().min(1),
    url: z.string().min(1),
    publisher: z.string().default(""),
    // One line on what this source says / how much to trust it.
    note: z.string().default(""),
  })
  .strict();
export type ResearchSource = z.infer<typeof researchSourceSchema>;

export const researchFindingSchema = z
  .object({
    claim: z.string().min(1),
    verdict: z.enum(researchVerdicts),
    explanation: z.string().default(""),
    // Indexes into the report's sources[] backing this finding.
    sourceIndexes: z.array(z.number().int().nonnegative()).default([]),
  })
  .strict();
export type ResearchFinding = z.infer<typeof researchFindingSchema>;

export const biasSeverities = ["low", "medium", "high"] as const;
export const researchBiasNoteSchema = z
  .object({
    note: z.string().min(1),
    severity: z.enum(biasSeverities).default("medium"),
  })
  .strict();
export type ResearchBiasNote = z.infer<typeof researchBiasNoteSchema>;

export const researchReportSchema = z
  .object({
    summary: z.string().min(1),
    confidence: z.enum(["low", "medium", "high"]).default("medium"),
    findings: z.array(researchFindingSchema).default([]),
    biasNotes: z.array(researchBiasNoteSchema).default([]),
    sources: z.array(researchSourceSchema).default([]),
    followUps: z.array(z.string()).default([]),
  })
  .strict();
export type ResearchReport = z.infer<typeof researchReportSchema>;

// ── ledger-side quest ───────────────────────────────────────────────────────
// "proposed"    — surfaced on the wall, waiting for an explicit accept.
// "researching" — the agent is running (progress/progressLabel are live).
// "complete"    — report landed; the deck is available.
// "failed"      — the agent errored or was cancelled/stopped.
export type ResearchQuestStatus = "proposed" | "researching" | "complete" | "failed";

export interface ResearchQuest {
  id: string;
  kind: ResearchKind;
  topic: string;
  claim: string;
  rationale: string;
  confidence: number;
  contextSpan: ContextSpan;
  status: ResearchQuestStatus;
  // Live agent progress while researching (0–100 + a human stage label).
  progress: number;
  progressLabel: string;
  report: ResearchReport | null;
  error: string | null;
  roundsSeen: number;
  // Consecutive suggestion rounds a PROPOSED quest was not re-suggested in;
  // drives stale pruning so a passing remark doesn't linger on the wall.
  missedRounds: number;
  firstSeenAtMs: number;
  updatedAtMs: number;
}

// ── suggester contract ──────────────────────────────────────────────────────

// A compact view of an in-flight quest handed to the suggester so it can
// reconcile (UPDATE vs NEW) instead of re-proposing the same research.
export interface KnownQuest {
  id: string;
  kind: ResearchKind;
  topic: string;
  claim: string;
}

export interface ResearchSuggestInput {
  sessionId: string;
  correlationId: string;
  // The rolling window of turns (chronological) — same shape idea detection uses.
  turns: TranscriptTurn[];
  known: KnownQuest[];
}

export interface ResearchSuggester {
  suggest(input: ResearchSuggestInput): Promise<ResearchSuggestion[]>;
}

// ── agent contract ──────────────────────────────────────────────────────────

export interface ResearchProgress {
  percent: number;
  label: string;
}

export interface ResearchAgentOptions {
  correlationId: string;
  onProgress?: (progress: ResearchProgress) => void;
  // Cooperative cancellation: implementations must check between stages and
  // throw (any error) once aborted — the loop maps it to a failed quest.
  signal?: AbortSignal;
}

export interface ResearchAgent {
  research(quest: ResearchQuest, options: ResearchAgentOptions): Promise<ResearchReport>;
}
