// The CONVERSATION SKY's server half: a CloudGraph accumulator that remembers
// topics BEYOND the rolling 40-turn window, plus the recurrent async thread
// that relates clouds across time and topics. Nothing else in the research
// stack survives the window (ConceptTree.prune deletes emptied topics), so a
// ceiling that shows where the conversation has BEEN needs this fold-before-
// death layer: every turn the window drops is folded into its last-known
// cloud (turn count + token bag + speaker tally) before the tree forgets it.
//
// Two relation layers, mirroring tree.ts:
//
//   1. A deterministic LEXICAL linker (token-bag Jaccard + research-quest
//      bridges) that always works — the offline sky.
//   2. A recurrent, never-overlapping AGENT tick: ONE bounded Cerebras call
//      (the cerebrasTopicRefiner clone — deliberately NOT the smithers build
//      semaphore, which contends with live hero builds) that may merge dead
//      clouds, add cross-topic links with a reason, and condense cloud names.
//
// PROVENANCE IS PART OF THE CONTRACT: every link carries source "agent" or
// "lexical", and `agentAtMs` is null until the agent has actually spoken —
// the wall renders the two visibly differently (warm vs cool wisps), so the
// sky never passes fallback guesses off as model judgement.

import type { TranscriptTurn } from "../detect/types";
import { contentTokens, type ConceptTopic } from "./tree";

// ── snapshot shapes (the additive ProjectorSnapshot.sky field) ───────────────

export interface CloudLink {
  a: string;
  b: string;
  strength: number; // 0..1 — the wall maps this to wisp brightness
  reason: string;
  source: "agent" | "lexical";
}

export interface CloudSnapshotEntry {
  id: string; // founding topic id (topic-NNNN) — session-stable, never reused
  label: string;
  labelSource: "agent" | "topic";
  firstAtMs: number;
  freshAtMs: number;
  // Retired (window-dropped) + live member turns — the proof of memory beyond
  // the 40-turn window.
  turnCount: number;
  // The live ConceptTree topic backing this cloud, or null once the window
  // killed it (a memory cloud: still visible, nothing left to research).
  liveTopicId: string | null;
  dominantSpeaker: string | null;
}

export interface SkySnapshot {
  clouds: CloudSnapshotEntry[];
  links: CloudLink[];
  updatedAtMs: number;
  // HONESTY STAMP: the last time the agent tick actually landed. Null = the
  // agent has never spoken — every relation shown is deterministic fallback.
  agentAtMs: number | null;
}

// ── agent seam ───────────────────────────────────────────────────────────────

// What the relate model sees: the cloud graph (with capped sample turns), the
// links it would be overriding, live research quests, and the freshest window
// turns for conversational context. All real data the room actually has.
export interface CloudRelateRequest {
  clouds: Array<{
    id: string;
    label: string;
    turnCount: number;
    firstAtMs: number;
    freshAtMs: number;
    live: boolean;
    sampleTurns: Array<{ speaker: string | null; text: string }>;
  }>;
  currentLinks: Array<{ a: string; b: string; strength: number; source: "agent" | "lexical" }>;
  research: Array<{ questId: string; status: string; topic: string; cloudId: string | null }>;
  recentTurns: Array<{ id: string; speaker: string | null; text: string }>;
}

// Return the raw completion (ideally strict JSON — the graph owns the tolerant
// parse), or null on any miss. Injectable so the thread is unit-testable with
// no network; explicit null = fallback-only (lexical links still live).
export type CloudRelateRunner = (request: CloudRelateRequest, signal: AbortSignal) => Promise<unknown>;

// Live research quests projected into the graph (bridge links + model
// context). turnId is the quest's grounding turn (contextSpan end).
export interface CloudQuestRef {
  id: string;
  status: "proposed" | "researching" | "complete" | "failed";
  topic: string;
  claim: string;
  turnId: string;
}

// Same shape as ResearchTraceEvent (loop.ts) — declared locally so sky.ts
// never runtime-imports the loop that imports it.
export interface SkyTraceEvent {
  event: string;
  level: "debug" | "info" | "warn" | "error";
  correlationId: string;
  meta: Record<string, unknown>;
}

