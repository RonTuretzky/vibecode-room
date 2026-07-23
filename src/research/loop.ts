// The research loop: owns the rolling dialogue window (turns with STABLE ids —
// the 3D dialogue tree anchors to them), the quest ledger, and the cadence of
// suggestion rounds. Mirrors the DetectionRunner/engine split in spirit but
// stays one class: the suggester/agent own the intelligence, the loop owns
// reconciliation + lifecycle. Turns are ALWAYS ingested (the dialogue tree is
// live data even before research mode is toggled); suggestion inference runs
// only while the mode is active.

import type { TranscriptTurn } from "../detect/types";
import { suggestFromTurn } from "./suggester";
import type {
  ResearchAgent,
  ResearchQuest,
  ResearchSuggester,
  ResearchSuggestion,
} from "./types";

export interface ResearchTraceEvent {
  event: string;
  level: "debug" | "info" | "warn" | "error";
  correlationId: string;
  meta: Record<string, unknown>;
}

export interface ResearchLoopOptions {
  sessionId: string;
  suggester: ResearchSuggester;
  agent: ResearchAgent;
  clock?: () => number;
  idFactory?: () => string;
  // Fired after every ledger/turn change so the server can republish.
  onUpdate?: () => void;
  onTrace?: (event: ResearchTraceEvent) => void;
  // Rolling dialogue window size (turns kept + surfaced to the wall).
  windowTurns?: number;
  // Ledger cap across proposed quests — the wall must stay glanceable.
  maxProposed?: number;
  // Minimum gap between suggestion rounds (model inference).
  minRoundIntervalMs?: number;
  // New words accumulated before a passive round is worth running.
  newWordsThreshold?: number;
  // Proposed quests missing this many consecutive rounds are pruned.
  staleMissedRounds?: number;
  // A dismissed topic is suppressed for this long so it doesn't re-pop.
  suppressMs?: number;
}

const DEFAULT_WINDOW_TURNS = 40;
const DEFAULT_MAX_PROPOSED = 6;
const DEFAULT_MIN_ROUND_INTERVAL_MS = 6_000;
// One spoken sentence is enough to be worth a round — 18 forced the room to
// keep talking before ANY crystal could appear, which read as "broken".
const DEFAULT_NEW_WORDS_THRESHOLD = 8;
const DEFAULT_STALE_MISSED_ROUNDS = 6;
const DEFAULT_SUPPRESS_MS = 5 * 60_000;

interface RunningQuest {
  controller: AbortController;
}

export class ResearchLoop {
  readonly #sessionId: string;
  readonly #suggester: ResearchSuggester;
  readonly #agent: ResearchAgent;
  readonly #clock: () => number;
  readonly #idFactory: () => string;
  readonly #onUpdate?: () => void;
  readonly #onTrace?: (event: ResearchTraceEvent) => void;
  readonly #windowTurns: number;
  readonly #maxProposed: number;
  readonly #minRoundIntervalMs: number;
  readonly #newWordsThreshold: number;
  readonly #staleMissedRounds: number;
  readonly #suppressMs: number;

  #turns: TranscriptTurn[] = [];
  #turnSeq = 0;
  readonly #quests = new Map<string, ResearchQuest>();
  readonly #running = new Map<string, RunningQuest>();
  readonly #suppressed = new Map<string, number>();
  #active = false;
  #inFlight: Promise<void> | null = null;
  #lastRoundAtMs: number | null = null;
  #wordsSinceRound = 0;
  #round = 0;

  constructor(options: ResearchLoopOptions) {
    this.#sessionId = options.sessionId;
    this.#suggester = options.suggester;
    this.#agent = options.agent;
    this.#clock = options.clock ?? (() => Date.now());
    this.#idFactory = options.idFactory ?? (() => crypto.randomUUID().slice(0, 8));
    this.#onUpdate = options.onUpdate;
    this.#onTrace = options.onTrace;
    this.#windowTurns = options.windowTurns ?? DEFAULT_WINDOW_TURNS;
    this.#maxProposed = options.maxProposed ?? DEFAULT_MAX_PROPOSED;
    this.#minRoundIntervalMs = options.minRoundIntervalMs ?? DEFAULT_MIN_ROUND_INTERVAL_MS;
    this.#newWordsThreshold = options.newWordsThreshold ?? DEFAULT_NEW_WORDS_THRESHOLD;
    this.#staleMissedRounds = options.staleMissedRounds ?? DEFAULT_STALE_MISSED_ROUNDS;
    this.#suppressMs = options.suppressMs ?? DEFAULT_SUPPRESS_MS;
  }

