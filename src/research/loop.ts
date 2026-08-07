// The research loop: owns the rolling dialogue window (turns with STABLE ids —
// the 3D dialogue tree anchors to them), the quest ledger, and the cadence of
// suggestion rounds. Mirrors the DetectionRunner/engine split in spirit but
// stays one class: the suggester/agent own the intelligence, the loop owns
// reconciliation + lifecycle. Turns are ALWAYS ingested (the dialogue tree is
// live data even before research mode is toggled); suggestion inference runs
// only while the mode is active. Fragment coalescing + concept topics
// (tree.ts) keep the window utterance-shaped instead of ASR-fragment-shaped.

import type { TranscriptTurn } from "../detect/types";
import { ConceptTree, type ConceptTopic } from "./tree";
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
  // Periodic review timer: while the mode is active, re-read the dialogue
  // every this many ms and bud at most ONE new sphere. 0 disables the timer
  // (tests drive periodicSuggest manually). VIBERSYN_RESEARCH_SUGGEST_INTERVAL_MS.
  suggestIntervalMs?: number;
  // New words accumulated before a passive round is worth running.
  newWordsThreshold?: number;
  // Proposed quests missing this many consecutive rounds are pruned.
  staleMissedRounds?: number;
  // A dismissed topic is suppressed for this long so it doesn't re-pop.
  suppressMs?: number;
  // Concept clustering over the window (tree.ts). Injectable for tests; the
  // default tree runs the production Cerebras refiner (a clean no-op without
  // CEREBRAS_API_KEY) and republishes through this loop when a refinement lands.
  conceptTree?: ConceptTree;
  // A same-speaker fragment arriving within this gap of the newest turn's last
  // growth merges into it instead of becoming a new turn.
  coalesceGapMs?: number;
  // A turn at/over this many words stops absorbing fragments.
  coalesceMaxWords?: number;
}

