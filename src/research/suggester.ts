// Research suggesters: the inference that watches the rolling transcript and
// proposes what the room should RESEARCH — claims to fact-check, topics for a
// sourced deep-dive, framings worth a bias scan. Mirrors the idea-detector
// selection pattern (src/detect/detector.ts): host-`claude` inference is the
// no-config default, the deterministic heuristic runs offline/CI, and tests
// inject fakes.

import { defaultClaudeCliRunner, type ClaudeCliRunner } from "../detect/claude-cli";
import type { TranscriptTurn } from "../detect/types";
import {
  researchSuggestionSchema,
  type ResearchSuggestInput,
  type ResearchSuggester,
  type ResearchSuggestion,
} from "./types";

export const DEFAULT_RESEARCH_SUGGESTER_MODEL = "sonnet";
export const DEFAULT_RESEARCH_SUGGESTER_TIMEOUT_MS = 20_000;
// At most this many fresh suggestions per round — the wall must stay glanceable.
const MAX_SUGGESTIONS_PER_ROUND = 3;

// ── host-claude suggester ───────────────────────────────────────────────────

export interface HostClaudeResearchSuggesterOptions {
  model?: string;
  timeoutMs?: number;
  runner?: ClaudeCliRunner;
}

export class HostClaudeResearchSuggester implements ResearchSuggester {
  readonly #model: string;
  readonly #timeoutMs: number;
  readonly #runner: ClaudeCliRunner;

  constructor(options: HostClaudeResearchSuggesterOptions = {}) {
    this.#model = options.model ?? DEFAULT_RESEARCH_SUGGESTER_MODEL;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_RESEARCH_SUGGESTER_TIMEOUT_MS;
    this.#runner = options.runner ?? defaultClaudeCliRunner;
  }

  async suggest(input: ResearchSuggestInput): Promise<ResearchSuggestion[]> {
    if (input.turns.length === 0) {
      return [];
    }
    const reply = await this.#runner(buildSuggestPrompt(input), {
      model: this.#model,
      timeoutMs: this.#timeoutMs,
    });
    return parseSuggestions(reply);
  }
}

export function buildSuggestPrompt(input: ResearchSuggestInput): string {
  const turns = input.turns.map((turn) => ({
    id: turn.id,
    speaker: turn.speaker ?? "unknown",
    text: turn.text,
  }));
  const known = input.known.map((quest) => ({ id: quest.id, kind: quest.kind, topic: quest.topic, claim: quest.claim }));
  return [
    "You watch a live room conversation and suggest what is worth RESEARCHING right now.",
    "Look for three things:",
    '- "fact-check": a specific factual claim someone stated (numbers, dates, events, "studies show…") that could be true or false;',
    '- "deep-dive": a substantive topic the room is circling that deserves sourced background;',
    '- "bias-scan": a one-sided framing or a claim whose usual sources are known to lean one way.',
    "Rules:",
    "- Suggest at most 3, only genuinely researchable material — never small talk, logistics, or opinions of taste.",
    "- If a suggestion refines something in knownQuests, set matchId to that quest's id; otherwise matchId is null.",
    "- Ground every suggestion: startTurnId/endTurnId are the inclusive turn-id range it came from, quote is a short verbatim quote from those turns.",
    "- confidence is YOUR judgement (0..1) that researching this would serve the room.",
    "Respond with ONLY a JSON array (no markdown fences, no prose), each element exactly:",
    '{"matchId": string|null, "kind": "fact-check"|"deep-dive"|"bias-scan", "topic": string (<=8 words), "claim": string (the precise claim/question to research), "rationale": string, "confidence": number, "contextSpan": {"startTurnId": string, "endTurnId": string, "quote": string}}',
    "An empty array [] is a valid (and common) answer.",
    "",
    `conversationTurns: ${JSON.stringify(turns)}`,
    `knownQuests: ${JSON.stringify(known)}`,
  ].join("\n");
}

// Parse model output that may be wrapped in prose/fences: take the outermost
// [ ... ] span, validate each element independently, drop anything malformed.
export function parseSuggestions(reply: string): ResearchSuggestion[] {
  const start = reply.indexOf("[");
  const end = reply.lastIndexOf("]");
  if (start === -1 || end <= start) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const suggestions: ResearchSuggestion[] = [];
  for (const element of parsed) {
    const result = researchSuggestionSchema.safeParse(element);
    if (result.success) {
      suggestions.push(result.data);
    }
    if (suggestions.length === MAX_SUGGESTIONS_PER_ROUND) {
      break;
    }
  }
  return suggestions;
}