  // ── mode ──────────────────────────────────────────────────────────────────

  active(): boolean {
    return this.#active;
  }

  setActive(on: boolean): void {
    if (this.#active === on) {
      return;
    }
    this.#active = on;
    if (on) {
      // Entering research mode reviews the conversation so far immediately.
      void this.maybeSuggest(true);
    }
    this.#emit();
  }

  // ── dialogue window ───────────────────────────────────────────────────────

  // Fold one FINAL room utterance in. Returns the stable turn (with id) so the
  // caller can correlate. Suggestion rounds kick in the background while the
  // mode is active — never blocking the caller's transcript path.
  ingestTurn(input: { speaker: string | null; text: string; atMs: number }): TranscriptTurn {
    this.#turnSeq += 1;
    const turn: TranscriptTurn = {
      id: `rturn-${String(this.#turnSeq).padStart(4, "0")}`,
      speaker: input.speaker,
      text: input.text,
      atMs: input.atMs,
    };
    this.#turns = [...this.#turns, turn].slice(-this.#windowTurns);
    this.#wordsSinceRound += turn.text.split(/\s+/u).filter((word) => word.length > 0).length;
    if (this.#active) {
      void this.maybeSuggest();
    }
    this.#emit();
    return turn;
  }

  turns(): readonly TranscriptTurn[] {
    return this.#turns;
  }

  // ── suggestion rounds ─────────────────────────────────────────────────────

