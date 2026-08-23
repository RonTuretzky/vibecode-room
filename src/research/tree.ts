// Concept clustering over the research loop's dialogue window — the server
// half of "stop making a ball for every few words". Turns are grouped into
// labeled CONCEPT TOPICS; each topic is a BRANCH of the 3D conversation tree
// and turns reference their topic via topicId in the snapshot. Two layers:
//
//   1. A synchronous token-overlap HEURISTIC so every turn lands on a branch
//      the instant it arrives (normalized content words vs each topic's
//      accumulated keyword bag).
//   2. A debounced, never-overlapping model REFINEMENT: ONE bounded Cerebras
//      call that regroups + relabels the clusters once the window settles.
//
// The model layer mirrors the import-plan conventions exactly (bounded budget,
// tolerant JSON parse, deterministic fallback, never throws): on ANY miss —
// no key, HTTP error, timeout, malformed output — the heuristic clustering
// simply stands.

import type { TranscriptTurn } from "../detect/types";
import { composeAgentRunner, unwrapAgentReply } from "./standin";

// The snapshot-facing topic shape (ProjectorSnapshot.dialogueTopics).
export interface ConceptTopic {
  id: string;
  label: string;
  turnIds: string[];
  freshAtMs: number;
}

// What the refinement model sees: the current heuristic clusters (with member
// turn texts) plus the recent turns in spoken order for conversational context.
export interface TopicRefineRequest {
  topics: Array<{ id: string; label: string; turns: Array<{ id: string; text: string }> }>;
  recentTurns: Array<{ id: string; text: string }>;
}

// The model seam: return the raw completion (ideally strict JSON — the tree
// owns the tolerant parse), or null on any miss. Injectable so refinement is
// unit-testable without a network.
export type TopicModelRunner = (request: TopicRefineRequest, signal: AbortSignal) => Promise<unknown>;

export interface ConceptTreeOptions {
  // Refinement model. Omitted → the production Cerebras refiner (which is a
  // no-op without CEREBRAS_API_KEY); explicit null → heuristic-only (tests/CI).
  model?: TopicModelRunner | null;
  // Fired after a refinement actually changed the clustering, so the owner can
  // republish the snapshot.
  onRefined?: () => void;
  // Quiet period after the last cluster change before a refinement runs.
  debounceMs?: number;
  // Model budget; past it the heuristic clustering stands.
  timeoutMs?: number;
  // Fraction of a turn's distinct content words a topic's bag must already
  // cover for the turn to join it.
  joinThreshold?: number;
  maxLabelWords?: number;
}

const DEFAULT_DEBOUNCE_MS = 4_000;
// Covers a fast-failing Cerebras call plus the host-claude stand-in's cold CLI
// boot (~14s measured; standin.ts STANDIN_TIMEOUT_MS 25s). Refinements never
// overlap (#inFlight) and re-debounce, so a slow rescue only delays, never
// stacks.
const DEFAULT_TIMEOUT_MS = 30_000;
// ~A third of the turn's vocabulary already in the topic → same concept. Below
// that, a new branch is honest — the refinement pass can always re-merge.
// 0.30, NOT 0.34: a 3-distinct-token related sentence sharing 1 token scores
// 0.3333 and missed the old bar by 0.007 (live-room evidence — "instruction
// manual" class fragments founding orphan topics).
const DEFAULT_JOIN_THRESHOLD = 0.3;
const DEFAULT_MAX_LABEL_WORDS = 4;
const MAX_LABEL_CHARS = 60;
const RECENT_TURNS_FOR_MODEL = 12;

interface TopicState {
  id: string;
  label: string;
  seq: number; // creation order — the ordering tie-break when firstAtMs ties
  members: string[]; // turn ids, arrival order
  bag: Map<string, number>; // content word → occurrence count across members
  firstAtMs: number;
  freshAtMs: number;
}

interface TurnInfo {
  tokens: string[];
  text: string;
  atMs: number;
  // Null = the DUST POOL: a babble turn (contentWorthiness "dust") that never
  // founds or joins a topic. Re-evaluated on coalesce growth — a fragment
  // whose sentence completes promotes to a real branch.
  topicId: string | null;
}