// ── heuristic suggester (deterministic, no model) ───────────────────────────
// Offline/CI fallback emitting the same contract: claim-shaped turns (numbers,
// superlatives, reported speech) become fact-checks; question-shaped or long
// topical turns become deep-dives. Not smart — just honest enough to demo and
// test the full loop with zero network.

const REPORTED_SPEECH =
  /\b(i read|i heard|i saw|they say|apparently|according to|studies show|research shows|the study|statistics show|it's proven|its proven)\b/u;
const SUPERLATIVE =
  /\b(best|worst|most|least|biggest|smallest|fastest|slowest|first|last|only|never|always|every|all|none|no one|nobody)\b/u;
const NUMERIC = /\d/u;
const QUESTION =
  /\b(what if|what is|what are|how does|how do|how much|how many|how long|how often|why does|why do|why is|why are|i wonder|is it true|is it worth|would it|could we|should we)\b/u;
const MIN_CLAIM_WORDS = 6;
const MIN_TOPIC_WORDS = 12;

export class HeuristicResearchSuggester implements ResearchSuggester {
  async suggest(input: ResearchSuggestInput): Promise<ResearchSuggestion[]> {
    const knownClaims = new Set(input.known.map((quest) => normalizeText(quest.claim)));
    const suggestions: ResearchSuggestion[] = [];
    // Newest turns first — the freshest material is the most researchable.
    for (const turn of [...input.turns].reverse()) {
      if (suggestions.length === MAX_SUGGESTIONS_PER_ROUND) {
        break;
      }
      const suggestion = suggestFromTurn(turn);
      if (suggestion === null || knownClaims.has(normalizeText(suggestion.claim))) {
        continue;
      }
      knownClaims.add(normalizeText(suggestion.claim));
      suggestions.push(suggestion);
    }
    return suggestions;
  }
}

// Classify ONE turn into a research suggestion. Exported for the loop's
// direct spawn path (clicking a dialogue node on the wall researches it now).
export function suggestFromTurn(turn: TranscriptTurn): ResearchSuggestion | null {
  const text = turn.text.trim();
  const lower = text.toLowerCase();
  const words = lower.split(/\s+/u).filter((word) => word.length > 0);
  if (words.length < MIN_CLAIM_WORDS) {
    return null;
  }
  const signals = [REPORTED_SPEECH.test(lower), SUPERLATIVE.test(lower), NUMERIC.test(lower)].filter(Boolean).length;
  const span = { startTurnId: turn.id, endTurnId: turn.id, quote: text.slice(0, 180) };
  if (signals >= 1) {
    return {
      matchId: null,
      kind: "fact-check",
      topic: topicOf(text),
      claim: text.slice(0, 280),
      rationale: "Claim-shaped statement (numbers/superlatives/reported speech) worth verifying.",
      confidence: signals >= 2 ? 0.7 : 0.55,
      contextSpan: span,
    };
  }
  if (QUESTION.test(lower) || words.length >= MIN_TOPIC_WORDS) {
    return {
      matchId: null,
      kind: "deep-dive",
      topic: topicOf(text),
      claim: text.slice(0, 280),
      rationale: "Substantive topic the room is circling — sourced background would help.",
      confidence: 0.5,
      contextSpan: span,
    };
  }
  return null;
}

function topicOf(text: string): string {
  const words = text.trim().split(/\s+/u).slice(0, 8).join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

// ── selection ───────────────────────────────────────────────────────────────

export type ResearchSuggesterMode = "host-claude" | "heuristic";

export interface ResearchSuggesterSelection {
  mode: ResearchSuggesterMode;
  suggester: ResearchSuggester;
}

// Mirrors selectIdeaDetector: explicit VIBERSYN_RESEARCH_SUGGESTER wins,
// host-`claude` is the no-config default, "heuristic" runs offline/CI.
export function selectResearchSuggester(
  env: Record<string, string | undefined> = process.env,
  options: { runner?: ClaudeCliRunner } = {},
): ResearchSuggesterSelection {
  const explicit = env.VIBERSYN_RESEARCH_SUGGESTER?.trim().toLowerCase();
  if (explicit === "heuristic") {
    return { mode: "heuristic", suggester: new HeuristicResearchSuggester() };
  }
  return {
    mode: "host-claude",
    suggester: new HostClaudeResearchSuggester({
      model: env.VIBERSYN_RESEARCH_SUGGESTER_MODEL?.trim() || undefined,
      runner: options.runner,
    }),
  };
}
