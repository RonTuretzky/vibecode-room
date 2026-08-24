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
import { composeAgentRunner, unwrapAgentReply } from "./standin";
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
  // NAMING GATE: false = this accumulation surfaces UNNAMED (too thin to be a
  // real thread, or the agent dusted it) — the ceiling renders it as dust,
  // never as a labeled constellation. Deterministic thinness OR the agent's
  // reversible dust verb; provenance rides the traces.
  named: boolean;
  // RETIRED member turns kept as STARS (id, spoken time, speaker, gist ≤80
  // chars) — the proof of memory beyond the window, renderable as an asterism.
  // Capped per cloud; `elidedCount` counts evicted history honestly. Only the
  // freshest clouds carry stars in the snapshot (SSE budget); others get [].
  stars: Array<{ id: string; atMs: number; speaker: string | null; gist: string }>;
  elidedCount: number;
}

// One constellation read in full — the wall's topic card (see cloudDetail).
export interface CloudDetail {
  id: string;
  label: string;
  labelSource: "agent" | "topic";
  firstAtMs: number;
  freshAtMs: number;
  turnCount: number;
  dominantSpeaker: string | null;
  live: boolean;
  named: boolean;
  // The agent's one-sentence abstract, or null — the card NEVER fabricates one.
  summary: string | null;
  summaryAtMs: number | null;
  agentAtMs: number | null;
  // The thread in spoken order. "said" = live text; "recalled" = a retired
  // turn's ≤80-char star gist (the window dropped the rest).
  lines: Array<{ id: string; atMs: number; speaker: string | null; text: string; source: "said" | "recalled" }>;
  // How many turns fell off even the star memory.
  elidedCount: number;
  related: Array<{ id: string; label: string; strength: number; reason: string; source: "agent" | "lexical" }>;
}

export interface SkySnapshot {
  clouds: CloudSnapshotEntry[];
  links: CloudLink[];
  updatedAtMs: number;
  // HONESTY STAMP: the last time the agent tick actually landed. Null = the
  // agent has never spoken — every relation shown is deterministic fallback.
  agentAtMs: number | null;
  // LOUDNESS: how the relate agent has been failing, if it has. A permanent
  // silent miss (the 402 the operator never saw) is impossible now — the
  // streak + reason surface here and in /api/health once it persists.
  // `agent` = which transport landed the last applied tick ("cerebras" |
  // "host-claude" stand-in | null before any tick / unlabeled scripted runner).
  relate: { missStreak: number; lastMissReason: string | null; agent: string | null };
  // Retired DUST (babble that scrolled out of the window): present, faint,
  // never named, never connected. ~15B each — trivial SSE.
  dust: Array<{ atMs: number }>;
}