const DEFAULT_WINDOW_TURNS = 40;
const DEFAULT_MAX_PROPOSED = 6;
const DEFAULT_MIN_ROUND_INTERVAL_MS = 6_000;
// Periodic review cadence: ingest-driven rounds need newWordsThreshold fresh
// words, so a trickle below the threshold (then silence) would never get a
// round — the timer catches that tail. Once a minute keeps the wall alive
// without burning inference on a quiet room (the unchanged-dialogue gate
// skips the tick entirely).
export const DEFAULT_SUGGEST_INTERVAL_MS = 60_000;
// A timer round buds at most ONE new sphere — a periodic tick must never dump
// a batch of crystals on a room that was barely talking.
const PERIODIC_MAX_NEW_QUESTS = 1;
// One spoken sentence is enough to be worth a round — 18 forced the room to
// keep talking before ANY crystal could appear, which read as "broken".
const DEFAULT_NEW_WORDS_THRESHOLD = 8;
const DEFAULT_STALE_MISSED_ROUNDS = 6;
const DEFAULT_SUPPRESS_MS = 5 * 60_000;
// Deepgram finalizes every few words; a same-speaker follow-up inside this gap
// is the SAME utterance still being spoken, not a new one.
const DEFAULT_COALESCE_GAP_MS = 6_000;
// Past this a "turn" stops being one clickable thought — cap the merge.
const DEFAULT_COALESCE_MAX_WORDS = 50;
// PRECISION GUARDS (reconcile): proposals below this confidence never surface…
const MIN_SURFACING_CONFIDENCE = 0.45;
// …claims this token-Jaccard-similar to an existing quest merge instead of
// spawning a sibling crystal…
const NEAR_DUPE_JACCARD = 0.6;
// …and weak proposals decay on a shorter leash than confident ones.
const WEAK_CONFIDENCE = 0.55;
const WEAK_STALE_MISSED_ROUNDS = 3;
// Topic context handed to the research agent: bounded so prompts stay sane.
const CONTEXT_MAX_TURNS = 8;
const CONTEXT_MAX_CHARS = 1_200;

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
  readonly #suggestIntervalMs: number;
  readonly #newWordsThreshold: number;
  readonly #staleMissedRounds: number;
  readonly #suppressMs: number;
  readonly #tree: ConceptTree;
  readonly #coalesceGapMs: number;
  readonly #coalesceMaxWords: number;

  #turns: TranscriptTurn[] = [];
  #turnSeq = 0;
  // When the newest turn last grew (its atMs stays at the FIRST fragment, so
  // continuous speech needs its own freshness marker for the coalesce gap).
  #newestFragmentAtMs = Number.NEGATIVE_INFINITY;
  readonly #quests = new Map<string, ResearchQuest>();
  readonly #running = new Map<string, RunningQuest>();
  readonly #suppressed = new Map<string, number>();
  #active = false;
  #inFlight: Promise<void> | null = null;
  #lastRoundAtMs: number | null = null;
  #wordsSinceRound = 0;
  #round = 0;
  #suggestTimer: ReturnType<typeof setInterval> | null = null;

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
    this.#suggestIntervalMs = options.suggestIntervalMs ?? DEFAULT_SUGGEST_INTERVAL_MS;
    this.#newWordsThreshold = options.newWordsThreshold ?? DEFAULT_NEW_WORDS_THRESHOLD;
    this.#staleMissedRounds = options.staleMissedRounds ?? DEFAULT_STALE_MISSED_ROUNDS;
    this.#suppressMs = options.suppressMs ?? DEFAULT_SUPPRESS_MS;
    // A model refinement changes the clustering asynchronously — republish so
    // the wall's branches re-arrange without waiting for the next turn.
    this.#tree = options.conceptTree ?? new ConceptTree({ onRefined: () => this.#emit() });
    this.#coalesceGapMs = options.coalesceGapMs ?? DEFAULT_COALESCE_GAP_MS;
    this.#coalesceMaxWords = options.coalesceMaxWords ?? DEFAULT_COALESCE_MAX_WORDS;
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
      this.#startPeriodic();
    } else {
      // The timer's lifetime IS the mode's lifetime — an off room ticks nothing.
      this.#stopPeriodic();
    }
    this.#emit();
  }

  #startPeriodic(): void {
    if (this.#suggestTimer !== null || this.#suggestIntervalMs <= 0) {
      return;
    }
    const timer = setInterval(() => void this.periodicSuggest(), this.#suggestIntervalMs);
    // The periodic review must never keep the process alive on its own.
    (timer as { unref?: () => void }).unref?.();
    this.#suggestTimer = timer;
  }

  #stopPeriodic(): void {
    if (this.#suggestTimer !== null) {
      clearInterval(this.#suggestTimer);
      this.#suggestTimer = null;
    }
  }

  // ── dialogue window ───────────────────────────────────────────────────────

  // Fold one FINAL room utterance in. Returns the stable turn (with id) so the
  // caller can correlate. Deepgram finalizes every few words, so a fragment
  // from the SAME speaker hot on the heels of the newest turn GROWS that turn
  // in place — same id, same atMs — instead of spawning a ball per breath.
  // Growth-only under the original id is a hard contract: research quests
  // anchor to turn ids (contextSpan.startTurnId) and the wall's researchTurn
  // click path resolves them. Suggestion rounds kick in the background while
  // the mode is active — never blocking the caller's transcript path.
  ingestTurn(input: { speaker: string | null; text: string; atMs: number }): TranscriptTurn {
    const text = input.text.trim();
    const newWords = countWords(text);
    const newest = this.#turns[this.#turns.length - 1];
    if (
      newest !== undefined &&
      newest.speaker === input.speaker &&
      input.atMs - this.#newestFragmentAtMs <= this.#coalesceGapMs &&
      countWords(newest.text) < this.#coalesceMaxWords
    ) {
      newest.text = `${newest.text} ${text}`;
      this.#newestFragmentAtMs = input.atMs;
      // The suggester cadence counts SPOKEN words, merged or not.
      this.#wordsSinceRound += newWords;
      this.#tree.update(newest);
      if (this.#active) {
        void this.maybeSuggest();
      }
      this.#emit();
      return newest;
    }
    this.#turnSeq += 1;
    const turn: TranscriptTurn = {
      id: `rturn-${String(this.#turnSeq).padStart(4, "0")}`,
      speaker: input.speaker,
      text,
      atMs: input.atMs,
    };
    this.#turns = [...this.#turns, turn].slice(-this.#windowTurns);
    this.#newestFragmentAtMs = input.atMs;
    this.#wordsSinceRound += newWords;
    this.#tree.assign(turn);
    // Turns the window just dropped must not haunt the topic branches.
    this.#tree.prune(this.#turns.map((entry) => entry.id));
    if (this.#active) {
      void this.maybeSuggest();
    }
    this.#emit();
    return turn;
  }

  turns(): readonly TranscriptTurn[] {
    return this.#turns;
  }

  // Concept topics over the window, oldest-first — the snapshot's
  // dialogueTopics (each topic a branch of the 3D conversation tree).
  topics(): ConceptTopic[] {
    return this.#tree.topics();
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
    return this.#launchRound(nowMs, {});
  }

  // TIMER tick (suggestIntervalMs): review the dialogue so far and bud at most
  // ONE new sphere. Bypasses newWordsThreshold — this is how a sub-threshold
  // trickle eventually gets its round — but an unchanged dialogue (zero new
  // words since the last round) burns no inference at all.
  periodicSuggest(): Promise<void> {
    if (!this.#active) {
      return Promise.resolve();
    }
    if (this.#inFlight !== null) {
      return this.#inFlight; // never overlap — the running round covers this material
    }
    if (this.#turns.length === 0 || this.#wordsSinceRound === 0) {
      return Promise.resolve();
    }
    const nowMs = this.#clock();
    if (this.#lastRoundAtMs !== null && nowMs - this.#lastRoundAtMs < this.#minRoundIntervalMs) {
      return Promise.resolve();
    }
    return this.#launchRound(nowMs, { trigger: "periodic", maxNew: PERIODIC_MAX_NEW_QUESTS });
  }

  // Launch one suggestion round NOW (callers own the gates). `maxNew` caps how
  // many NEW quests the round may surface — refinements of existing quests are
  // never capped.
  #launchRound(nowMs: number, options: { trigger?: "periodic"; maxNew?: number }): Promise<void> {
    this.#lastRoundAtMs = nowMs;
    this.#wordsSinceRound = 0;
    this.#round += 1;
    const correlationId = `corr-research-round-${this.#round}`;
    const maxNew = options.maxNew ?? Number.POSITIVE_INFINITY;
    // Round visibility: the start + result (even an EMPTY one) are traced and
    // the ledger republishes so the wall can show "scanning…" — an inference
    // round that finds nothing must read as a shrug, never as a dead feature.
    this.#trace("research.suggest.round", "info", correlationId, {
      round: this.#round,
      turns: this.#turns.length,
      ...(options.trigger !== undefined ? { trigger: options.trigger } : {}),
    });
    const run = this.#suggester
      .suggest({
        sessionId: this.#sessionId,
        correlationId,
        turns: [...this.#turns],
        known: [...this.#quests.values()]
          .filter((quest) => quest.status === "proposed" || quest.status === "researching")
          .map((quest) => ({ id: quest.id, kind: quest.kind, topic: quest.topic, claim: quest.claim })),
        // Concept structure so the model reasons per topic, not per fragment.
        topics: this.#tree.topics().map((topic) => ({ label: topic.label, turnIds: [...topic.turnIds] })),
      })
      .then((suggestions) => {
        if (suggestions.length === 0) {
          this.#trace("research.suggest.empty", "info", correlationId, { round: this.#round });
        }
        // A capped round spends its new-sphere budget on the strongest material.
        const ordered = Number.isFinite(maxNew)
          ? [...suggestions].sort((a, b) => b.confidence - a.confidence)
          : suggestions;
        this.#reconcile(ordered, this.#clock(), correlationId, maxNew);
      })
      .catch((error) => {
        this.#trace("research.suggest.error", "error", correlationId, {
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.#inFlight = null;
        this.#emit();
        // Words that arrived DURING the round were never evaluated — re-arm so
        // the tail of an utterance can't silently miss its round forever.
        if (this.#active && this.#wordsSinceRound >= this.#newWordsThreshold) {
          void this.maybeSuggest();
        }
      });
    this.#inFlight = run;
    this.#emit();
    return run;
  }

  // True while a suggestion round's inference is in flight (the wall's
  // "scanning the conversation" indicator).
  thinking(): boolean {
    return this.#inFlight !== null;
  }

  async flush(): Promise<void> {
    while (this.#inFlight !== null) {
      await this.#inFlight;
    }
  }

  #reconcile(
    suggestions: ResearchSuggestion[],
    nowMs: number,
    correlationId: string,
    maxNew = Number.POSITIVE_INFINITY,
  ): void {
    const seen = new Set<string>();
    let changed = false;
    let created = 0;
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
      // PRECISION GUARDS (each traced so pruning is observable in the rail).
      // 1. Grounding: the quoted evidence must actually exist in the window —
      //    an inference proposal about something nobody said never surfaces.
      if (!this.#isGrounded(suggestion.contextSpan.quote)) {
        this.#trace("research.suggest.ungrounded", "info", correlationId, {
          topic: suggestion.topic,
          quote: suggestion.contextSpan.quote.slice(0, 80),
        });
        continue;
      }
      // 2. Confidence floor: weak hunches don't earn crystals.
      if (clamp01(suggestion.confidence) < MIN_SURFACING_CONFIDENCE) {
        this.#trace("research.suggest.lowconf", "info", correlationId, {
          topic: suggestion.topic,
          confidence: suggestion.confidence,
        });
        continue;
      }
      // 3. Near-dupe: a claim that substantially overlaps an existing quest
      //    updates that quest (proposed) or is a no-op (committed) — the wall
      //    never grows two crystals for one thought.
      const dupe = this.#nearDupe(suggestion.claim);
      if (dupe !== null) {
        if (dupe.status === "proposed") {
          dupe.confidence = Math.max(dupe.confidence, clamp01(suggestion.confidence));
          dupe.roundsSeen += 1;
          dupe.missedRounds = 0;
          dupe.updatedAtMs = nowMs;
          changed = true;
        }
        seen.add(dupe.id);
        this.#trace("research.suggest.dupe", "info", correlationId, { id: dupe.id, topic: suggestion.topic });
        continue;
      }
      if (this.#proposedCount() >= this.#maxProposed) {
        continue;
      }
      // 4. Round budget: past maxNew (periodic rounds: one) a fresh proposal
      //    waits for a future round instead of surfacing now.
      if (created >= maxNew) {
        continue;
      }
      const grounding = this.#contextForTurn(suggestion.contextSpan.endTurnId);
      const quest: ResearchQuest = {
        id: `rq-${this.#idFactory()}`,
        kind: suggestion.kind,
        topic: suggestion.topic,
        claim: suggestion.claim,
        rationale: suggestion.rationale,
        confidence: clamp01(suggestion.confidence),
        contextSpan: { ...suggestion.contextSpan },
        contextTurns: grounding.contextTurns,
        topicLabel: grounding.topicLabel,
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
      created += 1;
      changed = true;
      this.#trace("research.suggest.new", "info", correlationId, {
        id: quest.id,
        kind: quest.kind,
        topic: quest.topic,
        confidence: quest.confidence,
      });
    }
    // Stale pruning: only PROPOSED quests decay; committed work persists.
    // Weak proposals (below WEAK_CONFIDENCE) die faster — a hunch the model
    // stops re-detecting was probably noise, not a slow-burning thread.
    for (const quest of this.#quests.values()) {
      if (quest.status !== "proposed" || seen.has(quest.id)) {
        continue;
      }
      quest.missedRounds += 1;
      const staleAfter = quest.confidence < WEAK_CONFIDENCE ? WEAK_STALE_MISSED_ROUNDS : this.#staleMissedRounds;
      if (quest.missedRounds >= staleAfter) {
        this.#quests.delete(quest.id);
        changed = true;
        this.#trace("research.suggest.stale", "info", correlationId, { id: quest.id, topic: quest.topic });
      }
    }
    if (changed) {
      this.#emit();
    }
  }

  // TOPIC CONTEXT for a quest: the grounding turn's concept branch — its
  // inferred label plus the member turns verbatim (newest-biased, capped so
  // agent prompts stay bounded). Null label + lone turn when unclustered.
  #contextForTurn(turnId: string): { contextTurns: { id: string; speaker: string | null; text: string }[]; topicLabel: string | null } {
    const topic = this.#tree.topics().find((candidate) => candidate.turnIds.includes(turnId));
    const memberIds = new Set(topic?.turnIds ?? [turnId]);
    const members = this.#turns.filter((turn) => memberIds.has(turn.id));
    // Newest-biased cap: keep the freshest CONTEXT_MAX_TURNS, chronological.
    const capped = members.slice(-CONTEXT_MAX_TURNS);
    let budget = CONTEXT_MAX_CHARS;
    const contextTurns: { id: string; speaker: string | null; text: string }[] = [];
    for (let index = capped.length - 1; index >= 0 && budget > 0; index -= 1) {
      const turn = capped[index]!;
      const text = turn.text.slice(0, Math.max(0, budget));
      budget -= text.length;
      contextTurns.unshift({ id: turn.id, speaker: turn.speaker, text });
    }
    return { contextTurns, topicLabel: topic?.label ?? null };
  }

  // A quote is grounded when it (normalized) appears inside some window turn,
  // or shares at least half its content tokens with one — tolerant of the
  // model lightly paraphrasing while quoting, fatal to invented material.
  #isGrounded(quote: string): boolean {
    const normQuote = normalizeForMatch(quote);
    if (normQuote.length === 0) {
      return false;
    }
    const quoteTokens = tokenSet(normQuote);
    for (const turn of this.#turns) {
      const normTurn = normalizeForMatch(turn.text);
      if (normTurn.includes(normQuote)) {
        return true;
      }
      if (quoteTokens.size > 0) {
        let shared = 0;
        for (const token of tokenSet(normTurn)) {
          if (quoteTokens.has(token)) {
            shared += 1;
          }
        }
        if (shared / quoteTokens.size >= 0.5) {
          return true;
        }
      }
    }
    return false;
  }

  // Token-Jaccard near-duplicate of an existing quest's claim, any status.
  #nearDupe(claim: string): ResearchQuest | null {
    const tokens = tokenSet(normalizeForMatch(claim));
    if (tokens.size === 0) {
      return null;
    }
    for (const quest of this.#quests.values()) {
      const other = tokenSet(normalizeForMatch(quest.claim));
      if (other.size === 0) {
        continue;
      }
      let shared = 0;
      for (const token of tokens) {
        if (other.has(token)) {
          shared += 1;
        }
      }
      const union = tokens.size + other.size - shared;
      if (union > 0 && shared / union >= NEAR_DUPE_JACCARD) {
        return quest;
      }
    }
    return null;
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
        // Progressive disclosure: the synthesized draft shows on the wall
        // while the fact-check + bias passes still run.
        onDraft: (draft) => {
          if (this.#quests.get(id) !== quest || quest.status !== "researching") {
            return;
          }
          quest.report = draft;
          quest.reportDraft = true;
          quest.updatedAtMs = this.#clock();
          this.#trace("research.draft", "info", correlationId, { id, findings: draft.findings.length });
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
        quest.reportDraft = false;
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
    // INFERENCE-ONLY policy: no heuristic classification even here — a direct
    // click is explicit human intent, so the quest spawns as a deep-dive over
    // the VERBATIM utterance (quoting the room, not inferring about it); the
    // research agent's own inference decides what the material really is.
    const suggestion: ResearchSuggestion = {
      matchId: null,
      kind: "deep-dive",
      topic: topicWords.charAt(0).toUpperCase() + topicWords.slice(1),
      claim: text.slice(0, 280),
      rationale: "Asked directly from the wall.",
      confidence: 0.8,
      contextSpan: { startTurnId: turn.id, endTurnId: turn.id, quote: text.slice(0, 180) },
    };
    const nowMs = this.#clock();
    // The click's real power: the whole concept branch rides along, so a tap
    // on a turn (or a branch-tip label routing its freshest turn) researches
    // the THREAD, not one fragment. Topic label upgrades the crystal's title.
    const grounding = this.#contextForTurn(turn.id);
    const quest: ResearchQuest = {
      id: `rq-${this.#idFactory()}`,
      kind: suggestion.kind,
      topic: grounding.topicLabel ?? suggestion.topic,
      claim: suggestion.claim,
      rationale: suggestion.rationale,
      confidence: clamp01(Math.max(suggestion.confidence, 0.75)),
      contextSpan: { ...suggestion.contextSpan },
      contextTurns: grounding.contextTurns,
      topicLabel: grounding.topicLabel,
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
  // FOLLOW-UP spawn: one of a completed dossier's open questions, clicked on
  // the wall. The child inherits the parent's grounding (span + topic
  // context) so its crystal buds beside the parent, and starts researching
  // immediately. Near-dupe claims re-use the existing quest.
  researchFollowUp(
    parentId: string,
    index: number,
    correlationId = `corr-research-followup-${parentId}-${index}`,
  ): ResearchQuest | null {
    if (!this.#active) {
      return null;
    }
    const parent = this.#quests.get(parentId);
    const followUp = parent?.report?.followUps[index]?.trim();
    if (parent === undefined || followUp === undefined || followUp.length === 0) {
      return null;
    }
    const existing = this.#nearDupe(followUp);
    if (existing !== null) {
      return existing.status === "proposed" ? this.accept(existing.id, correlationId) : existing;
    }
    const topicWords = followUp.split(/\s+/u).slice(0, 8).join(" ");
    const nowMs = this.#clock();
    const quest: ResearchQuest = {
      id: `rq-${this.#idFactory()}`,
      kind: "deep-dive",
      topic: topicWords.charAt(0).toUpperCase() + topicWords.slice(1),
      claim: followUp.slice(0, 280),
      rationale: `Follow-up from "${parent.topic}".`,
      confidence: 0.7,
      contextSpan: { ...parent.contextSpan },
      contextTurns: parent.contextTurns === undefined ? undefined : [...parent.contextTurns],
      topicLabel: parent.topicLabel ?? null,
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
    this.#trace("research.followup.spawn", "info", correlationId, {
      id: quest.id,
      parentId,
      followUp: followUp.slice(0, 80),
    });
    return this.accept(quest.id, correlationId);
  }

  // RESEARCH-TREE RESET (the wall's 🌱 button): a full clean slate — every
  // in-flight agent aborted, every quest (proposed AND committed) dropped, the
  // dialogue window and concept topics cleared. Deliberately total: the user
  // asked to reset the research tree specifically, dossiers included.
  resetAll(correlationId = "corr-research-reset"): void {
    for (const [, running] of this.#running) {
      running.controller.abort();
    }
    const dropped = this.#quests.size;
    this.#running.clear();
    this.#quests.clear();
    this.#suppressed.clear();
    this.#turns = [];
    this.#newestFragmentAtMs = Number.NEGATIVE_INFINITY;
    this.#wordsSinceRound = 0;
    this.#tree.reset();
    this.#trace("research.tree.reset", "info", correlationId, { dropped });
    this.#emit();
  }

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

// VIBERSYN_RESEARCH_SUGGEST_INTERVAL_MS — the periodic dialogue-review
// cadence while research mode is on, default 60000; 0 disables the timer
// (rounds then fire only on ingest/force). A LOOP cadence knob, so it is read
// here rather than in the suggester's env table.
export function readResearchSuggestIntervalMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.VIBERSYN_RESEARCH_SUGGEST_INTERVAL_MS?.trim();
  if (raw === undefined || raw === "") {
    return DEFAULT_SUGGEST_INTERVAL_MS;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("VIBERSYN_RESEARCH_SUGGEST_INTERVAL_MS must be a non-negative number.");
  }
  return value;
}

function countWords(text: string): number {
  return text.split(/\s+/u).filter((word) => word.length > 0).length;
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

// Shared text normalization for the precision guards: lowercase, strip
// punctuation, collapse whitespace — so grounding/dupe checks compare words,
// not formatting.
function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function tokenSet(normalized: string): Set<string> {
  return new Set(normalized.split(" ").filter((token) => token.length > 2));
}
