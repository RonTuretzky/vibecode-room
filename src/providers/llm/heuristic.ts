import { cueDecisionSchema, type CueDecision } from "../../types";
import type { DecisionInput, DecisionLLM, DecisionOutput } from "../types";

export const HEURISTIC_DECISION_POLICY = "heuristic-decision.v0";

// Imperative build/ship/prototype cues plus adjacent buildable-intent verbs.
// A clearly buildable utterance contains at least one of these; ambient speech
// (greetings, weather, status chatter) contains none.
const BUILDABLE_CUES: readonly string[] = [
  "build",
  "build out",
  "ship",
  "prototype",
  "scaffold",
  "implement",
  "deploy",
  "create",
  "spin up",
  "set up",
  "setup",
  "stand up",
  "refactor",
  "automate",
  "wire up",
  "integrate",
  "launch",
  "draft",
  "design",
  "generate",
];

// Nouns that name a buildable artifact. They never trigger on their own but
// raise confidence (and thus quality) when a build cue is also present.
const ARTIFACT_CUES: readonly string[] = [
  "tool",
  "service",
  "app",
  "feature",
  "dashboard",
  "api",
  "bot",
  "pipeline",
  "script",
  "system",
  "endpoint",
  "agent",
  "test",
  "fixture",
];

export interface HeuristicDecisionLLMOptions {
  policy?: string;
}

/**
 * No-key, deterministic DecisionLLM. It scores the transcript carried in the
 * DecisionInput messages against a fixed buildable-intent lexicon — no network,
 * no credentials, temperature 0 — and emits a spawn action for buildable
 * utterances or a pass for ambient speech. Replaces the always-pass demo stub.
 */
export class HeuristicDecisionLLM implements DecisionLLM {
  readonly #policy: string;

  constructor(options: HeuristicDecisionLLMOptions = {}) {
    this.#policy = options.policy ?? HEURISTIC_DECISION_POLICY;
  }

  async decide(input: DecisionInput): Promise<DecisionOutput> {
    if (input.temperature !== undefined && input.temperature !== 0) {
      throw new Error("HeuristicDecisionLLM only supports temperature 0.");
    }

    const transcript = extractTranscript(input);
    const decisionId = decisionIdFrom(input);
    const score = scoreTranscript(transcript);

    const decision: CueDecision = score.buildable
      ? {
          kind: "action",
          action: {
            type: "spawn",
            targetUPID: null,
            correlationId: input.correlationId,
            payload: {
              quality: score.quality,
              pitch: score.pitch,
              mcqs: score.mcqs,
              answers: score.answers,
            },
          },
          policy: this.#policy,
          decisionId,
          correlationId: input.correlationId,
          meta: { quality: score.quality, pitch: score.pitch, mcqs: score.mcqs },
        }
      : {
          kind: "pass",
          addressed: false,
          reason: "ambient",
          policy: this.#policy,
          decisionId,
          correlationId: input.correlationId,
          meta: { quality: score.quality },
        };

    return {
      id: `decision-${input.correlationId}`,
      model: input.model,
      temperature: 0,
      decision: cueDecisionSchema.parse(decision),
      raw: { heuristic: true, transcript, ...score },
    };
  }
}

interface HeuristicScore {
  buildable: boolean;
  quality: number;
  pitch: string;
  mcqs: string[];
  answers: string[];
}

function scoreTranscript(transcript: string): HeuristicScore {
  const haystack = ` ${transcript.toLowerCase()} `;
  const buildHits = BUILDABLE_CUES.filter((cue) => containsCue(haystack, cue)).length;
  const artifactHits = ARTIFACT_CUES.filter((cue) => containsCue(haystack, cue)).length;

  if (buildHits === 0) {
    return { buildable: false, quality: 0.1, pitch: "", mcqs: [], answers: [] };
  }

  // Deterministic confidence: a single build cue already clears the default 0.7
  // quality threshold; extra build/artifact cues nudge it toward the cap.
  const quality = clamp01(round2(0.78 + 0.05 * (buildHits - 1) + 0.03 * artifactHits));
  return {
    buildable: true,
    quality,
    pitch: pitchFrom(transcript),
    mcqs: ["Scope it as one task?", "Spawn an agent now?"],
    answers: ["Yes, scope it", "Yes, spawn it"],
  };
}

function containsCue(haystack: string, cue: string): boolean {
  if (cue.includes(" ")) {
    return haystack.includes(` ${cue} `);
  }
  return new RegExp(`(?<![\\p{L}\\p{N}])${cue}(?![\\p{L}\\p{N}])`, "u").test(haystack);
}

function extractTranscript(input: DecisionInput): string {
  const parts: string[] = [];
  for (const message of input.messages) {
    if (message.role !== "user") {
      continue;
    }
    parts.push(transcriptFromContent(message.content));
  }
  return parts.join(" ").replace(/\s+/gu, " ").trim();
}

function transcriptFromContent(content: string): string {
  try {
    const parsed: unknown = JSON.parse(content);
    if (isRecord(parsed) && typeof parsed.transcript === "string") {
      return parsed.transcript;
    }
  } catch {
    // Plain-text content — fall through to the raw string.
  }
  return content;
}

function pitchFrom(transcript: string): string {
  const words = transcript.trim().split(/\s+/u).filter(Boolean).slice(0, 12);
  if (words.length === 0) {
    return "Scope this into a buildable task";
  }
  const pitch = words.join(" ");
  return pitch.charAt(0).toUpperCase() + pitch.slice(1);
}

function decisionIdFrom(input: DecisionInput): string {
  const fromMeta = input.metadata?.decisionId;
  if (typeof fromMeta === "string" && fromMeta.trim().length > 0) {
    return fromMeta;
  }
  return `decision-${input.correlationId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