export class ConceptTree {
  readonly #model: TopicModelRunner | null;
  readonly #onRefined?: () => void;
  readonly #debounceMs: number;
  readonly #timeoutMs: number;
  readonly #joinThreshold: number;
  readonly #maxLabelWords: number;

  readonly #topics = new Map<string, TopicState>();
  readonly #turnInfo = new Map<string, TurnInfo>();
  #topicSeq = 0;
  #refineTimer: ReturnType<typeof setTimeout> | null = null;
  #inFlight: Promise<void> | null = null;
  #pendingRefine = false;
  // LOUDNESS: consecutive refiner misses + the last reason (reset the moment a
  // refinement's model reply actually arrives).
  #missStreak = 0;
  #lastMissReason: string | null = null;

  constructor(options: ConceptTreeOptions = {}) {
    this.#model = options.model === undefined ? defaultTopicModel : options.model;
    this.#onRefined = options.onRefined;
    this.#debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#joinThreshold = options.joinThreshold ?? DEFAULT_JOIN_THRESHOLD;
    this.#maxLabelWords = options.maxLabelWords ?? DEFAULT_MAX_LABEL_WORDS;
  }

  // ── heuristic clustering ──────────────────────────────────────────────────

  // Place a NEW turn on a branch synchronously. Returns the topic id, or null
  // when the turn is babble (the dust pool — never a branch of its own).
  assign(turn: TranscriptTurn): string | null {
    if (this.#turnInfo.has(turn.id)) {
      return this.update(turn);
    }
    const target = this.#place(turn.id, turn.text, turn.atMs);
    this.#scheduleRefine();
    return target?.id ?? null;
  }

  // A turn's text GREW in place (fragment coalescing) — re-score it. The turn
  // is scored WITHOUT its own old contribution to its topic's bag, otherwise a
  // turn would stick to the topic it founded no matter what it grew into. When
  // nothing clears the bar it STAYS put: topic ids must not churn on every
  // coalesced fragment. A DUST turn re-runs the worthiness gate on its grown
  // text: completing the sentence promotes it onto a real branch.
  update(turn: TranscriptTurn): string | null {
    const info = this.#turnInfo.get(turn.id);
    if (info === undefined) {
      return this.assign(turn);
    }
    if (info.topicId === null) {
      // Dust so far. Judge the WHOLE merged utterance: still dust → stay in
      // the pool (updated text); content now → place like a fresh arrival.
      if (contentWorthiness(turn.text) === "dust") {
        info.tokens = matchTokens(turn.text);
        info.text = turn.text;
        info.atMs = turn.atMs;
        return null;
      }
      this.#turnInfo.delete(turn.id);
      const target = this.#place(turn.id, turn.text, turn.atMs);
      this.#scheduleRefine();
      return target?.id ?? null;
    }
    const oldTopic = this.#topics.get(info.topicId);
    const tokens = matchTokens(turn.text);
    if (oldTopic !== undefined) {
      subtractBag(oldTopic.bag, info.tokens);
    }
    const target = this.#bestTopic(tokens) ?? oldTopic ?? this.#createTopic(turn.text);
    if (oldTopic !== undefined && target.id !== oldTopic.id) {
      oldTopic.members = oldTopic.members.filter((member) => member !== turn.id);
      if (oldTopic.members.length === 0) {
        this.#topics.delete(oldTopic.id);
      } else {
        this.#recalc(oldTopic);
      }
      target.members.push(turn.id);
    } else if (oldTopic === undefined) {
      target.members.push(turn.id);
    }
    addBag(target.bag, tokens);
    info.tokens = tokens;
    info.text = turn.text;
    info.atMs = turn.atMs;
    info.topicId = target.id;
    this.#recalc(target);
    this.#scheduleRefine();
    return target.id;
  }