export interface CloudGraphOptions {
  // Relate model. Omitted → the production Cerebras runner (a clean no-op
  // without CEREBRAS_API_KEY); explicit null → lexical-only (tests/offline).
  runner?: CloudRelateRunner | null;
  clock?: () => number;
  // Recurrent tick cadence; 0 disables the timer (tests drive relateNow
  // manually — the loop.test.ts interval-0 idiom). VIBERSYN_SKY_INTERVAL_MS.
  intervalMs?: number;
  // Model budget per tick; past it the lexical sky stands.
  timeoutMs?: number;
  // Fired after an agent tick changed the graph, so the owner can republish.
  onUpdate?: () => void;
  onTrace?: (event: SkyTraceEvent) => void;
}

const DEFAULT_SKY_INTERVAL_MS = 60_000;
const DEFAULT_RELATE_TIMEOUT_MS = 8_000;
// Snapshot caps — the sky field must stay glanceable and SSE-cheap.
const MAX_CLOUDS = 24;
const MAX_SNAPSHOT_LINKS = 12;
const MAX_SAMPLES_PER_CLOUD = 4;
const MAX_SAMPLE_CHARS = 200;
const RECENT_TURNS_FOR_MODEL = 12;
// Persisted token bags are trimmed back to this many top tokens once they
// double it — a cloud remembers its vocabulary's shape, not every word ever.
const MAX_BAG_TOKENS = 48;
// Lexical linker: pairs below this token-Jaccard don't relate; at 0.5+ the
// pair is as related as lexical evidence can prove (strength 1).
const LEXICAL_JACCARD_FLOOR = 0.15;
const LEXICAL_JACCARD_CEIL = 0.5;
const MAX_LEXICAL_LINKS_PER_CLOUD = 2;
// Quest bridges: the claim's tokens must cover this fraction of a foreign
// cloud's bag match before the quest counts as evidence linking the two.
const BRIDGE_MATCH_FLOOR = 0.3;
const MAX_REASON_WORDS = 12;
const MAX_NAME_WORDS = 4;

interface CloudState {
  id: string;
  label: string; // the live/last ConceptTree label
  agentName: string | null; // agent condensation overlay (labelSource "agent")
  firstAtMs: number;
  freshAtMs: number;
  retiredTurnCount: number;
  liveTurnIds: Set<string>;
  liveTopicId: string | null;
  bag: Map<string, number>; // RETIRED members' content tokens
  speakerCounts: Map<string, number>; // retired members' speakers
  samples: Array<{ id: string; speaker: string | null; text: string }>; // freshest live, ≤4
}

interface LiveTurnState {
  cloudId: string;
  speaker: string | null;
  atMs: number;
  textLength: number; // re-tokenize only when coalesce growth changed the text
  tokens: string[];
}

export class CloudGraph {
  readonly #runner: CloudRelateRunner | null;
  readonly #clock: () => number;
  readonly #timeoutMs: number;
  readonly #onUpdate?: () => void;
  readonly #onTrace?: (event: SkyTraceEvent) => void;

  readonly #clouds = new Map<string, CloudState>();
  // turn id → the cloud it will retire into when the window drops it.
  readonly #liveTurns = new Map<string, LiveTurnState>();
  // quest id → grounding cloud, resolved while the turn is still live and
  // remembered after (quests outlive the window; their anchor cloud should too).
  readonly #questClouds = new Map<string, string>();
  #quests: CloudQuestRef[] = [];
  #recentTurns: Array<{ id: string; speaker: string | null; text: string }> = [];
  #agentLinks: CloudLink[] = [];
  #agentAtMs: number | null = null;
  #updatedAtMs = 0;