  // Run a suggestion round if the cadence allows (or `force`), never
  // overlapping. Returns the in-flight promise so tests can await the round.
  maybeSuggest(force = false): Promise<void> {
    if (!this.#active) {
      return Promise.resolve();
    }
    if (this.#inFlight !== null) {
      return this.#inFlight;
    }
    const nowMs = this.#clock();
    if (!force) {
      if (this.#wordsSinceRound < this.#newWordsThreshold) {
        return Promise.resolve();
      }
      if (this.#lastRoundAtMs !== null && nowMs - this.#lastRoundAtMs < this.#minRoundIntervalMs) {
        return Promise.resolve();
      }
    }
    if (this.#turns.length === 0) {
      return Promise.resolve();
    }
    this.#lastRoundAtMs = nowMs;
    this.#wordsSinceRound = 0;
    this.#round += 1;
    const correlationId = `corr-research-round-${this.#round}`;
    const run = this.#suggester
      .suggest({
        sessionId: this.#sessionId,
        correlationId,
        turns: [...this.#turns],
        known: [...this.#quests.values()]
          .filter((quest) => quest.status === "proposed" || quest.status === "researching")
          .map((quest) => ({ id: quest.id, kind: quest.kind, topic: quest.topic, claim: quest.claim })),
      })
      .then((suggestions) => {
        this.#reconcile(suggestions, this.#clock(), correlationId);
      })
      .catch((error) => {
        this.#trace("research.suggest.error", "error", correlationId, {
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.#inFlight = null;
      });
    this.#inFlight = run;
    return run;
  }

  async flush(): Promise<void> {
    while (this.#inFlight !== null) {
      await this.#inFlight;
    }
  }

  #reconcile(suggestions: ResearchSuggestion[], nowMs: number, correlationId: string): void {
    const seen = new Set<string>();
    let changed = false;
    for (const suggestion of suggestions) {
      const matched = suggestion.matchId !== null ? this.#quests.get(suggestion.matchId) : undefined;
      if (matched !== undefined && matched.status === "proposed") {
        // UPDATE: confidence ratchets up, grounding/topic follow the room.
        matched.confidence = Math.max(matched.confidence, clamp01(suggestion.confidence));
        matched.topic = suggestion.topic;
        matched.claim = suggestion.claim;
        matched.rationale = suggestion.rationale;
        matched.contextSpan = { ...suggestion.contextSpan };
        matched.roundsSeen += 1;
        matched.missedRounds = 0;
        matched.updatedAtMs = nowMs;
        seen.add(matched.id);
        changed = true;
        continue;
      }
      if (matched !== undefined) {
        seen.add(matched.id); // researching/complete — re-detection is a no-op
        continue;
      }
      if (this.#isSuppressed(suggestion.topic, suggestion.claim, nowMs)) {
        continue;
      }
      if (this.#proposedCount() >= this.#maxProposed) {
        continue;
      }
      const quest: ResearchQuest = {
        id: `rq-${this.#idFactory()}`,
        kind: suggestion.kind,
        topic: suggestion.topic,
        claim: suggestion.claim,
        rationale: suggestion.rationale,
        confidence: clamp01(suggestion.confidence),
        contextSpan: { ...suggestion.contextSpan },
        status: "proposed",
        progress: 0,
        progressLabel: "",
        report: null,
        error: null,
        roundsSeen: 1,
        missedRounds: 0,
        firstSeenAtMs: nowMs,
        updatedAtMs: nowMs,
      };
      this.#quests.set(quest.id, quest);
      seen.add(quest.id);
      changed = true;
      this.#trace("research.suggest.new", "info", correlationId, {
        id: quest.id,
        kind: quest.kind,
        topic: quest.topic,
        confidence: quest.confidence,
      });
    }
    // Stale pruning: only PROPOSED quests decay; committed work persists.
    for (const quest of this.#quests.values()) {
      if (quest.status !== "proposed" || seen.has(quest.id)) {
        continue;
      }
      quest.missedRounds += 1;
      if (quest.missedRounds >= this.#staleMissedRounds) {
        this.#quests.delete(quest.id);
        changed = true;
        this.#trace("research.suggest.stale", "info", correlationId, { id: quest.id, topic: quest.topic });
      }
    }
    if (changed) {
      this.#emit();
    }
  }

  // ── ledger reads ──────────────────────────────────────────────────────────

  // Tray/wall order: live work first (researching), then proposals by
  // confidence, then completed artifacts, then failures — newest first within
  // each group.
  quests(): ResearchQuest[] {
    const rank: Record<ResearchQuest["status"], number> = { researching: 0, proposed: 1, complete: 2, failed: 3 };
    return [...this.#quests.values()].sort((a, b) => {
      if (rank[a.status] !== rank[b.status]) {
        return rank[a.status] - rank[b.status];
      }
      if (a.status === "proposed" && a.confidence !== b.confidence) {
        return b.confidence - a.confidence;
      }
      return b.updatedAtMs - a.updatedAtMs;
    });
  }

  quest(id: string): ResearchQuest | null {
    return this.#quests.get(id) ?? null;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  // Accept a proposed quest: flips it to researching and kicks the agent in
  // the background (progress lands on the quest; completion/failure republish).
  // 404-free idiom: unknown/non-proposed ids return null, mutating nothing.
  accept(id: string, correlationId = `corr-research-accept-${id}`): ResearchQuest | null {
    const quest = this.#quests.get(id);
    if (quest === undefined || quest.status !== "proposed") {
      return null;
    }
    quest.status = "researching";
    quest.progress = 2;
    quest.progressLabel = "starting research";
    quest.updatedAtMs = this.#clock();
    const controller = new AbortController();
    this.#running.set(id, { controller });
    this.#trace("research.accept", "info", correlationId, { id, kind: quest.kind, topic: quest.topic });
    this.#emit();
    void this.#agent
      .research(quest, {
        correlationId,
        signal: controller.signal,
        onProgress: (progress) => {
          quest.progress = Math.max(0, Math.min(100, progress.percent));
          quest.progressLabel = progress.label;
          quest.updatedAtMs = this.#clock();
          this.#emit();
        },
      })
      .then((report) => {
        if (this.#quests.get(id) !== quest || quest.status !== "researching") {
          return; // dismissed or stopped mid-run — its fate is already settled
        }
        quest.status = "complete";
        quest.progress = 100;
        quest.progressLabel = "report ready";
        quest.report = report;
        quest.updatedAtMs = this.#clock();
        this.#trace("research.complete", "info", correlationId, {
          id,
          findings: report.findings.length,
          sources: report.sources.length,
          biasNotes: report.biasNotes.length,
        });
      })
      .catch((error) => {
        if (this.#quests.get(id) !== quest || quest.status !== "researching") {
          return; // dismissed or stopped mid-run — its fate is already settled
        }
        quest.status = "failed";
        quest.error = controller.signal.aborted
          ? "stopped"
          : error instanceof Error
            ? error.message
            : String(error);
        quest.progressLabel = "failed";
        quest.updatedAtMs = this.#clock();
        this.#trace("research.failed", "error", correlationId, { id, message: quest.error });
      })
      .finally(() => {
        this.#running.delete(id);
        this.#emit();
      });
    return quest;
  }

  // DIRECT spawn: the wall clicked a dialogue TURN — research it now, skipping
  // the passive suggestion cadence entirely. The heuristic classifier picks
  // the kind; a turn it declines still deep-dives (a human explicitly asked,
  // so word/shape thresholds don't apply). The maxProposed cap and topic
  // suppression are also bypassed — both exist to keep PASSIVE proposals
  // glanceable. A turn already grounding a quest re-uses it (proposed →
  // accept; otherwise no-op returning it) so double-clicks can't double-spawn.
  researchTurn(turnId: string, correlationId = `corr-research-turn-${turnId}`): ResearchQuest | null {
    if (!this.#active) {
      return null;
    }
    const turn = this.#turns.find((candidate) => candidate.id === turnId);
    if (turn === undefined) {
      return null;
    }
    const existing = [...this.#quests.values()].find(
      (quest) => quest.contextSpan.startTurnId === turnId && quest.status !== "failed",
    );
    if (existing !== undefined) {
      return existing.status === "proposed" ? this.accept(existing.id, correlationId) : existing;
    }
    const text = turn.text.trim();
    const topicWords = text.split(/\s+/u).slice(0, 8).join(" ");
    const suggestion: ResearchSuggestion = suggestFromTurn(turn) ?? {
      matchId: null,
      kind: "deep-dive",
      topic: topicWords.charAt(0).toUpperCase() + topicWords.slice(1),
      claim: text.slice(0, 280),
      rationale: "Asked directly from the wall.",
      confidence: 0.75,
      contextSpan: { startTurnId: turn.id, endTurnId: turn.id, quote: text.slice(0, 180) },
    };
    const nowMs = this.#clock();
    const quest: ResearchQuest = {
      id: `rq-${this.#idFactory()}`,
      kind: suggestion.kind,
      topic: suggestion.topic,
      claim: suggestion.claim,
      rationale: suggestion.rationale,
      confidence: clamp01(Math.max(suggestion.confidence, 0.75)),
      contextSpan: { ...suggestion.contextSpan },
      status: "proposed",
      progress: 0,
      progressLabel: "",
      report: null,
      error: null,
      roundsSeen: 1,
      missedRounds: 0,
      firstSeenAtMs: nowMs,
      updatedAtMs: nowMs,
    };
    this.#quests.set(quest.id, quest);
    this.#trace("research.turn.spawn", "info", correlationId, {
      id: quest.id,
      turnId,
      kind: quest.kind,
      topic: quest.topic,
    });
    return this.accept(quest.id, correlationId);
  }

  // Dismiss: a proposed quest is dropped and its topic suppressed for the
  // cooldown (the room said no); complete/failed quests are simply cleared
  // from the wall; a researching quest is cancelled cooperatively.
  dismiss(id: string, correlationId = `corr-research-dismiss-${id}`): ResearchQuest | null {
    const quest = this.#quests.get(id);
    if (quest === undefined) {
      return null;
    }
    if (quest.status === "researching") {
      this.#running.get(id)?.controller.abort();
    }
    if (quest.status === "proposed") {
      this.#suppressed.set(suppressKey(quest.topic, quest.claim), this.#clock() + this.#suppressMs);
    }
    this.#quests.delete(id);
    this.#trace("research.dismiss", "info", correlationId, { id, topic: quest.topic, status: quest.status });
    this.#emit();
    return quest;
  }

  // Emergency stop: abort every in-flight agent and mark those quests failed.
  stopAll(reason: string): void {
    for (const [id, running] of this.#running) {
      running.controller.abort();
      const quest = this.#quests.get(id);
      if (quest !== undefined && quest.status === "researching") {
        quest.status = "failed";
        quest.error = reason;
        quest.progressLabel = "stopped";
        quest.updatedAtMs = this.#clock();
      }
    }
    this.#running.clear();
    this.#emit();
  }

  // ── internals ─────────────────────────────────────────────────────────────

  #proposedCount(): number {
    let count = 0;
    for (const quest of this.#quests.values()) {
      if (quest.status === "proposed") {
        count += 1;
      }
    }
    return count;
  }

  #isSuppressed(topic: string, claim: string, nowMs: number): boolean {
    const key = suppressKey(topic, claim);
    const until = this.#suppressed.get(key);
    if (until === undefined) {
      return false;
    }
    if (nowMs >= until) {
      this.#suppressed.delete(key);
      return false;
    }
    return true;
  }

  #emit(): void {
    this.#onUpdate?.();
  }

  #trace(event: string, level: ResearchTraceEvent["level"], correlationId: string, meta: Record<string, unknown>): void {
    this.#onTrace?.({ event, level, correlationId, meta: { sessionId: this.#sessionId, ...meta } });
  }
}

function suppressKey(topic: string, claim: string): string {
  return `${topic}::${claim}`
    .toLowerCase()
    .replace(/[^a-z0-9\s:]+/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}
