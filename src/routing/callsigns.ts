import type { LogEvent } from "../types";
import { loadRoutingVocabulary, normalizeSpeech } from "./vocabulary";

export const DEFAULT_CALLSIGN_POOL = [
  "virellium",
  "quoravex",
  "zelanori",
  "mavolune",
  "ruxalith",
  "nirevanta",
  "pelagorin",
  "tavirello",
  "kavorian",
  "lumeraxi",
  "doravelle",
  "fenorith",
] as const;

export const NATO_CALLSIGNS = ["alpha", "bravo", "charlie", "delta", "echo"] as const;
export const CALLSIGN_REUSE_COOLDOWN_MS = 60_000;
export const CALLSIGN_COLLISION_DISTANCE = 2;

export interface PhoneticProfile {
  normalized: string;
  metaphone: readonly [string, string];
  phonemes: string;
}

export interface CallsignCollision {
  candidate: string;
  existing: string;
  reason: "metaphone" | "phoneme-distance";
  candidateCodes: readonly [string, string];
  existingCodes: readonly [string, string];
  distance: number;
}

export interface CallsignValidationResult {
  accepted: boolean;
  profile: PhoneticProfile;
  collision: CallsignCollision | null;
}

export interface CallsignAssignment {
  upid: string;
  callsign: string;
  profile: PhoneticProfile;
  reusedAfterCooldown: boolean;
  poolIndex: number;
}

export interface CallsignAllocatorOptions {
  pool?: readonly string[];
  cooldownMs?: number;
  now?: () => number;
  reservedWords?: readonly string[];
}

export interface ActiveCallsign {
  upid: string;
  callsign: string;
}

export interface CallsignMatch {
  upid: string;
  callsign: string;
  instruction: string;
  utterance: string;
  concatenated: boolean;
}

export class CallsignAllocator {
  readonly #pool: readonly string[];
  readonly #cooldownMs: number;
  readonly #now: () => number;
  readonly #reservedWords: readonly string[];
  readonly #active = new Map<string, string>();
  readonly #cooldowns = new Map<string, number>();
  #nextIndex = 0;