  // Dirty gates: lexical link memo + "is there anything new to tell the agent".
  #lexicalMemo: CloudLink[] | null = null;
  #agentDirty = false;
  #snapshotMemo: SkySnapshot | null = null;
  #inFlight: Promise<void> | null = null;
  #tick = 0;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: CloudGraphOptions = {}) {
    this.#runner = options.runner === undefined ? cerebrasCloudRelate : options.runner;
    this.#clock = options.clock ?? (() => Date.now());
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_RELATE_TIMEOUT_MS;
    this.#onUpdate = options.onUpdate;
    this.#onTrace = options.onTrace;
    const intervalMs = options.intervalMs ?? DEFAULT_SKY_INTERVAL_MS;
    // The sky is live data like turn ingest — the tick runs regardless of
    // research mode; the dirty gate makes an idle room free. Lexical-only
    // graphs (runner null) need no timer at all.
    if (intervalMs > 0 && this.#runner !== null) {
      const timer = setInterval(() => void this.relateNow(), intervalMs);
      // The recurrent tick must never keep the process alive on its own.
      (timer as { unref?: () => void }).unref?.();
      this.#timer = timer;
    }
  }

  dispose(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  // ── the accumulator (fold-before-death) ───────────────────────────────────

  // Synchronous, called by ResearchLoop after every tree assign/update+prune.
  // Order matters: retirement first (against the OLD membership), then the
  // live-topic upsert, so a turn dropped this very ingest still folds into the
  // cloud it last belonged to.
  observe(topics: ConceptTopic[], turns: readonly TranscriptTurn[], quests: CloudQuestRef[] = []): void {
    const nowMs = this.#clock();
    const windowIds = new Set(turns.map((turn) => turn.id));
    // 1. RETIRE: window-dropped turns fold into their last-known cloud — turn
    //    count, tokens, speaker — before their text is gone forever.
    for (const [turnId, live] of [...this.#liveTurns]) {
      if (windowIds.has(turnId)) {
        continue;
      }
      const cloud = this.#clouds.get(live.cloudId);
      if (cloud !== undefined) {
        cloud.retiredTurnCount += 1;
        addBag(cloud.bag, live.tokens);
        trimBag(cloud.bag);
        if (live.speaker !== null) {
          cloud.speakerCounts.set(live.speaker, (cloud.speakerCounts.get(live.speaker) ?? 0) + 1);
        }
        cloud.liveTurnIds.delete(turnId);
      }
      this.#liveTurns.delete(turnId);
    }
    // 2. UPSERT a cloud per live topic (cloud id = founding topic id — the
    //    tree's #topicSeq is session-monotonic, so ids are stable + unique).
    const byId = new Map(turns.map((turn) => [turn.id, turn]));
    const liveTopicIds = new Set<string>();
    for (const topic of topics) {
      liveTopicIds.add(topic.id);
      let cloud = this.#clouds.get(topic.id);
      if (cloud === undefined) {
        cloud = {
          id: topic.id,
          label: topic.label,
          agentName: null,
          firstAtMs: Number.POSITIVE_INFINITY,
          freshAtMs: 0,
          retiredTurnCount: 0,
          liveTurnIds: new Set(),
          liveTopicId: topic.id,
          bag: new Map(),
          speakerCounts: new Map(),
          samples: [],
        };
        this.#clouds.set(topic.id, cloud);
      }
      cloud.label = topic.label;
      cloud.liveTopicId = topic.id;
      cloud.liveTurnIds = new Set(topic.turnIds);
      cloud.freshAtMs = Math.max(cloud.freshAtMs, topic.freshAtMs);
      const members: TranscriptTurn[] = [];
      for (const turnId of topic.turnIds) {
        const turn = byId.get(turnId);
        if (turn === undefined) {
          continue;
        }
        members.push(turn);
        cloud.firstAtMs = Math.min(cloud.firstAtMs, turn.atMs);
        const prior = this.#liveTurns.get(turnId);
        // Model refinement can MOVE a live turn between topics — its future
        // retirement follows it. Tokens re-derive only when the text grew.
        if (prior === undefined || prior.textLength !== turn.text.length) {
          this.#liveTurns.set(turnId, {
            cloudId: topic.id,
            speaker: turn.speaker,
            atMs: turn.atMs,
            textLength: turn.text.length,
            tokens: contentTokens(turn.text),
          });
        } else {
          prior.cloudId = topic.id;
          prior.atMs = turn.atMs;
        }
      }
      if (!Number.isFinite(cloud.firstAtMs)) {
        cloud.firstAtMs = topic.freshAtMs;
      }
      cloud.samples = members
        .slice(-MAX_SAMPLES_PER_CLOUD)
        .map((turn) => ({ id: turn.id, speaker: turn.speaker, text: turn.text.slice(0, MAX_SAMPLE_CHARS) }));
    }
    // 3. TOPIC DIED: the cloud keeps everything it accumulated, it just has no
    //    live branch anymore. A cloud that never retired a turn (every member
    //    was re-clustered elsewhere by refinement) holds zero memory — drop it.
    for (const [id, cloud] of [...this.#clouds]) {
      if (liveTopicIds.has(id)) {
        continue;
      }
      cloud.liveTopicId = null;
      cloud.liveTurnIds.clear();
      cloud.samples = [];
      if (cloud.retiredTurnCount === 0) {
        this.#clouds.delete(id);
        this.#agentLinks = this.#agentLinks.filter((link) => link.a !== id && link.b !== id);
        this.#trace("research.sky.drop", "debug", this.#correlation(), { id, reason: "reclustered-empty" });
      }
    }
    // 4. EVICT past the cap — stalest DEAD cloud only, never a live one, and
    //    always traced: losing memory silently would betray the wall.
    while (this.#clouds.size > MAX_CLOUDS) {
      let stalest: CloudState | null = null;
      for (const cloud of this.#clouds.values()) {
        if (cloud.liveTopicId !== null) {
          continue;
        }
        if (stalest === null || cloud.freshAtMs < stalest.freshAtMs) {
          stalest = cloud;
        }
      }
      if (stalest === null) {
        break; // everything is live — the cap yields rather than lying
      }
      const evicted = stalest;
      this.#clouds.delete(evicted.id);
      this.#agentLinks = this.#agentLinks.filter((link) => link.a !== evicted.id && link.b !== evicted.id);
      this.#trace("research.sky.evict", "info", this.#correlation(), {
        id: evicted.id,
        label: evicted.agentName ?? evicted.label,
        turnCount: evicted.retiredTurnCount,
      });
    }
    // 5. Quest projection: resolve each quest's grounding cloud while its turn
    //    is still live (sticky — the anchor survives the turn's retirement).
    this.#quests = quests;
    for (const quest of quests) {
      const live = this.#liveTurns.get(quest.turnId);
      if (live !== undefined) {
        this.#questClouds.set(quest.id, live.cloudId);
      }
    }
    this.#recentTurns = turns
      .slice(-RECENT_TURNS_FOR_MODEL)
      .map((turn) => ({ id: turn.id, speaker: turn.speaker, text: turn.text.slice(0, MAX_SAMPLE_CHARS) }));
    this.#updatedAtMs = nowMs;
    this.#lexicalMemo = null;
    this.#snapshotMemo = null;
    this.#agentDirty = true;
  }

  // Full clean slate (the wall's research reset rides through resetAll).
  reset(): void {
    this.#clouds.clear();
    this.#liveTurns.clear();
    this.#questClouds.clear();
    this.#quests = [];
    this.#recentTurns = [];
    this.#agentLinks = [];
    this.#agentAtMs = null;
    this.#lexicalMemo = null;
    this.#snapshotMemo = null;
    this.#agentDirty = false;
    this.#updatedAtMs = this.#clock();
  }

  // ── reads ─────────────────────────────────────────────────────────────────

  snapshot(): SkySnapshot {
    if (this.#snapshotMemo !== null) {
      return this.#snapshotMemo;
    }
    // Freshest MAX_CLOUDS surface (the accumulator itself holds ≤ the same
    // cap), presented oldest-first to mirror topics().
    const clouds = [...this.#clouds.values()]
      .sort((a, b) => b.freshAtMs - a.freshAtMs)
      .slice(0, MAX_CLOUDS)
      .sort((a, b) => a.firstAtMs - b.firstAtMs)
      .map((cloud) => ({
        id: cloud.id,
        label: cloud.agentName ?? cloud.label,
        labelSource: (cloud.agentName !== null ? "agent" : "topic") as "agent" | "topic",
        firstAtMs: cloud.firstAtMs,
        freshAtMs: cloud.freshAtMs,
        turnCount: cloud.retiredTurnCount + cloud.liveTurnIds.size,
        liveTopicId: cloud.liveTopicId,
        dominantSpeaker: this.#dominantSpeaker(cloud),
      }));
    const shown = new Set(clouds.map((cloud) => cloud.id));
    // Agent links first (they carry a model's reason), lexical beside them;
    // one link per pair with the agent winning — provenance stays visible.
    const links: CloudLink[] = [];
    const seenPairs = new Set<string>();
    for (const link of [...this.#agentLinks, ...this.#lexicalLinks()]) {
      if (!shown.has(link.a) || !shown.has(link.b)) {
        continue;
      }
      const key = pairKey(link.a, link.b);
      if (seenPairs.has(key) || links.length >= MAX_SNAPSHOT_LINKS) {
        continue;
      }
      seenPairs.add(key);
      links.push(link);
    }
    this.#snapshotMemo = { clouds, links, updatedAtMs: this.#updatedAtMs, agentAtMs: this.#agentAtMs };
    return this.#snapshotMemo;
  }

  // ── the recurrent agent tick ──────────────────────────────────────────────

  // Run the relate tick NOW (the interval's target; tests drive it manually
  // with intervalMs 0). Never overlapping, never throwing out; skips when the
  // graph hasn't changed since the last tick or there is nothing to relate.
  relateNow(): Promise<void> {
    if (this.#runner === null) {
      return Promise.resolve(); // lexical-only sky — nothing to ask
    }
    if (this.#inFlight !== null) {
      return this.#inFlight; // never overlap — the running tick covers this
    }
    if (!this.#agentDirty || this.#clouds.size < 2) {
      return Promise.resolve();
    }
    const run = this.#runRelate(this.#runner)
      .catch((error) => {
        this.#trace("research.sky.error", "error", this.#correlation(), {
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.#inFlight = null;
      });
    this.#inFlight = run;
    return run;
  }

  // Await any in-flight tick (tests).
  async settle(): Promise<void> {
    while (this.#inFlight !== null) {
      await this.#inFlight;
    }
  }

  async #runRelate(runner: CloudRelateRunner): Promise<void> {
    this.#tick += 1;
    this.#agentDirty = false; // material arriving mid-flight re-arms the gate
    const correlationId = this.#correlation();
    this.#trace("research.sky.tick", "debug", correlationId, { clouds: this.#clouds.size });
    const request: CloudRelateRequest = {
      clouds: [...this.#clouds.values()].map((cloud) => ({
        id: cloud.id,
        label: cloud.agentName ?? cloud.label,
        turnCount: cloud.retiredTurnCount + cloud.liveTurnIds.size,
        firstAtMs: cloud.firstAtMs,
        freshAtMs: cloud.freshAtMs,
        live: cloud.liveTopicId !== null,
        sampleTurns: cloud.samples.map((sample) => ({ speaker: sample.speaker, text: sample.text })),
      })),
      currentLinks: this.snapshot().links.map((link) => ({
        a: link.a,
        b: link.b,
        strength: link.strength,
        source: link.source,
      })),
      research: this.#quests.map((quest) => ({
        questId: quest.id,
        status: quest.status,
        topic: quest.topic,
        cloudId: this.#questClouds.get(quest.id) ?? null,
      })),
      recentTurns: this.#recentTurns,
    };
    const raw = await this.#boundedCall(runner, request);
    if (raw === null || raw === undefined) {
      // No key, HTTP error, timeout, runner rejection — the lexical sky
      // stands, and the miss is visible in the rail.
      this.#trace("research.sky.miss", "debug", correlationId, { tick: this.#tick });
      return;
    }
    this.#applyRelate(raw, correlationId);
  }

  // Race the model against the budget (tree.ts #boundedCall clone): any
  // rejection, timeout, or abort resolves null so the lexical sky stands.
  async #boundedCall(runner: CloudRelateRunner, request: CloudRelateRequest): Promise<unknown> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, this.#timeoutMs);
    });
    try {
      return await Promise.race([runner(request, controller.signal).catch(() => null), timeout]);
    } finally {
      if (timer !== null) {
        clearTimeout(timer);
      }
    }
  }

  // Apply the model's reply with PER-ENTRY validation — links/names/merges are
  // decoration over the deterministic graph, not a partition (unlike the
  // tree's wholesale drop), so one bad entry never sinks its valid siblings.
  #applyRelate(raw: unknown, correlationId: string): void {
    const value = typeof raw === "string" ? parseLooseJson(raw) : raw;
    if (!isRecord(value)) {
      this.#trace("research.sky.reject", "warn", correlationId, { reason: "unparseable" });
      return; // agentAtMs stays put — garbage is not the agent speaking
    }
    let rejected = 0;
    // MERGES first (links may reference the survivors). Only DEAD clouds fold:
    // merging a cloud whose topic still lives would desync from the tree —
    // the next observe would just resurrect it beside its own memory.
    let merges = 0;
    for (const entry of asArray(value.merges)) {
      if (!isRecord(entry) || typeof entry.into !== "string") {
        rejected += 1;
        continue;
      }
      const into = this.#clouds.get(entry.into);
      for (const fromId of asArray(entry.from)) {
        const from = typeof fromId === "string" ? this.#clouds.get(fromId) : undefined;
        if (into === undefined || from === undefined || from === into || from.liveTopicId !== null) {
          rejected += 1;
          this.#trace("research.sky.reject", "debug", correlationId, {
            kind: "merge",
            into: entry.into,
            from: typeof fromId === "string" ? fromId : "?",
          });
          continue;
        }
        into.retiredTurnCount += from.retiredTurnCount + from.liveTurnIds.size;
        addBagCounts(into.bag, from.bag);
        trimBag(into.bag);
        for (const [speaker, count] of from.speakerCounts) {
          into.speakerCounts.set(speaker, (into.speakerCounts.get(speaker) ?? 0) + count);
        }
        into.firstAtMs = Math.min(into.firstAtMs, from.firstAtMs);
        into.freshAtMs = Math.max(into.freshAtMs, from.freshAtMs);
        this.#clouds.delete(from.id);
        // Re-point everything that referenced the absorbed cloud.
        this.#agentLinks = this.#agentLinks
          .map((link) => ({
            ...link,
            a: link.a === from.id ? into.id : link.a,
            b: link.b === from.id ? into.id : link.b,
          }))
          .filter((link) => link.a !== link.b);
        for (const [questId, cloudId] of this.#questClouds) {
          if (cloudId === from.id) {
            this.#questClouds.set(questId, into.id);
          }
        }
        merges += 1;
        this.#trace("research.sky.merge", "info", correlationId, {
          into: into.id,
          from: from.id,
          reason: clampWordCount(typeof entry.reason === "string" ? entry.reason : "", MAX_REASON_WORDS),
        });
      }
    }
    // LINKS: this tick's agent links REPLACE the previous tick's (the agent
    // re-judges the whole graph each time); lexical links live beside them.
    const links: CloudLink[] = [];
    for (const entry of asArray(value.links)) {
      const a = isRecord(entry) && typeof entry.a === "string" ? entry.a : null;
      const b = isRecord(entry) && typeof entry.b === "string" ? entry.b : null;
      if (a === null || b === null || a === b || !this.#clouds.has(a) || !this.#clouds.has(b)) {
        rejected += 1;
        this.#trace("research.sky.reject", "debug", correlationId, { kind: "link", a: a ?? "?", b: b ?? "?" });
        continue;
      }
      const record = entry as Record<string, unknown>;
      links.push({
        a,
        b,
        strength: clamp01(typeof record.strength === "number" ? record.strength : 0.5),
        reason: clampWordCount(typeof record.reason === "string" ? record.reason : "", MAX_REASON_WORDS),
        source: "agent",
      });
    }
    // NAMES: a condensation overlay — ConceptTree's own labels stay untouched.
    let names = 0;
    for (const entry of asArray(value.names)) {
      const id = isRecord(entry) && typeof entry.id === "string" ? entry.id : null;
      const name = isRecord(entry) && typeof entry.name === "string" ? clampWordCount(entry.name, MAX_NAME_WORDS) : "";
      const cloud = id !== null ? this.#clouds.get(id) : undefined;
      if (cloud === undefined || name.length === 0) {
        rejected += 1;
        this.#trace("research.sky.reject", "debug", correlationId, { kind: "name", id: id ?? "?" });
        continue;
      }
      cloud.agentName = name;
      names += 1;
    }
    // RESEARCH HOOKS: validated + traced only — no quest spawning from here
    // yet (the suggester cadence owns quest creation; this is honest future
    // wiring, not a silent dead end).
    for (const entry of asArray(value.researchHooks)) {
      const topicId = isRecord(entry) && typeof entry.topicId === "string" ? entry.topicId : null;
      const question = isRecord(entry) && typeof entry.question === "string" ? entry.question.trim() : "";
      if (topicId === null || !this.#clouds.has(topicId) || question.length === 0) {
        rejected += 1;
        continue;
      }
      this.#trace("research.sky.hook", "info", correlationId, { topicId, question: question.slice(0, 120) });
    }
    this.#agentLinks = links;
    // The agent SPOKE (a parsed reply, even a sparse one) — stamp it. This is
    // the snapshot's provenance surface: null means lexical-only, forever.
    this.#agentAtMs = this.#clock();
    this.#updatedAtMs = this.#agentAtMs;
    this.#snapshotMemo = null;
    this.#trace("research.sky.applied", "info", correlationId, {
      links: links.length,
      names,
      merges,
      rejected,
    });
    this.#onUpdate?.();
  }

  // ── deterministic linker (the offline sky) ────────────────────────────────

  // Token-bag Jaccard over cloud vocabularies + research-quest bridges.
  // Cross-topic SHARED TURNS are structurally zero (ConceptTree keeps an
  // exclusive partition — tree.ts wholesale-drops anything else), so token
  // overlap and quests are the real deterministic cross-topic signals.
  #lexicalLinks(): CloudLink[] {
    if (this.#lexicalMemo !== null) {
      return this.#lexicalMemo;
    }
    const vocab = new Map<string, Map<string, number>>();
    for (const cloud of this.#clouds.values()) {
      const merged = new Map(cloud.bag);
      for (const turnId of cloud.liveTurnIds) {
        const live = this.#liveTurns.get(turnId);
        if (live !== undefined) {
          addBag(merged, live.tokens);
        }
      }
      vocab.set(cloud.id, merged);
    }
    const ids = [...vocab.keys()];
    const candidates: CloudLink[] = [];
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const bagA = vocab.get(ids[i]!)!;
        const bagB = vocab.get(ids[j]!)!;
        if (bagA.size === 0 || bagB.size === 0) {
          continue;
        }
        const shared: string[] = [];
        for (const token of bagA.keys()) {
          if (bagB.has(token)) {
            shared.push(token);
          }
        }
        const union = bagA.size + bagB.size - shared.length;
        const jaccard = union > 0 ? shared.length / union : 0;
        if (jaccard < LEXICAL_JACCARD_FLOOR) {
          continue;
        }
        // Most-said shared vocabulary first — the reason names the overlap.
        shared.sort((a, b) => ((bagA.get(b) ?? 0) + (bagB.get(b) ?? 0)) - ((bagA.get(a) ?? 0) + (bagB.get(a) ?? 0)));
        candidates.push({
          a: ids[i]!,
          b: ids[j]!,
          strength: clamp01(jaccard / LEXICAL_JACCARD_CEIL),
          reason: `shared: ${shared.slice(0, 3).join(", ")}`,
          source: "lexical",
        });
      }
    }
    // Strongest pairs first, each cloud capped — a chatty vocabulary must not
    // wisp to everything.
    candidates.sort((a, b) => b.strength - a.strength);
    const perCloud = new Map<string, number>();
    const links: CloudLink[] = [];
    for (const link of candidates) {
      const countA = perCloud.get(link.a) ?? 0;
      const countB = perCloud.get(link.b) ?? 0;
      if (countA >= MAX_LEXICAL_LINKS_PER_CLOUD || countB >= MAX_LEXICAL_LINKS_PER_CLOUD) {
        continue;
      }
      perCloud.set(link.a, countA + 1);
      perCloud.set(link.b, countB + 1);
      links.push(link);
    }
    // QUEST BRIDGES: a research quest grounded in cloud A whose claim's
    // vocabulary best matches cloud B is cross-topic evidence relating them.
    const seen = new Set(links.map((link) => pairKey(link.a, link.b)));
    for (const quest of this.#quests) {
      const home = this.#questClouds.get(quest.id);
      if (home === undefined || !this.#clouds.has(home)) {
        continue;
      }
      const claimTokens = new Set(contentTokens(`${quest.topic} ${quest.claim}`));
      if (claimTokens.size === 0) {
        continue;
      }
      let best: string | null = null;
      let bestScore = 0;
      for (const [cloudId, bag] of vocab) {
        if (cloudId === home) {
          continue;
        }
        let hits = 0;
        for (const token of claimTokens) {
          if (bag.has(token)) {
            hits += 1;
          }
        }
        const score = hits / claimTokens.size;
        if (score > bestScore) {
          best = cloudId;
          bestScore = score;
        }
      }
      if (best === null || bestScore < BRIDGE_MATCH_FLOOR || seen.has(pairKey(home, best))) {
        continue;
      }
      seen.add(pairKey(home, best));
      links.push({
        a: home,
        b: best,
        strength: clamp01(0.4 + 0.4 * bestScore),
        reason: `research bridge: ${clampWordCount(quest.topic, MAX_REASON_WORDS)}`,
        source: "lexical",
      });
    }
    this.#lexicalMemo = links;
    return links;
  }

  #dominantSpeaker(cloud: CloudState): string | null {
    const counts = new Map(cloud.speakerCounts);
    for (const turnId of cloud.liveTurnIds) {
      const speaker = this.#liveTurns.get(turnId)?.speaker;
      if (speaker !== undefined && speaker !== null) {
        counts.set(speaker, (counts.get(speaker) ?? 0) + 1);
      }
    }
    let dominant: string | null = null;
    let best = 0;
    for (const [speaker, count] of counts) {
      if (count > best) {
        dominant = speaker;
        best = count;
      }
    }
    return dominant;
  }

  #correlation(): string {
    return `corr-sky-tick-${this.#tick}`;
  }

  #trace(event: string, level: SkyTraceEvent["level"], correlationId: string, meta: Record<string, unknown>): void {
    this.#onTrace?.({ event, level, correlationId, meta });
  }
}

