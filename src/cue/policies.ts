import type { CueCoreModule } from "./source";

export const DEFAULT_TEXT_CUE_WORDS = [
  "panop",
  "build",
  "cometa",
  "yes",
  "accept",
  "do it",
  "mute",
  "unmute",
  "abort",
] as const;

export interface CuePolicyConfig {
  textCueWords?: readonly string[];
  minWords?: number;
  idleSeconds?: number;
  intervalSeconds?: number;
  cooldownSeconds?: number;
}

export interface CuePolicySet {
  cues: unknown[];
  textCueWords: string[];
  minWords: number;
  idleSeconds: number;
  intervalSeconds: number;
  cooldownSeconds: number;
  risks: string[];
}

export function createCuePolicies(cue: CueCoreModule, config: CuePolicyConfig = {}): CuePolicySet {
  const textCueWords = [...(config.textCueWords ?? DEFAULT_TEXT_CUE_WORDS)];
  const minWords = config.minWords ?? numberFromEnv("SUGGEST_MIN_WORDS", 60);
  const idleSeconds = config.idleSeconds ?? numberFromEnv("SUGGEST_IDLE_SECONDS", 10);
  const intervalSeconds = config.intervalSeconds ?? numberFromEnv("SUGGEST_INTERVAL_SECONDS", 180);
  const cooldownSeconds = config.cooldownSeconds ?? numberFromEnv("SUGGEST_COOLDOWN_SECONDS", 180);

  return {
    cues: [
      new cue.TextCue(textCueWords, { cooldownSeconds }),
      new cue.WordCountCue(minWords),
      new cue.IdleCue({ thresholdSeconds: idleSeconds }),
      new cue.IntervalCue(intervalSeconds),
    ],
    textCueWords,
    minWords,
    idleSeconds,
    intervalSeconds,
    cooldownSeconds,
    risks: [
      "D2: IntervalCue cooldown is adapter-owned by combining IntervalCue with TextCue cooldownSeconds.",
    ],
  };
}

export function assertPrematcherParity(textCueWords: readonly string[], prematcherWords: readonly string[]): void {
  const cueWords = JSON.stringify([...textCueWords]);
  const mirrorWords = JSON.stringify([...prematcherWords]);
  if (cueWords !== mirrorWords) {
    throw new Error(`Adapter pre-matcher word list drifted from TextCue config: ${mirrorWords} !== ${cueWords}`);
  }
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return value;
}
