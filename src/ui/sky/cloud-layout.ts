// ── conversation-sky layout (pure, unit-tested) ─────────────────────────────
// The ceiling's cloud placement maths: TIME IS THE LAYOUT. Polar disc at
// SKY_ALT — zenith center = NOW, rim = the past; radius follows a log law of
// time-since-last-activity so recent differences stay visible while old
// clouds compress toward the horizon. Azimuth is hash-stable per cloud id
// (clouds never orbit randomly), gravitating a bounded fraction toward the
// strongest related cloud so neighborhoods form without identities drifting.
// Everything here is pure numbers — no renderer, no DOM — mirroring
// tree/dialogue-layout.ts so the sky is testable the same way the tree was.

import { hashSeed } from "../tree/spec";

// Sky deck altitude and the time→radius law. The deck floats well above the
// under-deck camera vista (RoomScene's skyView boot pose): the viewer looks UP
// through the cloud layer, so fresh clouds ride overhead and old ones sink
// toward the horizon line — perspective does the aerial-history reading.
export const SKY_ALT = 16;
// Fresh clouds additionally LIFT above the deck (focal, overhead); the lift
// decays with the same age norm, so sinking = aging even at one glance.
export const FRESH_LIFT = 3.2;
export const R_CORE = 3; // a cloud speaking NOW hovers here (zenith)
export const R_HORIZON = 24; // ~30min of silence parks a cloud here
export const AGE_KNEE = 60_000; // first minute spreads across the inner disc
export const AGE_SPAN = 1_800_000; // 30min → the horizon
// Render caps (the server may remember more — the ceiling shows the freshest).
export const MAX_SKY_CLOUDS = 14;
export const MAX_WISPS = 12;
export const WISP_MIN_STRENGTH = 0.35;
// A cloud spoken to within this window is ACTIVE: labeled, roiling, bright.
export const ACTIVE_MS = 20_000;
// Past this radiusNorm a cloud flattens into stratus and dims (the rim).
export const RIM_NORM = 0.8;

// ── time → place ────────────────────────────────────────────────────────────

// Age since the cloud last heard a turn; clamped ≥0 for client/server skew.
export function cloudAge(nowMs: number, freshAtMs: number): number {
  return Math.max(0, nowMs - freshAtMs);
}

// Log-law normalized age: 0 = zenith-fresh, 1 = horizon-old. The knee keeps
// the first minute legible; the span compresses everything past ~30min.
export function radiusNorm(age: number): number {
  return Math.min(1, Math.log1p(age / AGE_KNEE) / Math.log1p(AGE_SPAN / AGE_KNEE));
}

// Disc radius for an age (5s ≈ 3.5, 6min ≈ 14.9, 25min ≈ 22.9).
export function cloudRadius(age: number): number {
  return R_CORE + (R_HORIZON - R_CORE) * radiusNorm(age);
}

// Hash-stable home azimuth: a cloud keeps its bearing for the whole session.
export function azBase(id: string): number {
  return ((hashSeed(id) % 4096) / 4096) * Math.PI * 2;
}

// ── the visible fan ─────────────────────────────────────────────────────────
// The ceiling camera is a fixed under-deck vista (it never orbits the disc),
// so a full-360° spread would park clouds behind the viewer where they read
// as nothing. Every cloud instead keeps a hash-stable bearing INSIDE the fan
// facing away from the camera: all of history is always in frame.
// ±75° around the view direction: wide enough for a full history spread,
// narrow enough that rim clouds stay inside the frame without keystone smear.
export const SKY_FAN_HALF = Math.PI * 0.42;

// Hash-stable bearing inside the visible fan (center = away-from-camera).
export function fanAzimuth(id: string, center: number): number {
  return center + (((hashSeed(id) % 4096) / 4096) - 0.5) * 2 * SKY_FAN_HALF;
}

// Composition guard: nudge clouds apart until neighbours sit at least
// `minSep` radians apart (a few symmetric relax passes), clamped to the fan.
// Deterministic for a given cloud set — the sky reads balanced, never clumped.
export function spreadAzimuths(
  items: readonly { id: string; az: number }[],
  center: number,
  minSep: number,
): Map<string, number> {
  const sorted = items.map((item) => ({ id: item.id, az: item.az })).sort((a, b) => a.az - b.az || (a.id < b.id ? -1 : 1));
  const lo = center - SKY_FAN_HALF;
  const hi = center + SKY_FAN_HALF;
  for (let pass = 0; pass < 4; pass += 1) {
    for (let index = 1; index < sorted.length; index += 1) {
      const gap = sorted[index].az - sorted[index - 1].az;
      if (gap < minSep) {
        const push = (minSep - gap) / 2;
        sorted[index - 1].az = Math.max(lo, sorted[index - 1].az - push);
        sorted[index].az = Math.min(hi, sorted[index].az + push);
      }
    }
  }
  return new Map(sorted.map((item) => [item.id, item.az]));
}