  // Full clean slate (the wall's research-tree reset): drop every topic and
  // turn assignment and cancel any pending refinement — a fresh conversation
  // must not inherit the old one's debounce or clusters.
  reset(): void {
    this.#topics.clear();
    this.#turnInfo.clear();
    this.#pendingRefine = false;
    if (this.#refineTimer !== null) {
      clearTimeout(this.#refineTimer);
      this.#refineTimer = null;
    }
  }

  // The loop's rolling window dropped turns — forget them (and any topic left
  // empty), so branches never outlive the dialogue they clustered.
  prune(liveTurnIds: Iterable<string>): void {
    const keep = new Set(liveTurnIds);
    let changed = false;
    for (const [turnId, info] of [...this.#turnInfo]) {
      if (keep.has(turnId)) {
        continue;
      }
      const topic = info.topicId !== null ? this.#topics.get(info.topicId) : undefined;
      if (topic !== undefined) {
        subtractBag(topic.bag, info.tokens);
        topic.members = topic.members.filter((member) => member !== turnId);
        if (topic.members.length === 0) {
          this.#topics.delete(topic.id);
        } else {
          this.#recalc(topic);
        }
      }
      this.#turnInfo.delete(turnId);
      changed = true;
    }
    if (changed) {
      this.#scheduleRefine();
    }
  }

  // ── reads ─────────────────────────────────────────────────────────────────

  // Oldest-first (branch height order); freshAtMs = newest member turn's atMs.
  topics(): ConceptTopic[] {
    return [...this.#topics.values()]
      .sort((a, b) => (a.firstAtMs !== b.firstAtMs ? a.firstAtMs - b.firstAtMs : a.seq - b.seq))
      .map((topic) => ({
        id: topic.id,
        label: topic.label,
        turnIds: [...topic.members].sort((a, b) => {
          const delta = (this.#turnInfo.get(a)?.atMs ?? 0) - (this.#turnInfo.get(b)?.atMs ?? 0);
          return delta !== 0 ? delta : a.localeCompare(b);
        }),
        freshAtMs: topic.freshAtMs,
      }));
  }

  topicOf(turnId: string): string | null {
    return this.#turnInfo.get(turnId)?.topicId ?? null;
  }

  // The DUST POOL: windowed babble turns that belong to no topic. They stay in
  // the transcript/window (never deleted) — they just never found or name a
  // branch. The sky folds their retirements into its dust ledger.
  dustTurnIds(): string[] {
    const ids: string[] = [];
    for (const [turnId, info] of this.#turnInfo) {
      if (info.topicId === null) {
        ids.push(turnId);
      }
    }
    return ids;
  }

  // The refiner's failure surface (mirrors CloudGraph.agentHealth): /api/health
  // degrades on a persistent miss streak — the 402 can never be silent here
  // either.
  agentHealth(): { missStreak: number; lastMissReason: string | null } {
    return { missStreak: this.#missStreak, lastMissReason: this.#lastMissReason };
  }

  // ── model refinement ──────────────────────────────────────────────────────

  // Run the refinement NOW (the debounce timer's target; tests call it
  // directly). Never overlapping: a call while one is in flight marks a
  // pending pass that re-debounces after the current one settles.
  refineNow(): Promise<void> {
    if (this.#model === null) {
      return Promise.resolve();
    }
    if (this.#inFlight !== null) {
      this.#pendingRefine = true;
      return this.#inFlight;
    }
    const run = this.#runRefine()
      .catch(() => undefined) // the refiner never throws — belt and suspenders
      .finally(() => {
        this.#inFlight = null;
        if (this.#pendingRefine) {
          this.#pendingRefine = false;
          this.#scheduleRefine();
        }
      });
    this.#inFlight = run;
    return run;
  }

  // Await any in-flight refinement (tests).
  async settle(): Promise<void> {
    while (this.#inFlight !== null) {
      await this.#inFlight;
    }
  }

  dispose(): void {
    if (this.#refineTimer !== null) {
      clearTimeout(this.#refineTimer);
      this.#refineTimer = null;
    }
  }

  // ── internals ─────────────────────────────────────────────────────────────

  #place(turnId: string, text: string, atMs: number): TopicState | null {
    const tokens = matchTokens(text);
    // THE BABBLE GATE: backchannel/filler ("yep", "like twelve percent
    // battery", lone fragments) goes to the DUST POOL — present in the window,
    // never founding or joining a topic, never named. It is re-judged whole if
    // coalesce growth completes the sentence (update() promotes it).
    if (contentWorthiness(text) === "dust") {
      this.#turnInfo.set(turnId, { tokens, text, atMs, topicId: null });
      return null;
    }
    const target = this.#bestTopic(tokens) ?? this.#createTopic(text);
    target.members.push(turnId);
    addBag(target.bag, tokens);
    this.#turnInfo.set(turnId, { tokens, text, atMs, topicId: target.id });
    this.#recalc(target);
    return target;
  }

  #bestTopic(tokens: readonly string[]): TopicState | null {
    if (tokens.length === 0) {
      return null;
    }
    const distinct = new Set(tokens);
    let best: TopicState | null = null;
    let bestScore = 0;
    for (const topic of this.#topics.values()) {
      let shared = 0;
      for (const token of distinct) {
        if (topic.bag.has(token)) {
          shared += 1;
        }
      }
      const score = shared / distinct.size;
      if (score > bestScore || (score === bestScore && score > 0 && best !== null && topic.freshAtMs > best.freshAtMs)) {
        best = topic;
        bestScore = score;
      }
    }
    return bestScore >= this.#joinThreshold ? best : null;
  }

  #freshestTopic(): TopicState | null {
    let freshest: TopicState | null = null;
    for (const topic of this.#topics.values()) {
      if (freshest === null || topic.freshAtMs > freshest.freshAtMs) {
        freshest = topic;
      }
    }
    return freshest;
  }

  #createTopic(foundingText: string): TopicState {
    this.#topicSeq += 1;
    const topic: TopicState = {
      id: `topic-${String(this.#topicSeq).padStart(4, "0")}`,
      label: this.#provisionalLabel(foundingText),
      seq: this.#topicSeq,
      members: [],
      bag: new Map(),
      firstAtMs: 0,
      freshAtMs: 0,
    };
    this.#topics.set(topic.id, topic);
    return topic;
  }

  // Provisional label: the founding turn's first ~4 content words. The model
  // refinement replaces it with a real title when it lands.
  #provisionalLabel(text: string): string {
    const tokens = contentTokens(text);
    const source = tokens.length > 0 ? tokens : text.trim().split(/\s+/u);
    return clampLabel(source.slice(0, this.#maxLabelWords).join(" "), this.#maxLabelWords) ?? "Topic";
  }

  #recalc(topic: TopicState): void {
    let first = Number.POSITIVE_INFINITY;
    let fresh = Number.NEGATIVE_INFINITY;
    for (const member of topic.members) {
      const atMs = this.#turnInfo.get(member)?.atMs;
      if (atMs === undefined) {
        continue;
      }
      first = Math.min(first, atMs);
      fresh = Math.max(fresh, atMs);
    }
    topic.firstAtMs = Number.isFinite(first) ? first : 0;
    topic.freshAtMs = Number.isFinite(fresh) ? fresh : 0;
  }

  #scheduleRefine(): void {
    if (this.#model === null) {
      return;
    }
    if (this.#refineTimer !== null) {
      clearTimeout(this.#refineTimer);
    }
    const timer = setTimeout(() => {
      this.#refineTimer = null;
      void this.refineNow();
    }, this.#debounceMs);
    // A pending refinement must never keep the process alive.
    (timer as unknown as { unref?: () => void }).unref?.();
    this.#refineTimer = timer;
  }

  async #runRefine(): Promise<void> {
    const model = this.#model;
    if (model === null || this.#turnInfo.size === 0) {
      return;
    }
    const snapshot = this.topics().map((topic) => ({
      id: topic.id,
      label: topic.label,
      turns: topic.turnIds.map((turnId) => ({ id: turnId, text: this.#turnInfo.get(turnId)?.text ?? "" })),
    }));
    const snapshotIds = new Set(snapshot.flatMap((topic) => topic.turns.map((turn) => turn.id)));
    const recentTurns = [...this.#turnInfo.entries()]
      .sort((a, b) => a[1].atMs - b[1].atMs)
      .slice(-RECENT_TURNS_FOR_MODEL)
      .map(([id, info]) => ({ id, text: info.text }));
    const outcome = await this.#boundedCall(model, { topics: snapshot, recentTurns });
    if ("miss" in outcome) {
      // Model miss — the heuristic clustering stands, and the REASON is kept:
      // /api/health degrades on a persistent streak (the refiner hits the
      // same Cerebras account as the sky relate).
      this.#missStreak += 1;
      this.#lastMissReason = outcome.miss;
      // RETRY (bounded): a REAL failure re-debounces so a quiet room still
      // crosses the health threshold instead of stalling below it forever.
      // Capped at twice the degraded streak — past that the leg is already
      // loud and new material is the only honest reason to call again.
      // "no-key" never retries: the deliberate no-agent config must not churn.
      if (outcome.miss !== "no-key" && this.#missStreak < 6) {
        this.#scheduleRefine();
      }
      return;
    }
    this.#missStreak = 0;
    this.#lastMissReason = null;
    // Unwrap transport provenance (standin.ts) — the reply may have come from
    // the host-claude stand-in when the Cerebras account is failing; the
    // clustering parse below only ever sees the model's raw reply.
    if (this.#applyModelClustering(unwrapAgentReply(outcome.value).reply, snapshotIds)) {
      this.#onRefined?.();
    }
  }

  // Race the model against the budget; any rejection, timeout, or abort
  // resolves to a miss sentinel CARRYING ITS REASON so the heuristic
  // clustering stands and the failure is never indistinguishable from "fine".
  async #boundedCall(
    model: TopicModelRunner,
    request: TopicRefineRequest,
  ): Promise<{ value: unknown } | { miss: string }> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<{ miss: string }>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ miss: "timeout" });
      }, this.#timeoutMs);
    });
    try {
      return await Promise.race([
        model(request, controller.signal).then(
          (value): { value: unknown } | { miss: string } =>
            value === null || value === undefined ? { miss: "no-key" } : { value },
          (error): { miss: string } => ({ miss: error instanceof Error ? error.message : String(error) }),
        ),
        timeout,
      ]);
    } finally {
      if (timer !== null) {
        clearTimeout(timer);
      }
    }
  }

  // Apply the model's clustering as the new truth — but only when it is a
  // PERFECT partition of the turns it was shown (every snapshot turnId exactly
  // once, nothing unknown). Anything less is dropped wholesale: a half-applied
  // regroup would strand turns off the tree. Topic ids stay stable across
  // refinements by majority member overlap with the existing clusters.
  #applyModelClustering(raw: unknown, snapshotIds: ReadonlySet<string>): boolean {
    const value = typeof raw === "string" ? parseLooseJson(raw) : raw;
    const list = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.topics) ? value.topics : null;
    if (list === null) {
      return false;
    }
    const entries: Array<{ id: string | null; label: string; turnIds: string[] }> = [];
    const covered = new Set<string>();
    for (const item of list) {
      if (!isRecord(item)) {
        return false;
      }
      const id = typeof item.id === "string" && item.id.trim().length > 0 ? item.id.trim() : null;
      const label = typeof item.label === "string" ? item.label : "";
      const turnIdsRaw = item.turnIds ?? item.turn_ids ?? item.turns;
      if (!Array.isArray(turnIdsRaw)) {
        return false;
      }
      const turnIds: string[] = [];
      for (const entry of turnIdsRaw) {
        const turnId = typeof entry === "string" ? entry : isRecord(entry) && typeof entry.id === "string" ? entry.id : null;
        if (turnId === null || !snapshotIds.has(turnId) || covered.has(turnId)) {
          return false; // unknown or duplicated turn — wholesale drop
        }
        covered.add(turnId);
        turnIds.push(turnId);
      }
      if (turnIds.length > 0) {
        entries.push({ id, label, turnIds });
      }
    }
    if (covered.size !== snapshotIds.size) {
      return false; // a turn went missing — wholesale drop
    }

    // Stable ids: pass 1 honors an id the model echoed back (if it still
    // overlaps that cluster); pass 2 matches by majority member overlap.
    const existing = [...this.#topics.values()];
    const claimed = new Set<string>();
    const assignedIds: Array<string | null> = entries.map(() => null);
    entries.forEach((entry, index) => {
      if (entry.id === null || claimed.has(entry.id)) {
        return;
      }
      const topic = this.#topics.get(entry.id);
      if (topic !== undefined && entry.turnIds.some((turnId) => topic.members.includes(turnId))) {
        assignedIds[index] = entry.id;
        claimed.add(entry.id);
      }
    });
    entries.forEach((entry, index) => {
      if (assignedIds[index] !== null) {
        return;
      }
      let best: TopicState | null = null;
      let bestShared = 0;
      for (const topic of existing) {
        if (claimed.has(topic.id)) {
          continue;
        }
        const shared = entry.turnIds.filter((turnId) => topic.members.includes(turnId)).length;
        if (shared > bestShared) {
          best = topic;
          bestShared = shared;
        }
      }
      if (best !== null && bestShared * 2 > best.members.length) {
        assignedIds[index] = best.id;
        claimed.add(best.id);
      }
    });

    // Rebuild. Turns that arrived while the model was thinking (not in the
    // snapshot) are re-placed heuristically against the refined clusters.
    const seqById = new Map(existing.map((topic) => [topic.id, topic.seq]));
    const strays = [...this.#turnInfo.keys()].filter((turnId) => !covered.has(turnId));
    this.#topics.clear();
    entries.forEach((entry, index) => {
      // The window may have dropped members mid-flight; an entry left empty
      // simply vanishes with them.
      const liveIds = entry.turnIds.filter((turnId) => this.#turnInfo.has(turnId));
      if (liveIds.length === 0) {
        return;
      }
      const matchedId = assignedIds[index] ?? null;
      let seq: number;
      if (matchedId !== null && seqById.has(matchedId)) {
        seq = seqById.get(matchedId)!;
      } else {
        this.#topicSeq += 1;
        seq = this.#topicSeq;
      }
      const id = matchedId ?? `topic-${String(seq).padStart(4, "0")}`;
      const firstInfo = this.#turnInfo.get(liveIds[0]!)!;
      const topic: TopicState = {
        id,
        label: clampLabel(entry.label, this.#maxLabelWords) ?? this.#provisionalLabel(firstInfo.text),
        seq,
        members: [],
        bag: new Map(),
        firstAtMs: 0,
        freshAtMs: 0,
      };
      this.#topics.set(id, topic);
      for (const turnId of [...liveIds].sort((a, b) => this.#turnInfo.get(a)!.atMs - this.#turnInfo.get(b)!.atMs)) {
        const info = this.#turnInfo.get(turnId)!;
        topic.members.push(turnId);
        addBag(topic.bag, info.tokens);
        info.topicId = id;
      }
      this.#recalc(topic);
    });
    for (const turnId of strays.sort((a, b) => this.#turnInfo.get(a)!.atMs - this.#turnInfo.get(b)!.atMs)) {
      const info = this.#turnInfo.get(turnId)!;
      this.#place(turnId, info.text, info.atMs);
    }
    return true;
  }
}

// ── text normalization ───────────────────────────────────────────────────────

// Function words + conversational filler that carry no concept signal. Local
// list on purpose (ledger.ts / project-name.ts keep their own too): each
// module's notion of "noise" is tuned to its job.
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "so", "then", "than",
  "that", "this", "these", "those", "there", "here",
  "i", "im", "me", "my", "mine", "we", "our", "us", "you", "your",
  "he", "she", "it", "its", "they", "them", "their",
  "is", "are", "was", "were", "be", "been", "being", "am",
  "do", "does", "did", "doing", "have", "has", "had", "having",
  "will", "would", "can", "could", "should", "shall", "may", "might", "must",
  "of", "to", "in", "on", "at", "by", "for", "with", "from", "into", "about",
  "over", "under", "up", "down", "out", "off", "as", "because",
  "not", "no", "yes", "yeah", "yep", "okay", "ok", "right", "sure",
  "just", "like", "really", "very", "kind", "kinda", "sort", "sorta",
  "what", "when", "where", "which", "who", "whom", "why", "how",
  "gonna", "wanna", "gotta", "uh", "um", "hmm", "huh", "oh", "well", "also", "too",
  "dont", "cant", "wont", "isnt", "arent", "wasnt", "werent", "didnt", "doesnt",
  "thats", "whats", "theres", "youre", "theyre", "ive", "weve", "youve",
  "ill", "youll", "itll", "lets", "get", "got", "one", "thing", "stuff",
]);

// Normalized content words: lowercase, punctuation stripped (apostrophes
// removed so "don't" folds into the stopword list), stopwords dropped.
// UNSTEMMED — labels are built from these, so they stay real words. Topic
// JOIN comparisons use matchTokens (stemmed) instead.
export function contentTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/'/gu, "")
    .replace(/[^a-z0-9\s]/gu, " ")
    .split(/\s+/u)
    .filter((word) => word.length >= 2 && !STOPWORDS.has(word));
}

// Minimal deterministic suffix stemmer for JOIN comparisons only: this ASR
// stream is caseless and punctuation-free, so token identity carries ALL the
// continuation signal — review/reviewed, pack/packs, figure/figured must not
// score zero overlap. Strip ing/ed/es/s, then a trailing e so "figured"
// (→figur) meets "figure" (→figur). Both sides of every comparison pass
// through the same stemmer, so truncated stems are consistent.
export function stemToken(token: string): string {
  let stem = token;
  if (stem.length >= 6 && stem.endsWith("ing")) {
    stem = stem.slice(0, -3);
  } else if (stem.length >= 5 && (stem.endsWith("ed") || stem.endsWith("es"))) {
    stem = stem.slice(0, -2);
  } else if (stem.length >= 4 && stem.endsWith("s") && !stem.endsWith("ss")) {
    stem = stem.slice(0, -1);
  }
  if (stem.length >= 5 && stem.endsWith("e")) {
    stem = stem.slice(0, -1);
  }
  return stem;
}

// Content tokens normalized for MATCHING (topic bags + join scores).
export function matchTokens(text: string): string[] {
  return contentTokens(text).map(stemToken);
}

// THE BABBLE GATE (deterministic, measured on real room data: flags 26/40 of
// a live window and 115/218 of a wall recording while keeping every
// substantive sentence). Dust = no content tokens at all, a lone content
// token in a short utterance ("yep", "teddy"), or a long utterance that is
// almost all filler ("like twelve percent battery" class). Runs on the WHOLE
// (post-coalesce) utterance — never deletes, only withholds topic founding.
export function contentWorthiness(text: string): "content" | "dust" {
  const words = text.trim().split(/\s+/u).filter((word) => word.length > 0);
  const tokens = contentTokens(text);
  const distinct = new Set(tokens);
  if (distinct.size === 0) {
    return "dust";
  }
  if (distinct.size === 1 && words.length <= 6) {
    return "dust";
  }
  if (words.length >= 6 && tokens.length / words.length < 0.2) {
    return "dust";
  }
  return "content";
}

function addBag(bag: Map<string, number>, tokens: readonly string[]): void {
  for (const token of tokens) {
    bag.set(token, (bag.get(token) ?? 0) + 1);
  }
}

function subtractBag(bag: Map<string, number>, tokens: readonly string[]): void {
  for (const token of tokens) {
    const count = bag.get(token);
    if (count === undefined) {
      continue;
    }
    if (count <= 1) {
      bag.delete(token);
    } else {
      bag.set(token, count - 1);
    }
  }
}

function clampLabel(raw: string, maxWords: number): string | null {
  const words = raw.replace(/\s+/gu, " ").trim().split(" ").filter((word) => word.length > 0);
  if (words.length === 0) {
    return null;
  }
  const label = words.slice(0, maxWords).join(" ").slice(0, MAX_LABEL_CHARS);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

// ── tolerant JSON (import-plan pattern) ──────────────────────────────────────

// Find the JSON payload inside a chatty completion: strip markdown fences, then
// try the outermost {...} span, then the outermost [...]. Null when nothing
// parses — the caller treats that as a model miss.
function parseLooseJson(text: string): unknown {
  const stripped = text.replace(/```[a-z]*\n?/giu, "").trim();
  for (const [open, close] of [
    ["{", "}"],
    ["[", "]"],
  ] as const) {
    const start = stripped.indexOf(open);
    const end = stripped.lastIndexOf(close);
    if (start === -1 || end <= start) {
      continue;
    }
    try {
      return JSON.parse(stripped.slice(start, end + 1));
    } catch {
      // Fall through to the next span shape.
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ── default model (one bounded Cerebras call) ────────────────────────────────

export const CEREBRAS_CHAT_URL = "https://api.cerebras.ai/v1/chat/completions";
// Matches the rest of the codebase (import-plan.ts, cue-cerebras.ts): default
// gemma-4-31b, overridable via CEREBRAS_MODEL.
export const CEREBRAS_TOPIC_MODEL = "gemma-4-31b";

const TOPIC_SYSTEM_PROMPT =
  "You cluster a live room conversation into concept topics for a 3D dialogue tree. Given the current clusters " +
  "(heuristic guesses) and the recent turns in spoken order, regroup the turns into coherent concept topics. " +
  "Keep an existing topic's id when your topic is substantially the same cluster; use null for a genuinely new " +
  "topic. EVERY input turn id must appear in EXACTLY one topic. Labels are concrete noun phrases of at most 4 " +
  'words. Reply with STRICT JSON only — {"topics":[{"id":"topic-0001 or null","label":"...","turnIds":["..."]}]} ' +
  "— no markdown, no prose.";

// Default production refiner: ONE Cerebras chat/completions call. Null ONLY
// when no key is configured; every real failure THROWS with its cause (HTTP
// status + body, payload shape) so the tree's bounded-call wrapper records the
// reason — the refiner hits the same account as the sky relate, so a 402 here
// must be just as loud.
export const cerebrasTopicRefiner: TopicModelRunner = async (request, signal) => {
  const apiKey = process.env.CEREBRAS_API_KEY;
  if (apiKey === undefined || apiKey.trim().length === 0) {
    return null;
  }
  const response = await fetch(CEREBRAS_CHAT_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: process.env.CEREBRAS_MODEL ?? CEREBRAS_TOPIC_MODEL,
      temperature: 0,
      max_completion_tokens: 600,
      messages: [
        { role: "system", content: TOPIC_SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify({ topics: request.topics, recentTurns: request.recentTurns }) },
      ],
    }),
    signal,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`cerebras ${response.status}: ${body.slice(0, 120)}`);
  }
  const payload: unknown = await response.json();
  if (!isRecord(payload) || !Array.isArray(payload.choices)) {
    throw new Error("cerebras payload: no choices array");
  }
  const first: unknown = payload.choices[0];
  if (!isRecord(first) || !isRecord(first.message) || typeof first.message.content !== "string") {
    throw new Error("cerebras payload: no message content");
  }
  return first.message.content;
};

// The PRODUCTION refiner (ROUND 2 root-cause fix, defaultCloudRelate twin):
// Cerebras first, the host's logged-in `claude` CLI standing in when the
// account fails — the refiner hits the same quota-dead account as the sky
// relate, so it gets the same rescue. No key stays a clean heuristic-only
// no-op. Mode rules: standin.ts (VIBERSYN_RESEARCH_LLM).
export const defaultTopicModel: TopicModelRunner = composeAgentRunner({
  primary: cerebrasTopicRefiner,
  promptFor: (request: TopicRefineRequest) =>
    `${TOPIC_SYSTEM_PROMPT}\n\n${JSON.stringify({ topics: request.topics, recentTurns: request.recentTurns })}`,
});
