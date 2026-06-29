import { type ClaudeCliRunner, defaultClaudeCliRunner } from "./claude-cli";
import { renderTurns } from "./transcript-window";
import type {
  ContextSpan,
  DetectedIdea,
  DetectionInput,
  DetectionResult,
  IdeaDetector,
  TranscriptTurn,
} from "./types";

export const DEFAULT_IDEA_DETECTOR_MODEL = "sonnet";
export const DEFAULT_IDEA_DETECTOR_TIMEOUT_MS = 20_000;
const MAX_PITCH_WORDS = 14;
const MAX_QUESTIONS = 3;

// ── prompt (pure, shared by the local runner AND the Smithers workflow) ───────
// The model reads a numbered transcript (turns labelled with stable ids) plus the
// ideas already on screen, and returns, for every genuinely buildable idea, a
// pitch + confidence + clarifying questions AND the turn-id span / quote it is
// grounded in. matchId lets it UPDATE an existing idea instead of duplicating it.
export function buildDetectionPrompt(input: DetectionInput): string {
  const transcript = renderTurns(input.turns);
  const known =
    input.known.length === 0
      ? "(none yet)"
      : input.known
          .map((k) => `- id=${k.id} pitch=${JSON.stringify(k.pitch)} span=${k.contextSpan.startTurnId}..${k.contextSpan.endTurnId}`)
          .join("\n");
  return [
    "You are the idea detector for an ambient room assistant. People are talking; some of what they say is a concrete, BUILDABLE software/automation idea, most is not.",
    "Using genuine judgement about MEANING and INTENT (never keyword matching), find every distinct buildable idea expressed in the transcript below — even when phrased implicitly ('we could wrap those into one thing').",
    "For EACH buildable idea, ground it: cite the exact range of turn ids (startTurn..endTurn) that express it and quote the verbatim evidence. An idea may span several turns.",
    "Ignore ambient chatter, logistics, personal talk, status updates, and vague musing — return them as nothing.",
    "",
    "Already-surfaced ideas (reuse a matchId to UPDATE one as the conversation elaborates it; otherwise matchId=null for a new idea):",
    known,
    "",
    "Transcript (each line is [turn-id] speaker: text):",
    transcript,
    "",
    "Reply with ONLY a JSON object, no prose, no code fences:",
    '{"ideas":[{"matchId": string|null, "pitch": "<=14 word imperative pitch", "confidence": number 0..1, "questions": ["<=3 short aloud-answerable questions"], "answers": ["<=3 short option labels"], "startTurn": "turn-id", "endTurn": "turn-id", "quote": "verbatim evidence", "rationale": "one short line"}]}',
    "If there is no buildable idea, reply exactly: {\"ideas\":[]}",
  ].join("\n");
}

// ── parser (pure, tolerant) ───────────────────────────────────────────────────
// Accepts a bare JSON object or one embedded in prose/fences; validates and
// grounds each idea against the turns actually shown to the model. Any malformed
// idea is dropped, never thrown — a bad reply degrades to fewer/zero ideas.
export function parseDetectionReply(reply: string, input: DetectionInput): DetectionResult {
  const obj = extractJsonObject(reply);
  if (obj === null) {
    return { candidates: [], raw: { reply } };
  }
  const rawIdeas = Array.isArray((obj as Record<string, unknown>).ideas)
    ? ((obj as Record<string, unknown>).ideas as unknown[])
    : [];
  const turnIds = new Set(input.turns.map((t) => t.id));
  const firstId = input.turns[0]?.id;
  const lastId = input.turns.at(-1)?.id;
  const candidates: DetectedIdea[] = [];
  for (const entry of rawIdeas) {
    const idea = coerceIdea(entry, input.turns, turnIds, firstId, lastId);
    if (idea !== null) {
      candidates.push(idea);
    }
  }
  return { candidates, raw: obj };
}