// Deck altitude for an age norm: old clouds settle on the deck, fresh clouds
// lift toward the zenith (quadratic so the lift is spent early — recency pops).
export function cloudAltitude(norm: number, jitter: number): number {
  const lift = (1 - Math.max(0, Math.min(1, norm))) ** 2 * FRESH_LIFT;
  return SKY_ALT + lift + jitter;
}

// Kinship gravitation: pull toward the strongest partner's bearing, capped at
// 25% of the gap — neighborhoods form, identity stays ≥75% hash-anchored.
export function gravitatedAzimuth(az: number, partnerAz: number, strength: number): number {
  let gap = (partnerAz - az) % (Math.PI * 2);
  if (gap > Math.PI) {
    gap -= Math.PI * 2;
  } else if (gap < -Math.PI) {
    gap += Math.PI * 2;
  }
  const pull = Math.min(0.25, 0.25 * Math.max(0, Math.min(1, strength)));
  return az + gap * pull;
}

// ── how much was said → how much cloud ──────────────────────────────────────

// Lobe count grows log-with-turns: 1 turn → 11 lobes, 8+ → the full 16.
// (Round-2 beauty gate: a cloud must read as a stacked cumulus clump, so the
// lobe budget is a real clump, not a couple of overlapping sprites.)
export function puffCount(turnCount: number): number {
  const raw = 8 + Math.round(3 * Math.log2(1 + Math.max(0, turnCount)));
  return Math.max(8, Math.min(16, raw));
}

// Cloud radius (per-lobe scatter envelope), log-clamped so a marathon topic
// never swallows the sky. Sized against the under-deck vista: a fresh topic
// is unmistakably the big one, but bodies stay SMALLER than the gaps the
// azimuth spread guarantees — neighbouring clouds keep separate silhouettes
// (round-3 beauty gate: lobes must never fuse into one shared mass).
export function puffRadius(turnCount: number): number {
  return Math.min(6, 1.7 + 1.15 * Math.log2(1 + Math.max(0, turnCount)));
}

// Density/brightness over a cloud's life: full while ACTIVE, then a slow
// exponential thinning (10min half-ish life) — old clouds haze out, never pop.
export function lifeFactor(age: number): number {
  if (age < ACTIVE_MS) {
    return 1;
  }
  return 0.55 + 0.45 * Math.exp(-age / 600_000);
}

// Rim clouds dim toward stratus…
export function rimFactor(norm: number): number {
  return norm > RIM_NORM ? 0.7 : 1;
}

// …and flatten (vertical puff scatter scale).
export function rimFlatten(norm: number): number {
  return norm > RIM_NORM ? 0.5 : 1;
}

// ── data resolution (snapshot → renderable clouds) ──────────────────────────

// Structural refs only — ProjectorSnapshot's dialogue/dialogueTopics/sky
// fields satisfy these without this module importing scene or server types.
export interface SkyTurnRef {
  id: string;
  speaker: string | null;
  atMs: number;
  topicId?: string | null;
}

export interface SkyTopicRef {
  id: string;
  label: string;
  turnIds: string[];
  freshAtMs: number;
}

export interface SkyCloudRef {
  id: string;
  label: string;
  labelSource: "agent" | "topic";
  firstAtMs: number;
  freshAtMs: number;
  turnCount: number;
  liveTopicId: string | null;
  dominantSpeaker: string | null;
}

export interface SkyLinkRef {
  a: string;
  b: string;
  strength: number;
  reason?: string;
  source: "agent" | "lexical";
}

// A cloud the scene can mount: snapshot cloud + the live joins the renderer
// needs (freshest member turn = the pick target; null on memory clouds —
// nothing left to research, so honestly nothing to point at).
export interface ResolvedCloud extends SkyCloudRef {
  freshestTurnId: string | null;
}

// Unify the server sky with the degraded/legacy path: prefer `sky` (the
// beyond-the-window memory), else derive clouds from dialogueTopics so a
// server without the field still fills the ceiling. Keeps the MAX_SKY_CLOUDS
// freshest, presented oldest-first (stable render order).
export function resolveClouds(
  topics: readonly SkyTopicRef[],
  sky: { clouds: SkyCloudRef[] } | undefined,
  dialogue: readonly SkyTurnRef[],
): ResolvedCloud[] {
  const clouds: ResolvedCloud[] =
    sky !== undefined && sky.clouds.length > 0
      ? sky.clouds.map((cloud) => ({ ...cloud, freshestTurnId: freshestTurnFor(cloud.liveTopicId, topics, dialogue) }))
      : topics.map((topic) => {
          const members = dialogue.filter((turn) => (turn.topicId ?? null) === topic.id || topic.turnIds.includes(turn.id));
          return {
            id: topic.id,
            label: topic.label,
            labelSource: "topic" as const,
            firstAtMs: members.length > 0 ? Math.min(...members.map((turn) => turn.atMs)) : topic.freshAtMs,
            freshAtMs: topic.freshAtMs,
            turnCount: Math.max(topic.turnIds.length, members.length),
            liveTopicId: topic.id,
            dominantSpeaker: dominantSpeakerOf(members),
            freshestTurnId: freshestTurnFor(topic.id, topics, dialogue),
          };
        });
  return clouds
    .sort((a, b) => b.freshAtMs - a.freshAtMs)
    .slice(0, MAX_SKY_CLOUDS)
    .sort((a, b) => a.firstAtMs - b.firstAtMs);
}