// ── env knob ─────────────────────────────────────────────────────────────────

// VIBERSYN_SKY_INTERVAL_MS — the recurrent relate cadence, default 60000;
// 0 disables the agent tick entirely (the lexical sky still works). A graph
// cadence knob, so it is read here (readResearchSuggestIntervalMs pattern).
export function readSkyIntervalMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.VIBERSYN_SKY_INTERVAL_MS?.trim();
  if (raw === undefined || raw === "") {
    return DEFAULT_SKY_INTERVAL_MS;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("VIBERSYN_SKY_INTERVAL_MS must be a non-negative number.");
  }
  return value;
}

// ── default model (one bounded Cerebras call — tree.ts refiner clone) ────────

const SKY_SYSTEM_PROMPT =
  "You relate the topic clouds of a live room conversation for a projected ceiling sky. Given the cloud graph " +
  "(each cloud one concept topic with sample turns; live=false means the topic scrolled out of the dialogue " +
  "window), current links, research quests, and recent turns: propose cross-topic LINKS with a short reason, " +
  "optional MERGES of clouds that are really one concept (only merge ids you were given), a condensed NAME " +
  "(max 4 words) per cloud where the label is weak, and optional researchHooks (a question worth researching " +
  'for a topicId). Reply with STRICT JSON only — {"merges":[{"into":"topic-0001","from":["topic-0002"],' +
  '"reason":"..."}],"links":[{"a":"topic-0001","b":"topic-0003","strength":0.7,"reason":"..."}],' +
  '"names":[{"id":"topic-0001","name":"..."}],"researchHooks":[{"topicId":"topic-0001","question":"..."}]} ' +
  "— no markdown, no prose. Omit empty arrays.";

