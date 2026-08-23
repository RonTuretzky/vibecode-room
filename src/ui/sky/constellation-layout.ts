// ── constellation-sky layout (pure, unit-tested) ────────────────────────────
// The ceiling is a STAR CHART of the evening: TIME FLOWS WEST→EAST AT BOTH
// SCALES. The band of constellations sweeps the visible fan in topic-founding
// order (oldest west, newest east), and inside each constellation the
// asterism line traces its turns in spoken order along the same eastward
// tangent. Radius keeps the surviving recency law (fresh near the zenith
// core, stale toward the horizon — radiusNorm/staggeredRadius unchanged from
// the cloud sky), so a topic revisited late rides back toward the core in its
// ORIGINAL azimuth slot: revisiting reads as an old constellation waking.
// STARS = turns (speaker-colored, word-count-sized). LINES = chronology.
// PLANETS = research quests. DUST = babble — present, faint, never named,
// never connected. Everything here is pure numbers — no renderer, no DOM —
// cloning the cloud-layout.ts discipline so the sky stays testable.

import { hashSeed } from "../tree/spec";
import {
  ACTIVE_MS,
  R_CORE,
  R_HORIZON,
  SKY_ALT,
  SKY_FAN_HALF,
  cloudAge,
  cloudRadius,
  lifeFactor,
  radiusNorm,
  resolveClouds,
  spreadAzimuths,
  staggeredRadius,
  type ResolvedCloud,
  type SkyTopicRef,
  type SkyTurnRef,
} from "./cloud-layout";

// SURVIVORS re-exported verbatim: the recency laws, the data resolution, the
// relation selection, and the quest/merge choreography all carry over — the
// constellation sky changes WHAT renders, not what the data means.
export {
  ACTIVE_MS,
  AGE_KNEE,
  AGE_SPAN,
  MAX_WISPS,
  R_CORE,
  R_HORIZON,
  SKY_ALT,
  SKY_FAN_HALF,
  WISP_MIN_STRENGTH,
  cloudAge,
  cloudRadius,
  lifeFactor,
  mergeTarget,
  questCloudId,
  radiusNorm,
  resolveClouds,
  selectWisps,
  spreadAzimuths,
  staggeredRadius,
  strongestPartner,
  type ResolvedCloud,
  type SkyCloudRef,
  type SkyLinkRef,
  type SkyTopicRef,
  type SkyTurnRef,
} from "./cloud-layout";

// ── render caps ─────────────────────────────────────────────────────────────
export const MAX_SKY_CONSTELLATIONS = 12;
// Stars per constellation on screen: up to 12 retired gists + the live
// window members of its topic.
export const MAX_STARS_PER_CONST = 24;
export const MAX_DUST = 48;
// The band spans this fraction of the visible fan (the rim pair sits just
// inside the frame edges).
export const BAND_EDGE = 0.92;
// Fresh constellations lift above the deck (quadratic in recency — the lift
// is spent early, so sinking = aging at a glance).
export const CONST_LIFT = 2.2;
// Per-star vertical jitter inside the asterism (organic, deterministic).
export const STAR_ALT_JITTER = 1.2;
// A polyline segment whose endpoints are further apart in TIME than this
// renders faint — the "return line" when a topic is revisited much later.
export const SEGMENT_GAP_FAINT_MS = 120_000;
export const SEGMENT_GAP_FAINT_FACTOR = 0.35;
// Old asterisms dim with lifeFactor but never vanish.
export const CONST_BRIGHTNESS_FLOOR = 0.3;
// Star alphas: live window turns burn full; retired gists sit back.
export const STAR_ALPHA_LIVE = 1.0;
export const STAR_ALPHA_RETIRED = 0.7;

// Deterministic 0..1 hash (identity-stable per id for the whole session).
export function hash01(key: string): number {
  return (hashSeed(key) % 4096) / 4096;
}