function coerceIdea(
  entry: unknown,
  turns: readonly TranscriptTurn[],
  turnIds: Set<string>,
  firstId: string | undefined,
  lastId: string | undefined,
): DetectedIdea | null {
  if (!isRecord(entry)) {
    return null;
  }
  const pitch = clampWords(asString(entry.pitch), MAX_PITCH_WORDS);
  if (pitch.length === 0 || firstId === undefined || lastId === undefined) {
    return null;
  }
  const confidence = clamp01(typeof entry.confidence === "number" ? entry.confidence : 0.6);
  // Resolve the cited span against the turns the model actually saw; fall back to
  // the window bounds when the model cites an id we don't have.
  const startTurnId = turnIds.has(asString(entry.startTurn)) ? asString(entry.startTurn) : firstId;
  const endTurnId = turnIds.has(asString(entry.endTurn)) ? asString(entry.endTurn) : lastId;
  const span: ContextSpan = {
    startTurnId,
    endTurnId,
    quote: groundQuote(turns, startTurnId, endTurnId) ?? asString(entry.quote),
  };
  const matchId = typeof entry.matchId === "string" && entry.matchId.trim().length > 0 ? entry.matchId.trim() : null;
  return {
    matchId,
    pitch,
    confidence,
    questions: stringArray(entry.questions).slice(0, MAX_QUESTIONS),
    answers: stringArray(entry.answers).slice(0, MAX_QUESTIONS),
    contextSpan: span,
    rationale: asString(entry.rationale),
  };
}

// Real inference over a transcript window via the host `claude` CLI. Fail-soft:
// any spawn/timeout/parse failure yields zero candidates so a bad call never
// wedges detection. Stateless — the engine owns cadence/throttling.
export interface HostClaudeIdeaDetectorOptions {
  model?: string;
  timeoutMs?: number;
  runner?: ClaudeCliRunner;
}

export class HostClaudeIdeaDetector implements IdeaDetector {
  readonly #model: string;
  readonly #timeoutMs: number;
  readonly #runner: ClaudeCliRunner;

  constructor(options: HostClaudeIdeaDetectorOptions = {}) {
    this.#model = options.model ?? DEFAULT_IDEA_DETECTOR_MODEL;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_IDEA_DETECTOR_TIMEOUT_MS;
    this.#runner = options.runner ?? defaultClaudeCliRunner;
  }

  async detect(input: DetectionInput): Promise<DetectionResult> {
    if (input.turns.length === 0) {
      return { candidates: [] };
    }
    try {
      const reply = await this.#runner(buildDetectionPrompt(input), {
        model: this.#model,
        timeoutMs: this.#timeoutMs,
      });
      return parseDetectionReply(reply, input);
    } catch (error) {
      return { candidates: [], raw: { error: error instanceof Error ? error.message : String(error) } };
    }
  }
}

// ── deterministic fallback ────────────────────────────────────────────────────
// No-model detector: keyword/intent heuristic for environments without `claude`
// (CI, replay, offline tests). NOT the primary path — it exists so detection
// degrades to *something* grounded rather than nothing. One candidate per
// contiguous run of buildable-cue turns, grounded to those turns.
const BUILDABLE_CUES = [
  "build",
  "make",
  "create",
  "app",
  "tool",
  "automate",
  "automation",
  "dashboard",
  "bot",
  "website",
  "platform",
  "prototype",
  "feature",
  "integrate",
  "wrap",
  "cooperative",
  "network",
  "marketplace",
] as const;

export class HeuristicIdeaDetector implements IdeaDetector {
  async detect(input: DetectionInput): Promise<DetectionResult> {
    return this.detectSync(input);
  }

