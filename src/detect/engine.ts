import { IdeaLedger, type LedgerDelta } from "./ledger";
import { TranscriptWindow } from "./transcript-window";
import type { IdeaCandidate, IdeaDetector, KnownCandidate, TranscriptTurn } from "./types";

export const DETECTION_ENGINE_ENV_DEFAULTS = Object.freeze({
  VIBERSYN_DETECT_MIN_NEW_TURNS: { default: "2", description: "New committed turns that schedule a detection round." },
  VIBERSYN_DETECT_MIN_INTERVAL_MS: { default: "4000", description: "Minimum gap between detection inference calls (throttle)." },
  VIBERSYN_DETECT_BOUNDARY_GAP_MS: { default: "2500", description: "Speech pause that schedules detection even with one new turn." },
  VIBERSYN_DETECT_READY_THRESHOLD: { default: "0.6", description: "Confidence at/above which an idea surfaces as a bubble." },
  VIBERSYN_DETECT_READY_HYSTERESIS: { default: "0.12", description: "Once ready, stay ready until confidence drops this far below the threshold." },
  VIBERSYN_DETECT_MAX_MISSED_ROUNDS: { default: "3", description: "Detection rounds without re-detection before a candidate is dropped." },
  VIBERSYN_DETECT_MAX_TURNS: { default: "60", description: "Turns retained in the rolling detection window." },
  VIBERSYN_DETECT_MAX_AGE_MS: { default: "360000", description: "Max age (ms) of a turn in the rolling window." },
  VIBERSYN_DETECT_ACCEPT_COOLDOWN_MS: { default: "30000", description: "After accepting an idea, suppress re-detecting the same pitch this long." },
  VIBERSYN_DETECT_MAX_SPANS: { default: "5", description: "Evidence spans retained per idea across rounds." },
  VIBERSYN_DETECT_VERIFY: { default: "1", description: "Adversarially verify an idea the first time it becomes ready (0 disables)." },
} satisfies Record<string, { default: string; description: string }>);

export interface DetectionEngineConfig {
  minNewTurns: number;
  minIntervalMs: number;
  boundaryGapMs: number;
  readyThreshold: number;
  readyHysteresis: number;
  maxMissedRounds: number;
  maxTurns: number;
  maxAgeMs: number;
  acceptCooldownMs: number;
  maxSpans: number;
  verifyOnSurface: boolean;
}