// Null on any miss (no key, HTTP error, unparseable payload) — the graph's
// bounded-call wrapper converts rejections to null too.
export const cerebrasCloudRelate: CloudRelateRunner = async (request, signal) => {
  const apiKey = process.env.CEREBRAS_API_KEY;
  if (apiKey === undefined || apiKey.trim().length === 0) {
    return null;
  }
  const response = await fetch("https://api.cerebras.ai/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: process.env.CEREBRAS_MODEL ?? "gemma-4-31b",
      temperature: 0,
      max_completion_tokens: 700,
      messages: [
        { role: "system", content: SKY_SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify(request) },
      ],
    }),
    signal,
  });
  if (!response.ok) {
    return null;
  }
  const payload: unknown = await response.json();
  if (!isRecord(payload) || !Array.isArray(payload.choices)) {
    return null;
  }
  const first: unknown = payload.choices[0];
  if (!isRecord(first) || !isRecord(first.message)) {
    return null;
  }
  return typeof first.message.content === "string" ? first.message.content : null;
};

// ── helpers (module-local copies per the tree.ts convention) ─────────────────

function addBag(bag: Map<string, number>, tokens: readonly string[]): void {
  for (const token of tokens) {
    bag.set(token, (bag.get(token) ?? 0) + 1);
  }
}

function addBagCounts(bag: Map<string, number>, other: ReadonlyMap<string, number>): void {
  for (const [token, count] of other) {
    bag.set(token, (bag.get(token) ?? 0) + count);
  }
}

// Persisted bags stay bounded: once past double the cap, keep the top tokens
// by count — the cloud's vocabulary shape, not its full history.
function trimBag(bag: Map<string, number>): void {
  if (bag.size <= MAX_BAG_TOKENS * 2) {
    return;
  }
  const kept = [...bag.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_BAG_TOKENS);
  bag.clear();
  for (const [token, count] of kept) {
    bag.set(token, count);
  }
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function clampWordCount(raw: string, maxWords: number): string {
  return raw.replace(/\s+/gu, " ").trim().split(" ").filter((word) => word.length > 0).slice(0, maxWords).join(" ");
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Tolerant JSON (import-plan pattern; local copy on purpose — see tree.ts).
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
