import { type ClaudeCliRunner, defaultClaudeCliRunner } from "./claude-cli";
import { buildJudgePrompt, buildVerifyPrompt, groundQuote, parseJudgeReply, parseVerifyReply } from "./prompt";
import { deriveAssessment, type IdeaRubric } from "./rubric";
import type {
  CandidateVerdict,
  ContextSpan,
  DetectedIdea,
  DetectionInput,
  DetectionResult,
  IdeaDetector,
  TranscriptTurn,
  VerifiableIdea,
} from "./types";

export const DEFAULT_IDEA_DETECTOR_MODEL = "sonnet";
export const DEFAULT_IDEA_DETECTOR_TIMEOUT_MS = 20_000;
const MAX_PITCH_WORDS = 14;

// ── the real judge: rubric inference via the host `claude` CLI ───────────────
// detect(): one call judges the whole window against the anchored rubric
// (prompt.ts); code derives confidence/surfacing from the returned rubric.
// verify(): the adversarial second pass the engine runs once, when an idea first
// crosses the surface threshold — a skeptic tries to refute it (existing
// product? joke? retracted? not software?) before the bubble pops.
// Both fail soft: any spawn/timeout/parse failure degrades to "no ideas" /
// "uphold" so a flaky call never wedges the ambient loop or blocks a real idea.
export interface HostClaudeIdeaJudgeOptions {
  model?: string;
  timeoutMs?: number;
  runner?: ClaudeCliRunner;
  // Threshold used for the advisory assessment attached to each idea (the
  // engine's ledger re-derives against its own configured threshold).
  surfaceThreshold?: number;
}

export class HostClaudeIdeaJudge implements IdeaDetector {
  readonly #model: string;
  readonly #timeoutMs: number;
  readonly #runner: ClaudeCliRunner;
  readonly #surfaceThreshold: number | undefined;

  constructor(options: HostClaudeIdeaJudgeOptions = {}) {
    this.#model = options.model ?? DEFAULT_IDEA_DETECTOR_MODEL;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_IDEA_DETECTOR_TIMEOUT_MS;
    this.#runner = options.runner ?? defaultClaudeCliRunner;
    this.#surfaceThreshold = options.surfaceThreshold;
  }