  detectSync(input: DetectionInput): DetectionResult {
    const cueTurns = input.turns.filter((turn) => hasBuildableCue(turn.text));
    if (cueTurns.length === 0) {
      return { candidates: [] };
    }
    const start = cueTurns[0];
    const end = cueTurns.at(-1) ?? start;
    const quote = groundQuote(input.turns, start.id, end.id) ?? cueTurns.map((t) => t.text).join(" ");
    const hits = cueTurns.reduce((sum, turn) => sum + countCues(turn.text), 0);
    const confidence = clamp01(0.55 + 0.08 * (hits - 1));
    const matchId =
      input.known.find((k) => spansOverlap(k.contextSpan, start.id, end.id, input.turns))?.id ?? null;
    const candidate: DetectedIdea = {
      matchId,
      pitch: clampWords(start.text, MAX_PITCH_WORDS),
      confidence,
      questions: ["Scope it as one task?", "Spawn an agent now?"],
      answers: ["Yes, scope it", "Yes, spawn it"],
      contextSpan: { startTurnId: start.id, endTurnId: end.id, quote },
      rationale: "heuristic: buildable cue detected",
    };
    return { candidates: [candidate] };
  }
}

export type IdeaDetectorMode = "host-claude" | "heuristic";

export interface IdeaDetectorSelectionEnv {
  VIBERSYN_IDEA_DETECTOR?: string;
  VIBERSYN_IDEA_DETECTOR_MODEL?: string;
  [key: string]: string | undefined;
}

export interface IdeaDetectorSelection {
  mode: IdeaDetectorMode;
  detector: IdeaDetector;
}

export interface SelectIdeaDetectorOptions {
  runner?: ClaudeCliRunner;
}

// Mirrors selectDecisionLLM: explicit VIBERSYN_IDEA_DETECTOR wins; otherwise default
// to real host-`claude` inference (no key required). Force the deterministic
// detector with VIBERSYN_IDEA_DETECTOR=heuristic (CI/offline).
export function selectIdeaDetector(
  env: IdeaDetectorSelectionEnv = process.env,
  options: SelectIdeaDetectorOptions = {},
): IdeaDetectorSelection {
  const requested = env.VIBERSYN_IDEA_DETECTOR?.trim().toLowerCase();
  if (requested === "heuristic") {
    return { mode: "heuristic", detector: new HeuristicIdeaDetector() };
  }
  if (requested !== undefined && requested !== "" && requested !== "host-claude") {
    throw new Error(`Unknown VIBERSYN_IDEA_DETECTOR mode: ${requested}`);
  }
  return {
    mode: "host-claude",
    detector: new HostClaudeIdeaDetector({ model: env.VIBERSYN_IDEA_DETECTOR_MODEL, runner: options.runner }),
  };
}

// ── shared helpers ────────────────────────────────────────────────────────────
function groundQuote(turns: readonly TranscriptTurn[], startId: string, endId: string): string | null {
  const startIndex = turns.findIndex((t) => t.id === startId);
  const endIndex = turns.findIndex((t) => t.id === endId);
  if (startIndex === -1 || endIndex === -1) {
    return null;
  }
  const [lo, hi] = startIndex <= endIndex ? [startIndex, endIndex] : [endIndex, startIndex];
  return turns
    .slice(lo, hi + 1)
    .map((t) => t.text)
    .join(" ");
}

function spansOverlap(
  span: ContextSpan,
  startId: string,
  endId: string,
  turns: readonly TranscriptTurn[],
): boolean {
  const index = (id: string): number => turns.findIndex((t) => t.id === id);
  const a0 = index(span.startTurnId);
  const a1 = index(span.endTurnId);
  const b0 = index(startId);
  const b1 = index(endId);
  if ([a0, a1, b0, b1].some((i) => i === -1)) {
    return false;
  }
  return Math.max(a0, b0) <= Math.min(a1, b1);
}

function hasBuildableCue(text: string): boolean {
  return countCues(text) > 0;
}

function countCues(text: string): number {
  const words = text.toLowerCase().match(/[a-z0-9']+/gu) ?? [];
  const set = new Set(words);
  return BUILDABLE_CUES.reduce((sum, cue) => sum + (set.has(cue) ? 1 : 0), 0);
}

function extractJsonObject(reply: string): Record<string, unknown> | null {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(reply.slice(start, end + 1));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim())
    : [];
}

function clampWords(text: string, max: number): string {
  return text.trim().split(/\s+/u).filter(Boolean).slice(0, max).join(" ");
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