// The relate/refiner agent's failure surface (also the /api/health input).
export interface SkyAgentHealth {
  missStreak: number;
  lastMissReason: string | null;
  agentAtMs: number | null;
  // Which transport landed the last applied tick (provenance; null = none yet).
  agent: string | null;
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
// The budget covers a fast-failing Cerebras call (~200ms on a 402) PLUS the
// host-claude stand-in's cold CLI boot (~14s measured; STANDIN_TIMEOUT_MS 25s)
// — and stays well inside the 60s tick with the in-flight guard on top.
const DEFAULT_RELATE_TIMEOUT_MS = 30_000;
// Snapshot caps — the sky field must stay glanceable and SSE-cheap.
const MAX_CLOUDS = 24;
const MAX_SNAPSHOT_LINKS = 12;
const MAX_SAMPLES_PER_CLOUD = 4;
// The agent abstract shown on the topic card — one sentence, hard-capped so a
// runaway reply can never blow out the card.
const MAX_SUMMARY_CHARS = 320;
// Related constellations listed on a topic card (strongest first).
const MAX_RELATED_IN_DETAIL = 4;
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
// LOUDNESS: at this many consecutive relate misses the trace escalates
// debug→warn and /api/health grows a degraded leg (degradation-notice.ts).
export const SKY_MISS_STREAK_WARN = 3;
// STAR RETENTION: gists kept per cloud (evict-oldest past it, counted in
// elidedCount) and how many freshest clouds carry stars in the snapshot (10,
// not the full render cap: measured worst case is ~1.7KB per carrier and the
// whole snapshot must stay under ~25KB on the SSE pipe — older constellations
// still render from live window stars / the elided ring).
const MAX_STARS_PER_CLOUD = 12;
const MAX_STAR_CLOUDS_IN_SNAPSHOT = 10;
const MAX_GIST_CHARS = 80;
// Retired dust ledger cap (evict oldest — dust is atmosphere, not archive).
const MAX_DUST = 48;
// NAMING GATE: a cloud whose whole vocabulary is thinner than this many
// distinct content tokens surfaces unnamed (dust-class accumulation).
const MIN_NAMED_DISTINCT_TOKENS = 6;

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
  // Retired member gists — the asterism's memory (cap MAX_STARS_PER_CLOUD,
  // evict-oldest, every eviction counted in elidedCount).
  stars: Array<{ id: string; atMs: number; speaker: string | null; gist: string }>;
  elidedCount: number;
  // Agent dust verb overlay: true = the relate agent judged this cloud babble.
  // REVERSIBLE — cleared as soon as the cloud grows past the turn count it was
  // dusted at (new material re-earns the name). Deterministic structure is
  // never silently overridden: the demotion is traced (research.sky.dust).
  dustedAtTurnCount: number | null;
  // AGENT ABSTRACT: one sentence answering "what was this thread about?", for
  // the wall's topic card. Null until the relate tick writes one (and forever,
  // with no model) — the card then falls back to the spoken lines themselves
  // rather than inventing a recap.
  agentSummary: string | null;
  agentSummaryAtMs: number | null;
}

interface LiveTurnState {
  cloudId: string;
  speaker: string | null;
  atMs: number;
  textLength: number; // re-tokenize only when coalesce growth changed the text
  tokens: string[];
  // Captured while the text is still in hand — the turn's text is
  // unrecoverable at retirement, so the star gist is snapshotted at upsert.
  gist: string;
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
  // LOUDNESS: consecutive relate misses + the last reason. Reset the moment a
  // tick actually lands (#applyRelate, beside the agentAtMs stamp).
  #missStreak = 0;
  #lastMissReason: string | null = null;
  // PROVENANCE: which transport landed the last applied tick ("cerebras",
  // "host-claude" when the stand-in rescued a dead account, null before any).
  #lastAgent: string | null = null;
  // DUST: live babble turns (window turns the tree pooled with no topic) and
  // the retired ledger the snapshot surfaces (cap MAX_DUST, evict oldest).
  readonly #liveDust = new Map<string, number>(); // turn id → atMs
  #dust: Array<{ atMs: number }> = [];