// The freshest windowed turn of a live topic — the cloud's pick identity
// (the branch-tip precedent: picking a cloud researches its latest utterance).
function freshestTurnFor(
  liveTopicId: string | null,
  topics: readonly SkyTopicRef[],
  dialogue: readonly SkyTurnRef[],
): string | null {
  if (liveTopicId === null) {
    return null;
  }
  const topic = topics.find((entry) => entry.id === liveTopicId);
  let freshest: SkyTurnRef | null = null;
  for (const turn of dialogue) {
    const member = (turn.topicId ?? null) === liveTopicId || (topic !== undefined && topic.turnIds.includes(turn.id));
    if (member && (freshest === null || turn.atMs >= freshest.atMs)) {
      freshest = turn;
    }
  }
  return freshest?.id ?? null;
}

function dominantSpeakerOf(turns: readonly SkyTurnRef[]): string | null {
  const counts = new Map<string, number>();
  let dominant: string | null = null;
  let best = 0;
  for (const turn of turns) {
    if (turn.speaker === null) {
      continue;
    }
    const count = (counts.get(turn.speaker) ?? 0) + 1;
    counts.set(turn.speaker, count);
    if (count > best) {
      dominant = turn.speaker;
      best = count;
    }
  }
  return dominant;
}

// ── relations → wisps ───────────────────────────────────────────────────────

// Which links become visible wisps: every cloud's single strongest link plus
// anything ≥ WISP_MIN_STRENGTH, capped at MAX_WISPS strongest-first. Links
// touching a cloud that is not rendered are dropped (no dangling wisps).
export function selectWisps(links: readonly SkyLinkRef[], cloudIds: ReadonlySet<string>): SkyLinkRef[] {
  const usable = links.filter((link) => cloudIds.has(link.a) && cloudIds.has(link.b) && link.a !== link.b);
  const strongest = new Map<string, SkyLinkRef>();
  for (const link of usable) {
    for (const id of [link.a, link.b]) {
      const current = strongest.get(id);
      if (current === undefined || link.strength > current.strength) {
        strongest.set(id, link);
      }
    }
  }
  const anchors = new Set(strongest.values());
  const keep = new Set<SkyLinkRef>();
  for (const link of usable) {
    if (link.strength >= WISP_MIN_STRENGTH || anchors.has(link)) {
      keep.add(link);
    }
  }
  return [...keep].sort((a, b) => b.strength - a.strength).slice(0, MAX_WISPS);
}

// The strongest rendered partner of a cloud (gravitation target), or null.
export function strongestPartner(cloudId: string, wisps: readonly SkyLinkRef[]): { id: string; strength: number } | null {
  let best: { id: string; strength: number } | null = null;
  for (const link of wisps) {
    if (link.a !== cloudId && link.b !== cloudId) {
      continue;
    }
    const other = link.a === cloudId ? link.b : link.a;
    if (best === null || link.strength > best.strength) {
      best = { id: other, strength: link.strength };
    }
  }
  return best;
}

// ── research rain + merge choreography ──────────────────────────────────────

// Which cloud a quest's rain hangs under: its grounding turn's topic → the
// cloud backing that topic. Null → the zenith core (the quest's turn left the
// window and its cloud is gone or was never known).
export function questCloudId(
  questTurnId: string | null | undefined,
  dialogue: readonly SkyTurnRef[],
  clouds: readonly ResolvedCloud[],
): string | null {
  if (questTurnId === undefined || questTurnId === null) {
    return null;
  }
  const turn = dialogue.find((entry) => entry.id === questTurnId);
  const topicId = turn?.topicId ?? null;
  if (topicId === null) {
    return null;
  }
  return clouds.find((cloud) => cloud.liveTopicId === topicId || cloud.id === topicId)?.id ?? null;
}

// Where a vanished cloud glides before dissolving: the cloud now holding the
// MAJORITY of its last-known member turns (a merge/recluster absorbed it) —
// derived from real re-assignments, never invented. Null → fade in place.
export function mergeTarget(
  removedCloudId: string,
  lastMemberTurnIds: readonly string[],
  dialogue: readonly SkyTurnRef[],
  clouds: readonly ResolvedCloud[],
): string | null {
  const votes = new Map<string, number>();
  for (const turnId of lastMemberTurnIds) {
    const cloudId = questCloudId(turnId, dialogue, clouds);
    if (cloudId !== null && cloudId !== removedCloudId) {
      votes.set(cloudId, (votes.get(cloudId) ?? 0) + 1);
    }
  }
  let winner: string | null = null;
  let best = 0;
  for (const [cloudId, count] of votes) {
    if (count > best) {
      winner = cloudId;
      best = count;
    }
  }
  return winner !== null && best * 2 > lastMemberTurnIds.length ? winner : null;
}