  async detect(input: DetectionInput): Promise<DetectionResult> {
    if (input.turns.length === 0) {
      return { candidates: [] };
    }
    try {
      const reply = await this.#runner(buildJudgePrompt(input), { model: this.#model, timeoutMs: this.#timeoutMs });
      const parsed = parseJudgeReply(reply, input, this.#surfaceThreshold);
      return { candidates: parsed.ideas, raw: { assessments: parsed.assessments } };
    } catch (error) {
      return { candidates: [], raw: { error: error instanceof Error ? error.message : String(error) } };
    }
  }

  async verify(idea: VerifiableIdea, input: DetectionInput): Promise<CandidateVerdict> {
    if (idea.judgment === undefined) {
      return { uphold: true, reason: "no-judgment-to-refute" };
    }
    try {
      const reply = await this.#runner(buildVerifyPrompt(idea, input), {
        model: this.#model,
        timeoutMs: this.#timeoutMs,
      });
      return parseVerifyReply(reply);
    } catch (error) {
      // Fail-open: a broken verifier must never block a real idea.
      return { uphold: true, reason: `verifier-error: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
}

// Backwards-compatible name (pre-rubric); same class.
export const HostClaudeIdeaDetector = HostClaudeIdeaJudge;
export type HostClaudeIdeaDetectorOptions = HostClaudeIdeaJudgeOptions;

// ── deterministic fallback ────────────────────────────────────────────────────
// No-model detector for CI/replay/offline: keyword cues, but emitting the SAME
// rubric-shaped judgments as the real judge so every downstream path is uniform.
// NOT the primary path — it exists so detection degrades to *something* grounded.
// countCues() matches WHOLE WORDS ONLY (turn text is tokenized and looked up in
// a set), so morphological variants and substrings never match: "extension" is
// NOT hit by "extend", "tracker" is NOT hit by "track" or "tracking". Every
// concrete artifact noun a room is likely to say verbatim must therefore be
// listed in its spoken form — which is why "extension", "chrome", "plugin",
// "timer", "tracker" and "calculator" are spelled out individually below (a
// real "chrome extension" pitch was undetectable without them).
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
  "extension",
  "chrome",
  "plugin",
  "timer",
  "tracker",
  "calculator",
] as const;

// ── cue clustering ───────────────────────────────────────────────────────────
// One candidate PER CLUSTER of cue turns, not one spanning the whole window.
// Without clustering the heuristic emitted a single candidate stretching from
// the FIRST to the LAST cue turn in the rolling window (~6 min), so a second
// idea spoken within the window merged into the first one's span (same
// candidate, same known-match) and never surfaced on its own — the room needed
// the whole window to age out between ideas. A gap of >= clusterGapTurns
// non-cue turns OR >= clusterGapMs between consecutive cue turns starts a new
// cluster; each cluster gets its own span/pitch/known-match, so known-candidate
// suppression only ever hits the SAME cluster and a fresh idea minutes (or
// seconds) later surfaces immediately as its own candidate.
export const DEFAULT_HEURISTIC_CLUSTER_GAP_TURNS = 2;
export const DEFAULT_HEURISTIC_CLUSTER_GAP_MS = 45_000;

export const HEURISTIC_DETECTOR_ENV_DEFAULTS = Object.freeze({
  VIBERSYN_HEURISTIC_CLUSTER_GAP_TURNS: {
    default: String(DEFAULT_HEURISTIC_CLUSTER_GAP_TURNS),
    description: "Consecutive non-cue turns between cue turns that split idea clusters.",
  },
  VIBERSYN_HEURISTIC_CLUSTER_GAP_MS: {
    default: String(DEFAULT_HEURISTIC_CLUSTER_GAP_MS),
    description: "Silence (ms) between cue turns that splits idea clusters.",
  },
} satisfies Record<string, { default: string; description: string }>);

export interface HeuristicIdeaDetectorOptions {
  clusterGapTurns?: number;
  clusterGapMs?: number;
  env?: Record<string, string | undefined>;
}

export class HeuristicIdeaDetector implements IdeaDetector {
  readonly #clusterGapTurns: number;
  readonly #clusterGapMs: number;

  constructor(options: HeuristicIdeaDetectorOptions = {}) {
    const env = options.env ?? {};
    this.#clusterGapTurns = options.clusterGapTurns ?? envNumber(env, "VIBERSYN_HEURISTIC_CLUSTER_GAP_TURNS", DEFAULT_HEURISTIC_CLUSTER_GAP_TURNS);
    this.#clusterGapMs = options.clusterGapMs ?? envNumber(env, "VIBERSYN_HEURISTIC_CLUSTER_GAP_MS", DEFAULT_HEURISTIC_CLUSTER_GAP_MS);
  }

  async detect(input: DetectionInput): Promise<DetectionResult> {
    return this.detectSync(input);
  }

  detectSync(input: DetectionInput): DetectionResult {
    const cueIndices: number[] = [];
    input.turns.forEach((turn, index) => {
      if (hasBuildableCue(turn.text)) {
        cueIndices.push(index);
      }
    });
    if (cueIndices.length === 0) {
      return { candidates: [] };
    }
    const clusters = this.#clusterCueIndices(cueIndices, input.turns);
    return { candidates: clusters.map((cluster) => this.#candidateForCluster(cluster, input)) };
  }

  // Split the ordered cue-turn indices wherever the conversation moved on:
  // enough intervening non-cue turns (chatter) or enough silence between cues.
  #clusterCueIndices(cueIndices: readonly number[], turns: readonly TranscriptTurn[]): number[][] {
    const clusters: number[][] = [[cueIndices[0]]];
    for (let i = 1; i < cueIndices.length; i += 1) {
      const prev = cueIndices[i - 1];
      const next = cueIndices[i];
      const nonCueTurnsBetween = next - prev - 1;
      const msBetween = turns[next].atMs - turns[prev].atMs;
      if (nonCueTurnsBetween >= this.#clusterGapTurns || msBetween >= this.#clusterGapMs) {
        clusters.push([]);
      }
      clusters.at(-1)?.push(next);
    }
    return clusters;
  }

  #candidateForCluster(cluster: readonly number[], input: DetectionInput): DetectedIdea {
    const cueTurns = cluster.map((index) => input.turns[index]);
    const start = cueTurns[0];
    const end = cueTurns.at(-1) ?? start;
    const hits = cueTurns.reduce((sum, turn) => sum + countCues(turn.text), 0);
    // A single cue reads as a named concept (concreteness 1 → conf 0.55: the
    // advisory assessment below holds it at the detector's 0.6 default, but the
    // ledger re-derives against the engine's loosened 0.55 ready threshold, where
    // it lands exactly AT the line); repeated cues read as described behavior
    // (concreteness 2 → surfaces everywhere). Mirrors the old 0.55 / 0.66+ split.
    const rubric: IdeaRubric = {
      category: "proposal",
      concreteness: hits >= 2 ? 2 : 1,
      buildableAsSoftware: 2,
      intent: 2,
      novelty: 2,
    };
    const assessment = deriveAssessment(rubric);
    const span: ContextSpan = {
      startTurnId: start.id,
      endTurnId: end.id,
      quote: groundQuote(input.turns, start.id, end.id) ?? cueTurns.map((t) => t.text).join(" "),
    };
    // Known-candidate matching is per-cluster: only a known idea grounded in
    // THIS cluster's stretch of talk is an update; other clusters stay fresh.
    const matchId = input.known.find((k) => spansOverlap(k.contextSpan, start.id, end.id, input.turns))?.id ?? null;
    return {
      matchId,
      pitch: clampWords(start.text, MAX_PITCH_WORDS),
      confidence: assessment.confidence,
      questions: ["Scope it as one task?", "Spawn an agent now?"],
      answers: ["Yes, scope it", "Yes, spawn it"],
      contextSpan: span,
      rationale: "heuristic: buildable cue detected",
      judgment: { rubric, assessment },
    };
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

// Mirrors selectDecisionLLM: explicit VIBERSYN_IDEA_DETECTOR wins; otherwise
// default to real host-`claude` rubric inference (no key required). Force the
// deterministic detector with VIBERSYN_IDEA_DETECTOR=heuristic (CI/offline).
export function selectIdeaDetector(
  env: IdeaDetectorSelectionEnv = process.env,
  options: SelectIdeaDetectorOptions = {},
): IdeaDetectorSelection {
  const requested = env.VIBERSYN_IDEA_DETECTOR?.trim().toLowerCase();
  if (requested === "heuristic") {
    return { mode: "heuristic", detector: new HeuristicIdeaDetector({ env }) };
  }
  if (requested !== undefined && requested !== "" && requested !== "host-claude") {
    throw new Error(`Unknown VIBERSYN_IDEA_DETECTOR mode: ${requested}`);
  }
  return {
    mode: "host-claude",
    detector: new HostClaudeIdeaJudge({ model: env.VIBERSYN_IDEA_DETECTOR_MODEL, runner: options.runner }),
  };
}

// ── shared helpers ────────────────────────────────────────────────────────────
function spansOverlap(span: ContextSpan, startId: string, endId: string, turns: readonly TranscriptTurn[]): boolean {
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

function envNumber(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number.`);
  }
  return value;
}

function countCues(text: string): number {
  const words = text.toLowerCase().match(/[a-z0-9']+/gu) ?? [];
  const set = new Set(words);
  return BUILDABLE_CUES.reduce((sum, cue) => sum + (set.has(cue) ? 1 : 0), 0);
}

function clampWords(text: string, max: number): string {
  return text.trim().split(/\s+/u).filter(Boolean).slice(0, max).join(" ");
}