  // Dirty gates: lexical link memo + "is there anything new to tell the agent".
  #lexicalMemo: CloudLink[] | null = null;
  #agentDirty = false;
  #snapshotMemo: SkySnapshot | null = null;
  #inFlight: Promise<void> | null = null;
  #tick = 0;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: CloudGraphOptions = {}) {
    this.#runner = options.runner === undefined ? defaultCloudRelate : options.runner;
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
  observe(
    topics: ConceptTopic[],
    turns: readonly TranscriptTurn[],
    quests: CloudQuestRef[] = [],
    dustTurnIds: readonly string[] = [],
  ): void {
    const nowMs = this.#clock();
    const windowIds = new Set(turns.map((turn) => turn.id));
    // 0. DUST: babble turns (no topic — the tree's dust pool) are tracked so
    //    their RETIREMENT folds into the graph-level dust ledger, never a
    //    cloud. A dust turn that PROMOTED to content (coalesce completed its
    //    sentence) shows up in a topic below and leaves the dust set here.
    const dustNow = new Set(dustTurnIds);
    const byId = new Map(turns.map((turn) => [turn.id, turn]));
    for (const [turnId, atMs] of [...this.#liveDust]) {
      if (!dustNow.has(turnId)) {
        this.#liveDust.delete(turnId);
        if (!windowIds.has(turnId)) {
          this.#dust.push({ atMs });
          if (this.#dust.length > MAX_DUST) {
            this.#dust = this.#dust.slice(this.#dust.length - MAX_DUST);
          }
        }
      }
    }
    for (const turnId of dustNow) {
      const turn = byId.get(turnId);
      if (turn !== undefined) {
        this.#liveDust.set(turnId, turn.atMs);
      }
    }
    // 1. RETIRE: window-dropped turns fold into their last-known cloud — turn
    //    count, tokens, speaker, and a STAR gist — before their text is gone
    //    forever.
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
        cloud.stars.push({ id: turnId, atMs: live.atMs, speaker: live.speaker, gist: live.gist });
        capStars(cloud);
      }
      this.#liveTurns.delete(turnId);
    }
    // 2. UPSERT a cloud per live topic (cloud id = founding topic id — the
    //    tree's #topicSeq is session-monotonic, so ids are stable + unique).
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
          stars: [],
          elidedCount: 0,
          dustedAtTurnCount: null,
          agentSummary: null,
          agentSummaryAtMs: null,
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
            // The star gist is captured HERE, while the text exists — at
            // retirement only this survives.
            gist: turn.text.slice(0, MAX_GIST_CHARS),
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
      // AGENT DUST REVERSIBILITY: growth past the dusted-at turn count means
      // the room kept talking about it — the demotion clears itself.
      if (cloud.dustedAtTurnCount !== null && cloud.retiredTurnCount + cloud.liveTurnIds.size > cloud.dustedAtTurnCount) {
        cloud.dustedAtTurnCount = null;
      }
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
    this.#missStreak = 0;
    this.#lastMissReason = null;
    this.#lastAgent = null;
    this.#liveDust.clear();
    this.#dust = [];
    this.#lexicalMemo = null;
    this.#snapshotMemo = null;
    this.#agentDirty = false;
    this.#updatedAtMs = this.#clock();
  }

  // The relate agent's failure surface: /api/health degrades on a persistent
  // miss streak so a silent permanent failure is impossible.
  agentHealth(): SkyAgentHealth {
    return {
      missStreak: this.#missStreak,
      lastMissReason: this.#lastMissReason,
      agentAtMs: this.#agentAtMs,
      agent: this.#lastAgent,
    };
  }

  // ── reads ─────────────────────────────────────────────────────────────────

  /**
   * ONE CONSTELLATION, IN FULL — what the wall's topic card reads when a
   * constellation is picked ("what was this thread about?").
   *
   * Deliberately NOT in the snapshot: abstracts plus every line of 24 clouds
   * would ride every SSE frame for a card that shows one cloud at a time. The
   * wall fetches this on open instead (GET /api/research/sky/topic/:id).
   *
   * `lines` is the thread in spoken order, and says which half it came from:
   * "said" = a live turn whose text the window still holds, "recalled" = a
   * retired turn kept as an ≤80-char star gist. `elidedCount` counts what fell
   * off even that — the card admits the gap instead of implying completeness.
   */
  cloudDetail(id: string): CloudDetail | null {
    const cloud = this.#clouds.get(id);
    if (cloud === undefined) {
      return null;
    }
    const lines: CloudDetail["lines"] = cloud.stars.map((star) => ({
      id: star.id,
      atMs: star.atMs,
      speaker: star.speaker,
      text: star.gist,
      source: "recalled" as const,
    }));
    const recalled = new Set(cloud.stars.map((star) => star.id));
    for (const sample of cloud.samples) {
      if (recalled.has(sample.id)) {
        continue;
      }
      lines.push({
        id: sample.id,
        atMs: this.#liveTurns.get(sample.id)?.atMs ?? cloud.freshAtMs,
        speaker: sample.speaker,
        text: sample.text,
        source: "said",
      });
    }
    lines.sort((a, b) => a.atMs - b.atMs);
    const related = [...this.#agentLinks, ...this.#lexicalLinks()]
      .filter((link) => link.a === id || link.b === id)
      .map((link) => {
        const otherId = link.a === id ? link.b : link.a;
        const other = this.#clouds.get(otherId);
        return {
          id: otherId,
          label: other === undefined ? otherId : other.agentName ?? other.label,
          strength: link.strength,
          reason: link.reason,
          source: link.source,
        };
      })
      .sort((a, b) => b.strength - a.strength)
      .slice(0, MAX_RELATED_IN_DETAIL);
    return {
      id: cloud.id,
      label: cloud.agentName ?? cloud.label,
      labelSource: cloud.agentName !== null ? "agent" : "topic",
      firstAtMs: cloud.firstAtMs,
      freshAtMs: cloud.freshAtMs,
      turnCount: cloud.retiredTurnCount + cloud.liveTurnIds.size,
      dominantSpeaker: this.#dominantSpeaker(cloud),
      live: cloud.liveTopicId !== null,
      named: this.#isNamed(cloud),
      summary: cloud.agentSummary,
      summaryAtMs: cloud.agentSummaryAtMs,
      // The card's honesty line: with no abstract it says so and shows the
      // lines instead. `agentAtMs === null` means the model has never spoken
      // at all, which is a different silence than "not summarized yet".
      agentAtMs: this.#agentAtMs,
      lines,
      elidedCount: cloud.elidedCount,
      related,
    };
  }

  snapshot(): SkySnapshot {
    if (this.#snapshotMemo !== null) {
      return this.#snapshotMemo;
    }
    // Freshest MAX_CLOUDS surface (the accumulator itself holds ≤ the same
    // cap), presented oldest-first to mirror topics(). Stars ride only on the
    // freshest MAX_STAR_CLOUDS_IN_SNAPSHOT clouds — SSE budget.
    const byFreshness = [...this.#clouds.values()].sort((a, b) => b.freshAtMs - a.freshAtMs).slice(0, MAX_CLOUDS);
    const starCarriers = new Set(byFreshness.slice(0, MAX_STAR_CLOUDS_IN_SNAPSHOT).map((cloud) => cloud.id));
    const clouds = byFreshness
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
        named: this.#isNamed(cloud),
        stars: starCarriers.has(cloud.id) ? cloud.stars.map((star) => ({ ...star })) : [],
        elidedCount: cloud.elidedCount,
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
    this.#snapshotMemo = {
      clouds,
      links,
      updatedAtMs: this.#updatedAtMs,
      agentAtMs: this.#agentAtMs,
      relate: { missStreak: this.#missStreak, lastMissReason: this.#lastMissReason, agent: this.#lastAgent },
      dust: this.#dust.map((entry) => ({ ...entry })),
    };
    return this.#snapshotMemo;
  }

  // NAMING GATE: an accumulation earns a label only when its whole vocabulary
  // is thicker than dust AND the agent hasn't (reversibly) dusted it.
  #isNamed(cloud: CloudState): boolean {
    if (cloud.dustedAtTurnCount !== null) {
      return false;
    }
    const distinct = new Set(cloud.bag.keys());
    for (const turnId of cloud.liveTurnIds) {
      for (const token of this.#liveTurns.get(turnId)?.tokens ?? []) {
        distinct.add(token);
      }
    }
    return distinct.size >= MIN_NAMED_DISTINCT_TOKENS;
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
    const outcome = await this.#boundedCall(runner, request);
    if ("miss" in outcome) {
      // No key, HTTP error (the 402!), timeout, runner rejection — the
      // lexical sky stands, the REASON is traced, and a persistent streak
      // escalates to warn + an /api/health degraded leg. Never silent.
      this.#recordMiss(outcome.miss, correlationId);
      return;
    }
    // Unwrap transport provenance (standin.ts): which agent spoke, and — when
    // the host-claude stand-in rescued a failing Cerebras account — WHY. The
    // rescue itself is loud (warn): the operator must know billing is broken
    // even while the sky keeps reorganizing.
    const { agent, standinFor, reply } = unwrapAgentReply(outcome.value);
    if (standinFor !== null) {
      this.#trace("research.sky.standin", "warn", correlationId, {
        tick: this.#tick,
        agent: agent ?? "?",
        for: standinFor,
      });
    }
    this.#applyRelate(reply, correlationId, agent);
  }

  #recordMiss(reason: string, correlationId: string): void {
    this.#missStreak += 1;
    this.#lastMissReason = reason;
    this.#snapshotMemo = null; // the relate surface changed
    // RETRY: a REAL failure re-arms the dirty gate so the next interval tick
    // tries again even in a quiet room. Without this a room that stops
    // talking after 2 misses stalls below the health threshold forever — the
    // exact silent-permanent-failure loudness forbids. Paced by the interval.
    // "no-key" stays un-armed: the deliberate no-agent config never churns.
    if (reason !== "no-key") {
      this.#agentDirty = true;
    }
    this.#trace(
      "research.sky.miss",
      this.#missStreak >= SKY_MISS_STREAK_WARN ? "warn" : "debug",
      correlationId,
      { tick: this.#tick, reason, streak: this.#missStreak },
    );
  }

  // Race the model against the budget (tree.ts #boundedCall clone) — but keep
  // the FAILURE REASON: a rejection's message, "timeout", or "no-key" resolves
  // as a miss sentinel instead of an indistinguishable bare null.
  async #boundedCall(
    runner: CloudRelateRunner,
    request: CloudRelateRequest,
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
        runner(request, controller.signal).then(
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

  // Apply the model's reply with PER-ENTRY validation — links/names/merges are
  // decoration over the deterministic graph, not a partition (unlike the
  // tree's wholesale drop), so one bad entry never sinks its valid siblings.
  #applyRelate(raw: unknown, correlationId: string, agent: string | null = null): void {
    const value = typeof raw === "string" ? parseLooseJson(raw) : raw;
    if (!isRecord(value)) {
      this.#trace("research.sky.reject", "warn", correlationId, { reason: "unparseable" });
      // agentAtMs stays put — garbage is not the agent speaking. It IS a
      // miss, though: the streak keeps counting toward the health leg.
      this.#recordMiss("bad-payload", correlationId);
      return;
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
        // Stars concatenate through the merge (chronological), same cap —
        // overflow and the absorbed cloud's own elisions stay counted.
        into.stars = [...into.stars, ...from.stars].sort((a, b) => a.atMs - b.atMs);
        into.elidedCount += from.elidedCount;
        capStars(into);
        // The absorbed thread's abstract now describes only part of the merged
        // one, so it is STALE, not wrong-to-keep: drop both and let the next
        // tick summarize the union. A merged card shows its lines meanwhile.
        into.agentSummary = null;
        into.agentSummaryAtMs = null;
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
    // SUMMARIES: one sentence per constellation, for the wall's topic card
    // (click a constellation → "what was this thread about?"). Purely
    // additive: absent or rejected leaves `agentSummary` null and the card
    // falls back to the actual spoken lines, which is the honest floor —
    // never a fabricated recap.
    let summaries = 0;
    for (const entry of asArray(value.summaries)) {
      const id = isRecord(entry) && typeof entry.id === "string" ? entry.id : null;
      const text = isRecord(entry) && typeof entry.summary === "string" ? entry.summary.trim() : "";
      const cloud = id !== null ? this.#clouds.get(id) : undefined;
      if (cloud === undefined || text.length === 0) {
        rejected += 1;
        this.#trace("research.sky.reject", "debug", correlationId, { kind: "summary", id: id ?? "?" });
        continue;
      }
      cloud.agentSummary = text.slice(0, MAX_SUMMARY_CHARS);
      cloud.agentSummaryAtMs = this.#clock();
      summaries += 1;
    }
    // DUST verb: the agent judged a cloud babble — it drops its name and
    // renders as dust. REVERSIBLE (cleared when the cloud grows past the turn
    // count it was dusted at) and never silent: every demotion is traced.
    let dusted = 0;
    for (const entry of asArray(value.dust)) {
      const id = isRecord(entry) && typeof entry.id === "string" ? entry.id : null;
      const cloud = id !== null ? this.#clouds.get(id) : undefined;
      if (cloud === undefined) {
        rejected += 1;
        this.#trace("research.sky.reject", "debug", correlationId, { kind: "dust", id: id ?? "?" });
        continue;
      }
      cloud.dustedAtTurnCount = cloud.retiredTurnCount + cloud.liveTurnIds.size;
      dusted += 1;
      this.#trace("research.sky.dust", "info", correlationId, {
        id: cloud.id,
        reason: clampWordCount(isRecord(entry) && typeof entry.reason === "string" ? entry.reason : "", MAX_REASON_WORDS),
      });
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
    // A landed tick also clears the miss streak (the health leg drops).
    this.#agentAtMs = this.#clock();
    this.#updatedAtMs = this.#agentAtMs;
    this.#missStreak = 0;
    this.#lastMissReason = null;
    this.#lastAgent = agent;
    this.#snapshotMemo = null;
    this.#trace("research.sky.applied", "info", correlationId, {
      links: links.length,
      names,
      summaries,
      merges,
      dusted,
      rejected,
      agent: agent ?? "unlabeled",
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
  "You relate the topic constellations of a live room conversation for a projected ceiling star chart. Given " +
  "the constellation graph (each one concept topic with sample turns; live=false means the topic scrolled out " +
  "of the dialogue window), current links, research quests, and recent turns: propose cross-topic LINKS " +
  "(rendered as arcs between constellations) with a short reason, optional MERGES of constellations that are " +
  "really one concept (only merge ids you were given), a condensed NAME (max 4 words) per constellation where " +
  "the label is weak, DUST for a constellation that is pure conversational babble not worth a name (it fades " +
  "to background dust; reversible), a one-sentence SUMMARY per named constellation (what this thread was " +
  "actually about and where it landed — written for someone reading it off a ceiling, grounded ONLY in the " +
  "turns you were given; omit the entry rather than guess), and optional researchHooks (a question worth " +
  "researching for a topicId). " +
  'Reply with STRICT JSON only — {"merges":[{"into":"topic-0001","from":["topic-0002"],"reason":"..."}],' +
  '"links":[{"a":"topic-0001","b":"topic-0003","strength":0.7,"reason":"..."}],' +
  '"names":[{"id":"topic-0001","name":"..."}],"summaries":[{"id":"topic-0001","summary":"..."}],' +
  '"dust":[{"id":"topic-0001","reason":"..."}],' +
  '"researchHooks":[{"topicId":"topic-0001","question":"..."}]} — no markdown, no prose. Omit empty arrays.';

// Null ONLY when no key is configured (a clean, deliberate no-op). Every real
// failure THROWS with its cause — HTTP status + body (the 402 the operator
// never saw), or the payload shape — so the graph's bounded-call wrapper can
// surface the reason instead of an indistinguishable bare null.
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

// The PRODUCTION runner (ROUND 2 root-cause fix): Cerebras first, the host's
// logged-in `claude` CLI standing in when the account fails (the live room's
// 402 — quota-dead with a valid key). No key at all stays a clean no-agent
// no-op; the stand-in rescue carries provenance + the primary's failure reason
// so #runRelate traces it loudly. See standin.ts for the mode rules
// (VIBERSYN_RESEARCH_LLM = auto | cerebras | claude-cli).
export const defaultCloudRelate: CloudRelateRunner = composeAgentRunner({
  primary: cerebrasCloudRelate,
  promptFor: (request: CloudRelateRequest) => `${SKY_SYSTEM_PROMPT}\n\n${JSON.stringify(request)}`,
});

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

// Enforce the per-cloud star cap: evict oldest, count every eviction — elided
// history is honest ("more turns before this sky remembers"), never silent.
function capStars(cloud: { stars: Array<{ atMs: number }>; elidedCount: number }): void {
  if (cloud.stars.length <= MAX_STARS_PER_CLOUD) {
    return;
  }
  cloud.stars.sort((a, b) => a.atMs - b.atMs);
  const overflow = cloud.stars.length - MAX_STARS_PER_CLOUD;
  cloud.stars.splice(0, overflow);
  cloud.elidedCount += overflow;
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