// ── the band law: azimuth = founding chronology ─────────────────────────────
// Rank constellations by firstAtMs ascending; slot i of N sits at
// center + SKY_FAN_HALF·BAND_EDGE·(2·(i+0.5)/N − 1). Founding a NEW topic
// slides every older constellation monotonically WEST (smaller azimuth) — the
// sky visibly rotates as the session progresses. spreadAzimuths stays as a
// guard (a no-op at band spacing, but law, not luck).
export function bandAzimuths(
  constellations: readonly { id: string; firstAtMs: number }[],
  fanCenter: number,
): Map<string, number> {
  const ranked = [...constellations].sort(
    (a, b) => a.firstAtMs - b.firstAtMs || (a.id < b.id ? -1 : 1),
  );
  const n = ranked.length;
  const raw = ranked.map((entry, index) => ({
    id: entry.id,
    az: fanCenter + SKY_FAN_HALF * BAND_EDGE * ((2 * (index + 0.5)) / n - 1),
  }));
  const minSep = Math.min(0.22, 1.7 / Math.max(n, 1));
  return spreadAzimuths(raw, fanCenter, minSep);
}

// ── the anchor: chronological bearing × recency radius ──────────────────────
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export function constellationAnchor(id: string, az: number, ageMs: number): Vec3 {
  const radius = staggeredRadius(id, ageMs);
  const norm = radiusNorm(ageMs);
  const alt = SKY_ALT + (1 - norm) * (1 - norm) * CONST_LIFT;
  return { x: Math.sin(az) * radius, y: alt, z: Math.cos(az) * radius };
}

// ── the stars: retired gists + live window members, chronological ───────────
export interface ConstellationStar {
  id: string;
  atMs: number;
  speaker: string | null;
  text: string; // the gist (retired) or the live turn text
  live: boolean;
}

// Merge a cloud's retained star gists with the live window members of its
// topic (joined via topicId/turnIds — live stars are NOT duplicated over the
// SSE pipe). Chronological; past the cap the oldest drop and are counted
// beside the server's own elidedCount — elided history is honest, never
// silent.
export function constellationStars(
  cloud: Pick<ResolvedCloud, "id" | "liveTopicId"> & {
    stars?: Array<{ id: string; atMs: number; speaker: string | null; gist: string }>;
    elidedCount?: number;
  },
  topics: readonly SkyTopicRef[],
  dialogue: readonly (SkyTurnRef & { text?: string })[],
): { stars: ConstellationStar[]; elided: number } {
  const stars: ConstellationStar[] = [];
  const seen = new Set<string>();
  const topic = cloud.liveTopicId !== null ? topics.find((entry) => entry.id === cloud.liveTopicId) : undefined;
  for (const turn of dialogue) {
    const member =
      cloud.liveTopicId !== null &&
      ((turn.topicId ?? null) === cloud.liveTopicId || (topic !== undefined && topic.turnIds.includes(turn.id)));
    if (member && !seen.has(turn.id)) {
      seen.add(turn.id);
      stars.push({ id: turn.id, atMs: turn.atMs, speaker: turn.speaker, text: turn.text ?? "", live: true });
    }
  }
  for (const star of cloud.stars ?? []) {
    if (!seen.has(star.id)) {
      seen.add(star.id);
      stars.push({ id: star.id, atMs: star.atMs, speaker: star.speaker, text: star.gist, live: false });
    }
  }
  stars.sort((a, b) => a.atMs - b.atMs || (a.id < b.id ? -1 : 1));
  let elided = cloud.elidedCount ?? 0;
  if (stars.length > MAX_STARS_PER_CONST) {
    elided += stars.length - MAX_STARS_PER_CONST;
    stars.splice(0, stars.length - MAX_STARS_PER_CONST);
  }
  return { stars, elided };
}

// ── the asterism walk: star positions, chronology along the tangent ─────────
// Stars in atMs order walk monotonically EASTWARD along the band tangent with
// a deterministic per-star radial/vertical zigzag: reads as a real asterism
// AND as a timeline. Patch half-length grows log with member count.
export function asterismHalfLength(starCount: number): number {
  return Math.min(4.2, 1.4 + 0.85 * Math.log2(1 + Math.max(0, starCount)));
}

export function asterismPositions(
  anchor: Vec3,
  az: number,
  stars: readonly { id: string }[],
): Vec3[] {
  const n = stars.length;
  const half = asterismHalfLength(n);
  // Eastward tangent of the circle at this bearing (+azimuth direction) and
  // the radial unit — scene convention (sin az·r, alt, cos az·r).
  const tx = Math.cos(az);
  const tz = -Math.sin(az);
  const px = Math.sin(az);
  const pz = Math.cos(az);
  return stars.map((star, index) => {
    const along = n === 1 ? 0.5 : index / (n - 1);
    const t = half * (2 * along - 1);
    const radial = (hash01(`sp:${star.id}`) - 0.5) * 0.9 * half * 0.5;
    const lift = (hash01(`sy:${star.id}`) - 0.5) * STAR_ALT_JITTER;
    return {
      x: anchor.x + tx * t + px * radial,
      y: anchor.y + lift,
      z: anchor.z + tz * t + pz * radial,
    };
  });
}