export function readDetectionEngineConfig(env: Record<string, string | undefined> = process.env): DetectionEngineConfig {
  const num = (name: keyof typeof DETECTION_ENGINE_ENV_DEFAULTS): number => {
    const raw = env[name]?.trim() || DETECTION_ENGINE_ENV_DEFAULTS[name].default;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${name} must be a non-negative number.`);
    }
    return value;
  };
  return {
    minNewTurns: Math.max(1, num("VIBERSYN_DETECT_MIN_NEW_TURNS")),
    minIntervalMs: num("VIBERSYN_DETECT_MIN_INTERVAL_MS"),
    boundaryGapMs: num("VIBERSYN_DETECT_BOUNDARY_GAP_MS"),
    readyThreshold: num("VIBERSYN_DETECT_READY_THRESHOLD"),
    readyHysteresis: num("VIBERSYN_DETECT_READY_HYSTERESIS"),
    maxMissedRounds: num("VIBERSYN_DETECT_MAX_MISSED_ROUNDS"),
    maxTurns: Math.max(1, num("VIBERSYN_DETECT_MAX_TURNS")),
    maxAgeMs: num("VIBERSYN_DETECT_MAX_AGE_MS"),
    acceptCooldownMs: num("VIBERSYN_DETECT_ACCEPT_COOLDOWN_MS"),
    maxSpans: Math.max(1, num("VIBERSYN_DETECT_MAX_SPANS")),
    verifyOnSurface: num("VIBERSYN_DETECT_VERIFY") !== 0,
  };
}

export interface DetectionTraceEvent {
  event: string;
  level: "debug" | "info";
  sessionId: string;
  correlationId?: string;
  meta: Record<string, unknown>;
}

export interface DetectionEngineOptions {
  sessionId: string;
  detector: IdeaDetector;
  clock?: () => number;
  idFactory?: () => string;
  env?: Record<string, string | undefined>;
  onTrace?: (event: DetectionTraceEvent) => void;
}

export interface DetectionRunResult extends LedgerDelta {
  ran: boolean;
}

export interface SchedulingState {
  turnsSinceDetect: number;
  minNewTurns: number;
  msSinceLastDetect: number | null;
  detecting: boolean;
}

// The ambient idea-detection engine. It replaces the word/time gate entirely:
// instead of vetoing inference until 60 words / 90 seconds, it always lets the
// MODEL decide whether the conversation contains a buildable idea — it only
// decides WHEN to run inference (a cheap, local scheduling policy: enough new
// turns, or a speech pause, subject to a throttle). Detection runs over the whole
// rolling window, and every candidate carries the span of talk it came from.
export class IdeaDetectionEngine {
  readonly #sessionId: string;
  readonly #detector: IdeaDetector;
  readonly #clock: () => number;
  readonly #idFactory: () => string;
  readonly #config: DetectionEngineConfig;
  readonly #onTrace?: (event: DetectionTraceEvent) => void;
  readonly #window: TranscriptWindow;
  readonly #ledger: IdeaLedger;
  #turnsSinceDetect = 0;
  #lastDetectAtMs: number | null = null;
  #detecting = false;
  #suppressed: Array<{ pitch: string; untilMs: number }> = [];

  constructor(options: DetectionEngineOptions) {
    this.#sessionId = options.sessionId;
    this.#detector = options.detector;
    this.#clock = options.clock ?? (() => Date.now());
    this.#idFactory = options.idFactory ?? (() => `idea-${crypto.randomUUID()}`);
    this.#config = readDetectionEngineConfig(options.env);
    this.#onTrace = options.onTrace;
    this.#window = new TranscriptWindow({ maxTurns: this.#config.maxTurns, maxAgeMs: this.#config.maxAgeMs });
    this.#ledger = new IdeaLedger(
      {
        readyThreshold: this.#config.readyThreshold,
        readyHysteresis: this.#config.readyHysteresis,
        maxMissedRounds: this.#config.maxMissedRounds,
        maxSpans: this.#config.maxSpans,
      },
      this.#idFactory,
    );
  }

  config(): DetectionEngineConfig {
    return { ...this.#config };
  }

  // Append one committed (FINAL) line of room speech. Returns the created turn, or
  // null for empty text. Counts toward the scheduling policy.
  ingestTurn(input: { speaker: string | null; text: string; atMs?: number }): TranscriptTurn | null {
    const turn = this.#window.append({ speaker: input.speaker, text: input.text, atMs: input.atMs ?? this.#clock() });
    if (turn !== null) {
      this.#turnsSinceDetect += 1;
    }
    return turn;
  }

  // Cheap local scheduling decision — NOT an eligibility veto. Detection runs when
  // there is new material AND (enough new turns OR a speech pause), subject to a
  // throttle so a chatty room doesn't spawn an inference per utterance.
  shouldDetect(nowMs = this.#clock()): boolean {
    if (this.#detecting || this.#window.isEmpty() || this.#turnsSinceDetect === 0) {
      return false;
    }
    if (this.#lastDetectAtMs !== null && nowMs - this.#lastDetectAtMs < this.#config.minIntervalMs) {
      return false;
    }
    if (this.#turnsSinceDetect >= this.#config.minNewTurns) {
      return true;
    }
    const lastAtMs = this.#window.lastAtMs();
    return lastAtMs !== null && nowMs - lastAtMs >= this.#config.boundaryGapMs;
  }

  // Run one detection round: inference over the whole window, then reconcile into
  // the in-flight candidate set. Re-entrancy guarded. Returns the reconcile delta.
  async detect(correlationId: string, nowMs = this.#clock()): Promise<DetectionRunResult> {
    const empty: DetectionRunResult = { ran: false, candidates: this.candidates(), created: [], updated: [], superseded: [] };
    if (this.#detecting || this.#window.isEmpty()) {
      return empty;
    }
    this.#detecting = true;
    try {
      this.#pruneSuppressed(nowMs);
      const turns = this.#window.turns();
      const known: KnownCandidate[] = this.#ledger.candidates().map((c) => ({ id: c.id, pitch: c.pitch, contextSpan: c.contextSpan }));
      this.#trace({ event: "detect.run", level: "info", correlationId, meta: { turns: turns.length, known: known.length, turnsSinceDetect: this.#turnsSinceDetect } });
      const input = { sessionId: this.#sessionId, correlationId, turns, known };
      const result = await this.#detector.detect(input);
      const detected = result.candidates.filter((idea) => !this.#isSuppressed(idea.pitch, nowMs));
      const delta = this.#ledger.reconcile(detected, turns, nowMs);
      this.#turnsSinceDetect = 0;
      this.#lastDetectAtMs = nowMs;
      for (const c of delta.created) {
        this.#trace({ event: "detect.candidate.new", level: "info", correlationId, meta: traceMeta(c) });
      }
      for (const c of delta.updated) {
        this.#trace({ event: "detect.candidate.update", level: "debug", correlationId, meta: traceMeta(c) });
      }
      for (const c of delta.superseded) {
        this.#trace({ event: "detect.candidate.superseded", level: "debug", correlationId, meta: { id: c.id } });
      }

      // Adversarial verification: the first time an idea becomes READY, a skeptic
      // pass tries to refute it (existing product? joke? retracted?) BEFORE the
      // bubble surfaces (primary() withholds ready-but-unverified candidates while
      // verification is active). A rejection vetoes it back to forming with the
      // reason; the veto lifts only if the idea later returns materially stronger.
      // Bounded: at most ONE verification call per round — the strongest pending
      // candidate (the would-be primary); others verify in subsequent rounds.
      if (this.#verificationActive()) {
        const pending = this.#ledger
          .needingVerification()
          .sort((a, b) => b.confidence - a.confidence)[0];
        if (pending !== undefined) {
          const verdict = await this.#detector.verify!(pending, input);
          if (verdict.uphold) {
            this.#ledger.markVerified(pending.id);
            this.#trace({ event: "detect.candidate.verified", level: "info", correlationId, meta: { id: pending.id, reason: verdict.reason } });
          } else {
            this.#ledger.veto(pending.id, verdict.reason);
            this.#trace({ event: "detect.candidate.vetoed", level: "info", correlationId, meta: { id: pending.id, reason: verdict.reason, pitch: pending.pitch } });
          }
        }
      }

      return { ran: true, ...delta, candidates: this.candidates() };
    } finally {
      this.#detecting = false;
    }
  }

  candidates(): IdeaCandidate[] {
    return this.#ledger.candidates();
  }

  // The single idea to surface as the bubble: the highest-confidence READY
  // candidate (tie-break: most recently updated). Null when none are ready.
  // While adversarial verification is active, an unverified candidate is NOT
  // surfaceable — the skeptic pass must uphold it first, even if a publish
  // happens mid-round while verify() is still awaited.
  primary(): IdeaCandidate | null {
    const requireVerified = this.#verificationActive();
    let best: IdeaCandidate | null = null;
    for (const c of this.#ledger.candidates()) {
      if (c.status !== "ready" || (requireVerified && !c.verified)) {
        continue;
      }
      if (best === null || c.confidence > best.confidence || (c.confidence === best.confidence && c.updatedAtMs > best.updatedAtMs)) {
        best = c;
      }
    }
    return best;
  }

  #verificationActive(): boolean {
    return this.#config.verifyOnSurface && typeof this.#detector.verify === "function";
  }

  // Consume an accepted candidate: drop it and suppress re-detection of the same
  // pitch for a cooldown so the just-built idea doesn't immediately re-pop.
  accept(id: string, nowMs = this.#clock()): IdeaCandidate | null {
    const found = this.#ledger.accept(id);
    if (found === null) {
      return null;
    }
    this.#suppressed.push({ pitch: normalizePitch(found.pitch), untilMs: nowMs + this.#config.acceptCooldownMs });
    return found;
  }

  // Drop all candidates (e.g. mute / emergency stop). Suppression is left intact.
  clear(): void {
    this.#ledger.clear();
  }

  schedulingState(nowMs = this.#clock()): SchedulingState {
    return {
      turnsSinceDetect: this.#turnsSinceDetect,
      minNewTurns: this.#config.minNewTurns,
      msSinceLastDetect: this.#lastDetectAtMs === null ? null : Math.max(0, nowMs - this.#lastDetectAtMs),
      detecting: this.#detecting,
    };
  }

  #isSuppressed(pitch: string, nowMs: number): boolean {
    const normalized = normalizePitch(pitch);
    return this.#suppressed.some((s) => s.untilMs > nowMs && s.pitch === normalized);
  }

  #pruneSuppressed(nowMs: number): void {
    this.#suppressed = this.#suppressed.filter((s) => s.untilMs > nowMs);
  }

  #trace(event: Omit<DetectionTraceEvent, "sessionId">): void {
    this.#onTrace?.({ ...event, sessionId: this.#sessionId });
  }
}

function traceMeta(c: IdeaCandidate): Record<string, unknown> {
  return {
    id: c.id,
    pitch: c.pitch,
    confidence: c.confidence,
    status: c.status,
    maturity: c.maturity,
    verified: c.verified,
    blockedBy: c.judgment?.assessment.blockedBy ?? [],
    span: `${c.contextSpan.startTurnId}..${c.contextSpan.endTurnId}`,
  };
}

function normalizePitch(pitch: string): string {
  return pitch.toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
}