  constructor(options: CallsignAllocatorOptions = {}) {
    this.#pool = options.pool ?? DEFAULT_CALLSIGN_POOL;
    this.#cooldownMs = options.cooldownMs ?? CALLSIGN_REUSE_COOLDOWN_MS;
    this.#now = options.now ?? (() => Date.now());
    this.#reservedWords = options.reservedWords ?? reservedControlWords();

    assertCallsignPool(this.#pool, this.#reservedWords);
  }

  syncActive(records: readonly ActiveCallsign[]): void {
    for (const record of records) {
      this.reserve(record.upid, record.callsign);
    }
  }

  assign(upid: string, proposed?: string | null): CallsignAssignment {
    const existing = this.#active.get(upid);
    if (existing !== undefined) {
      return {
        upid,
        callsign: existing,
        profile: phoneticProfile(existing),
        reusedAfterCooldown: false,
        poolIndex: this.#pool.indexOf(existing),
      };
    }

    if (proposed !== undefined && proposed !== null && normalizeCallsign(proposed).length > 0) {
      const callsign = normalizeCallsign(proposed);
      this.assertAvailable(callsign);
      this.reserve(upid, callsign);
      return {
        upid,
        callsign,
        profile: phoneticProfile(callsign),
        reusedAfterCooldown: this.wasCooledDown(callsign),
        poolIndex: this.#pool.indexOf(callsign),
      };
    }

    for (let offset = 0; offset < this.#pool.length; offset += 1) {
      const poolIndex = (this.#nextIndex + offset) % this.#pool.length;
      const candidate = normalizeCallsign(this.#pool[poolIndex]);
      if (!this.isAvailable(candidate)) {
        continue;
      }

      this.#nextIndex = (poolIndex + 1) % this.#pool.length;
      this.reserve(upid, candidate);
      return {
        upid,
        callsign: candidate,
        profile: phoneticProfile(candidate),
        reusedAfterCooldown: this.wasCooledDown(candidate),
        poolIndex,
      };
    }

    throw new Error("No non-colliding callsign is available.");
  }

  release(upid: string): string | undefined {
    const callsign = this.#active.get(upid);
    if (callsign === undefined) {
      return undefined;
    }

    this.#active.delete(upid);
    const now = this.#now();
    // Callsigns are mostly unique per process, so without pruning the map
    // grows by one entry per halted process forever. Pruning only here (not
    // in isCooldownExpired) keeps wasCooledDown() truthful within the
    // release -> cooldown -> reassign cycle.
    this.pruneExpiredCooldowns(now);
    this.#cooldowns.set(callsign, now);
    return callsign;
  }

  active(): ActiveCallsign[] {
    return [...this.#active.entries()].map(([upid, callsign]) => ({ upid, callsign }));
  }

  validate(candidate: string): CallsignValidationResult {
    return validateCallsignCandidate(candidate, [...this.#active.values()], this.#reservedWords);
  }

  private reserve(upid: string, callsign: string): void {
    const normalized = normalizeCallsign(callsign);
    this.#active.set(upid, normalized);
  }

  private assertAvailable(candidate: string): void {
    const validation = this.validate(candidate);
    if (!validation.accepted && process.env.VIBERSYN_RBG_DISABLE_CALLSIGN_COLLISION_GUARD !== "1") {
      const collision = validation.collision;
      throw new Error(
        collision === null
          ? `Callsign ${candidate} is not available.`
          : `Callsign ${candidate} collides with ${collision.existing} by ${collision.reason}.`,
      );
    }

    if (!this.isCooldownExpired(candidate)) {
      throw new Error(`Callsign ${candidate} is cooling down.`);
    }
  }

  private isAvailable(candidate: string): boolean {
    if (!this.isCooldownExpired(candidate)) {
      return false;
    }

    const validation = this.validate(candidate);
    return validation.accepted || process.env.VIBERSYN_RBG_DISABLE_CALLSIGN_COLLISION_GUARD === "1";
  }

  private isCooldownExpired(candidate: string): boolean {
    if (process.env.VIBERSYN_RBG_DISABLE_CALLSIGN_COOLDOWN === "1") {
      return true;
    }

    const releasedAt = this.#cooldowns.get(candidate);
    return releasedAt === undefined || this.#now() - releasedAt >= this.#cooldownMs;
  }

  private wasCooledDown(candidate: string): boolean {
    return this.#cooldowns.has(candidate);
  }

  private pruneExpiredCooldowns(now: number): void {
    for (const [callsign, releasedAt] of this.#cooldowns) {
      if (now - releasedAt >= this.#cooldownMs) {
        this.#cooldowns.delete(callsign);
      }
    }
  }
}

export function reservedControlWords(env: Record<string, string | undefined> = process.env): string[] {
  const vocabulary = loadRoutingVocabulary(env);
  return [
    ...vocabulary.wake,
    ...vocabulary.mute,
    ...vocabulary.unmute,
    ...vocabulary.panic,
    ...vocabulary.stop,
  ].map(normalizeCallsign);
}

export function assertCallsignPool(pool: readonly string[] = DEFAULT_CALLSIGN_POOL, reservedWords: readonly string[] = reservedControlWords()): void {
  const normalized = pool.map(normalizeCallsign);
  const duplicates = normalized.filter((entry, index) => normalized.indexOf(entry) !== index);
  if (duplicates.length > 0) {
    throw new Error(`Duplicate callsigns in pool: ${[...new Set(duplicates)].join(", ")}`);
  }

  for (const nato of NATO_CALLSIGNS) {
    if (normalized.includes(nato)) {
      throw new Error(`NATO callsign is not allowed in the V0 pool: ${nato}`);
    }
  }

  for (const candidate of normalized) {
    if (!/^[a-z]{3,}$/u.test(candidate) || syllableCount(candidate) < 3) {
      throw new Error(`Callsign must be coined and multi-syllable: ${candidate}`);
    }

    const validation = validateCallsignCandidate(candidate, normalized.filter((entry) => entry !== candidate), reservedWords);
    if (!validation.accepted) {
      throw new Error(`Callsign pool collision: ${candidate} collides with ${validation.collision?.existing ?? "unknown"}`);
    }
  }
}

export function validateCallsignCandidate(
  candidate: string,
  existing: readonly string[],
  reservedWords: readonly string[] = reservedControlWords(),
): CallsignValidationResult {
  const normalizedCandidate = normalizeCallsign(candidate);
  const profile = phoneticProfile(normalizedCandidate);
  const comparisons = [...existing, ...reservedWords].map(normalizeCallsign).filter(Boolean);

  for (const current of comparisons) {
    const other = phoneticProfile(current);
    const metaphoneCollision = profile.metaphone.some((code) => code.length > 0 && other.metaphone.includes(code));
    const distance = levenshtein(profile.phonemes, other.phonemes);
    if (metaphoneCollision) {
      return {
        accepted: false,
        profile,
        collision: {
          candidate: normalizedCandidate,
          existing: current,
          reason: "metaphone",
          candidateCodes: profile.metaphone,
          existingCodes: other.metaphone,
          distance,
        },
      };
    }

    if (distance <= CALLSIGN_COLLISION_DISTANCE) {
      return {
        accepted: false,
        profile,
        collision: {
          candidate: normalizedCandidate,
          existing: current,
          reason: "phoneme-distance",
          candidateCodes: profile.metaphone,
          existingCodes: other.metaphone,
          distance,
        },
      };
    }
  }

  return { accepted: true, profile, collision: null };
}

export function phoneticProfile(value: string): PhoneticProfile {
  const normalized = normalizeCallsign(value);
  return {
    normalized,
    metaphone: doubleMetaphone(normalized),
    phonemes: phonemeSignature(normalized),
  };
}

export function doubleMetaphone(value: string): [string, string] {
  const word = normalizeCallsign(value);
  if (word.length === 0) {
    return ["", ""];
  }

  const primary = metaphoneCode(word, false);
  const alternate = metaphoneCode(word, true);
  return [primary, alternate === primary ? "" : alternate];
}

export function phonemeLevenshtein(left: string, right: string): number {
  return levenshtein(phonemeSignature(left), phonemeSignature(right));
}

export function matchCallsignInUtterance(utterance: string, active: readonly ActiveCallsign[]): CallsignMatch | null {
  const ordered = [...active].sort((left, right) => right.callsign.length - left.callsign.length || left.callsign.localeCompare(right.callsign));
  for (const record of ordered) {
    const consumed = consumeCallsignPrefix(utterance, record.callsign);
    if (consumed === null) {
      continue;
    }

    const instruction = utterance
      .slice(consumed.endIndex)
      .replace(/^[^a-z0-9]+/iu, "")
      .replace(/[.?!]+$/u, "")
      .trim();
    return {
      upid: record.upid,
      callsign: normalizeCallsign(record.callsign),
      instruction,
      utterance,
      concatenated: consumed.concatenated,
    };
  }
  return null;
}

export function callsignLogEvent(input: {
  sessionId: string;
  correlationId: string;
  upid: string;
  assignment: CallsignAssignment;
  latencyMs: number;
}): LogEvent {
  return {
    level: "info",
    event: "command.callsign",
    sessionId: input.sessionId,
    correlationId: input.correlationId,
    upid: input.upid,
    latencyMs: input.latencyMs,
    meta: {
      callsign: input.assignment.callsign,
      metaphone: input.assignment.profile.metaphone,
      phonemes: input.assignment.profile.phonemes,
      reusedAfterCooldown: input.assignment.reusedAfterCooldown,
      poolIndex: input.assignment.poolIndex,
    },
  };
}

export function normalizeCallsign(value: string): string {
  return normalizeSpeech(value).replace(/[^a-z0-9]/gu, "");
}

function consumeCallsignPrefix(utterance: string, callsign: string): { endIndex: number; concatenated: boolean } | null {
  const target = normalizeCallsign(callsign);
  let matched = "";
  let started = false;
  let previousWasWord = false;

  for (let index = 0; index < utterance.length; index += 1) {
    const char = utterance[index];
    if (!/[a-z0-9]/iu.test(char)) {
      if (started && matched.length < target.length) {
        return null;
      }
      continue;
    }

    started = true;
    previousWasWord = true;
    matched += char.toLowerCase();
    if (!target.startsWith(matched)) {
      return null;
    }

    if (matched === target) {
      const next = utterance[index + 1] ?? "";
      return { endIndex: index + 1, concatenated: previousWasWord && /[A-Z0-9]/u.test(next) };
    }
  }

  return null;
}

function metaphoneCode(word: string, alternate: boolean): string {
  let index = 0;
  let code = "";
  const chars = word.replace(/^(?:kn|gn|pn|ae|wr)/u, (match) => match.slice(1));

  while (index < chars.length && code.length < 8) {
    const char = chars[index];
    const next = chars[index + 1] ?? "";
    const pair = chars.slice(index, index + 2);
    const triple = chars.slice(index, index + 3);

    if (isVowel(char)) {
      if (index === 0) code += "A";
      index += 1;
      continue;
    }

    if (char === next && char !== "c") {
      index += 1;
      continue;
    }

    switch (char) {
      case "b":
      case "p":
        code += pair === "ph" ? "F" : "P";
        index += pair === "ph" ? 2 : 1;
        break;
      case "c":
        if (pair === "ch") {
          code += alternate ? "K" : "X";
          index += 2;
        } else if (/[iey]/u.test(next)) {
          code += "S";
          index += 2;
        } else {
          code += "K";
          index += 1;
        }
        break;
      case "d":
        if (/^dg[iey]/u.test(triple)) {
          code += "J";
          index += 3;
        } else {
          code += "T";
          index += 1;
        }
        break;
      case "f":
      case "v":
        code += "F";
        index += 1;
        break;
      case "g":
        if (pair === "gh") {
          index += 2;
        } else if (/[iey]/u.test(next)) {
          code += alternate ? "K" : "J";
          index += 2;
        } else {
          code += "K";
          index += 1;
        }
        break;
      case "h":
        if (index === 0 || (isVowel(chars[index - 1] ?? "") && isVowel(next))) code += "H";
        index += 1;
        break;
      case "j":
        code += alternate ? "H" : "J";
        index += 1;
        break;
      case "k":
      case "q":
        code += "K";
        index += 1;
        break;
      case "l":
        code += "L";
        index += 1;
        break;
      case "m":
        code += "M";
        index += 1;
        break;
      case "n":
        code += "N";
        index += 1;
        break;
      case "r":
        code += "R";
        index += 1;
        break;
      case "s":
      case "z":
        if (pair === "sh" || /^si[ao]/u.test(triple)) {
          code += "X";
          index += pair === "sh" ? 2 : 3;
        } else {
          code += "S";
          index += 1;
        }
        break;
      case "t":
        if (/^ti[ao]/u.test(triple)) {
          code += "X";
          index += 3;
        } else if (pair === "th") {
          code += alternate ? "T" : "0";
          index += 2;
        } else {
          code += "T";
          index += 1;
        }
        break;
      case "w":
      case "y":
        if (isVowel(next)) code += char.toUpperCase();
        index += 1;
        break;
      case "x":
        code += "KS";
        index += 1;
        break;
      default:
        index += 1;
        break;
    }
  }

  return code;
}

function phonemeSignature(value: string): string {
  return normalizeCallsign(value)
    .replace(/ph/gu, "f")
    .replace(/gh/gu, "")
    .replace(/ch|sh/gu, "x")
    .replace(/th/gu, "0")
    .replace(/dg(?=[iey])/gu, "j")
    .replace(/g(?=[iey])/gu, "j")
    .replace(/[cqk]/gu, "k")
    .replace(/x/gu, "ks")
    .replace(/[sz]/gu, "s")
    .replace(/v/gu, "f")
    .replace(/y/gu, "i")
    .replace(/([aeiou])+/gu, "A")
    .replace(/(.)\1+/gu, "$1");
}

function levenshtein(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = Array.from({ length: right.length + 1 }, () => 0);

  for (let i = 1; i <= left.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[right.length];
}

function syllableCount(value: string): number {
  return normalizeCallsign(value).match(/[aeiouy]+/gu)?.length ?? 1;
}

function isVowel(value: string): boolean {
  return /^[aeiouy]$/u.test(value);
}