// ── star + line + dust laws ─────────────────────────────────────────────────
// Star screen size (shader px before the distance idiom): word count = how
// much was said in that turn.
export function starSize(wordCount: number): number {
  return Math.max(4, Math.min(9, 4 + 1.5 * Math.log2(1 + Math.max(0, wordCount))));
}

// Per-constellation brightness: full while ACTIVE, dimming with lifeFactor,
// floored — old asterisms dim, never vanish.
export function constellationBrightness(ageMs: number): number {
  return Math.max(CONST_BRIGHTNESS_FLOOR, lifeFactor(ageMs));
}

// Chronology-line alpha factor for a segment spanning a time gap: a revisit
// (>2min between consecutive members) renders as the faint return line.
export function segmentAlphaFactor(gapMs: number): number {
  return gapMs > SEGMENT_GAP_FAINT_MS ? SEGMENT_GAP_FAINT_FACTOR : 1;
}

// DUST: chronological too (west = session start, east = now), parked below
// the band, staggered by recency radius. Never connected, never labeled,
// never pickable.
export const DUST_ALT_DROP = 0.8;
export function dustPosition(
  id: string,
  atMs: number,
  sessionStartMs: number,
  nowMs: number,
  fanCenter: number,
): Vec3 {
  const span = Math.max(1, nowMs - sessionStartMs);
  const q = Math.max(0, Math.min(1, (atMs - sessionStartMs) / span));
  const az = fanCenter + SKY_FAN_HALF * BAND_EDGE * (2 * q - 1);
  const radius = Math.min(
    R_HORIZON,
    Math.max(R_CORE * 0.7, cloudRadius(Math.max(0, nowMs - atMs)) + (hash01(`dust:${id}`) - 0.5) * 2.4),
  );
  return { x: Math.sin(az) * radius, y: SKY_ALT - DUST_ALT_DROP, z: Math.cos(az) * radius };
}

// ── data resolution: rendered constellations ────────────────────────────────
// resolveClouds (survivor) keeps the freshest 14; the constellation band
// renders the freshest MAX_SKY_CONSTELLATIONS, presented oldest-first so the
// band rank IS the founding chronology.
export function resolveConstellations(
  topics: readonly SkyTopicRef[],
  sky: { clouds: import("./cloud-layout").SkyCloudRef[] } | undefined,
  dialogue: readonly SkyTurnRef[],
): ResolvedCloud[] {
  return resolveClouds(topics, sky, dialogue)
    .sort((a, b) => b.freshAtMs - a.freshAtMs)
    .slice(0, MAX_SKY_CONSTELLATIONS)
    .sort((a, b) => a.firstAtMs - b.firstAtMs);
}

// ── the single NOW law ──────────────────────────────────────────────────────
// Exactly one star may claim the present: the freshest LIVE star of the
// freshest ACTIVE constellation. Null when nothing is active (an idle sky has
// no NOW — honesty over decoration).
export function nowStarId(
  constellations: readonly { id: string; freshAtMs: number }[],
  starsById: ReadonlyMap<string, readonly ConstellationStar[]>,
  nowMs: number,
): { constellationId: string; starId: string } | null {
  let bestConst: { id: string; freshAtMs: number } | null = null;
  for (const entry of constellations) {
    if (cloudAge(nowMs, entry.freshAtMs) < ACTIVE_MS && (bestConst === null || entry.freshAtMs > bestConst.freshAtMs)) {
      bestConst = entry;
    }
  }
  if (bestConst === null) {
    return null;
  }
  const stars = starsById.get(bestConst.id) ?? [];
  let freshest: ConstellationStar | null = null;
  for (const star of stars) {
    if (star.live && (freshest === null || star.atMs > freshest.atMs)) {
      freshest = star;
    }
  }
  return freshest === null ? null : { constellationId: bestConst.id, starId: freshest.id };
}
