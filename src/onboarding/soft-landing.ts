import { DOCUMENTED_COMMANDS, normalizeSpeech, type DocumentedCommand, type DocumentedCommandId } from "../routing/vocabulary";
import type { CueDecision, TranscriptObservation } from "../types";

export const NEAR_MISS_MAX_DISTANCE = 2;
export const NEAR_MISS_DISABLE_AFTER_MS = 20 * 60 * 1_000;

export type NearMissResult =
  | {
      kind: "near-miss";
      commandId: DocumentedCommandId;
      phrase: string;
      distance: number;
      text: string;
      disabled: false;
    }
  | { kind: "none"; disabled: false }
  | { kind: "disabled"; disabled: true };

export interface NearMissSoftLandingOptions {
  sessionStartedAtMs: number;
  clock?: () => number;
  commands?: readonly DocumentedCommand[];
  maxDistance?: number;
  disableAfterMs?: number;
}

interface CommandPhrase {
  commandId: DocumentedCommandId;
  phrase: string;
  normalized: string;
}

export class NearMissSoftLanding {
  readonly #sessionStartedAtMs: number;
  readonly #clock: () => number;
  readonly #phrases: readonly CommandPhrase[];
  readonly #maxDistance: number;
  readonly #disableAfterMs: number;

  constructor(options: NearMissSoftLandingOptions) {
    this.#sessionStartedAtMs = options.sessionStartedAtMs;
    this.#clock = options.clock ?? (() => performance.now());
    this.#phrases = documentedCommandPhrases(options.commands ?? DOCUMENTED_COMMANDS);
    this.#maxDistance = options.maxDistance ?? NEAR_MISS_MAX_DISTANCE;
    this.#disableAfterMs = options.disableAfterMs ?? NEAR_MISS_DISABLE_AFTER_MS;
  }

  evaluate(text: string): NearMissResult {
    if (this.#clock() - this.#sessionStartedAtMs >= this.#disableAfterMs) {
      return { kind: "disabled", disabled: true };
    }

    const candidates = normalizedUtteranceCandidates(text);
    if (candidates.length === 0) {
      return { kind: "none", disabled: false };
    }

    let best: (CommandPhrase & { distance: number }) | null = null;
    for (const candidate of candidates) {
      for (const phrase of this.#phrases) {
        if (candidate === phrase.normalized) {
          return { kind: "none", disabled: false };
        }

        const distance = levenshtein(candidate, phrase.normalized);
        if (distance <= this.#maxDistance && (best === null || distance < best.distance)) {
          best = { ...phrase, distance };
        }
      }
    }

    if (best === null) {
      return { kind: "none", disabled: false };
    }

    return {
      kind: "near-miss",
      commandId: best.commandId,
      phrase: best.phrase,
      distance: best.distance,
      text: `Did you mean "${best.phrase}"?`,
      disabled: false,
    };
  }

  toCueDecision(observation: TranscriptObservation, result: NearMissResult, decisionId: string, correlationId: string): CueDecision | null {
    if (result.kind !== "near-miss") {
      return null;
    }

    return {
      kind: "pass",
      addressed: true,
      reason: "near-miss",
      policy: "onboarding.near-miss-soft-landing",
      decisionId,
      correlationId,
      meta: {
        utteranceId: observation.utteranceId,
        suggestion: result.text,
        commandId: result.commandId,
        phrase: result.phrase,
        distance: result.distance,
      },
    };
  }
}

export function documentedCommandPhrases(commands: readonly DocumentedCommand[] = DOCUMENTED_COMMANDS): CommandPhrase[] {
  const phrases: CommandPhrase[] = [];

  for (const command of commands) {
    for (const phrase of command.spokenForm.split(/\s*\/\s*/u)) {
      const normalized = normalizeSpeech(phrase);
      if (normalized.length === 0 || /\[|\]/u.test(phrase)) {
        continue;
      }
      phrases.push({ commandId: command.id, phrase: normalized, normalized });
    }
  }

  return phrases;
}

export function levenshtein(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_unused, index) => index);
  const current = Array.from({ length: right.length + 1 }, () => 0);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        previous[rightIndex - 1] + substitutionCost,
      );
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[right.length] ?? 0;
}

function normalizedUtteranceCandidates(text: string): string[] {
  const normalized = normalizeSpeech(text);
  if (normalized.length === 0) {
    return [];
  }

  const withoutWake = normalized.replace(/^panop\s+/u, "");
  const candidates = new Set([normalized, withoutWake]);
  const words = withoutWake.split(/\s+/u).filter(Boolean);
  for (const word of words) {
    candidates.add(word);
  }
  return [...candidates].filter(Boolean);
}
