export const ROUTING_ENV_DEFAULTS = {
  VIBERSYN_WAKE_WORDS: "viber",
  VIBERSYN_MUTE_WORDS: "mute",
  VIBERSYN_UNMUTE_WORDS: "unmute",
  VIBERSYN_PANIC_WORDS: "abort",
  VIBERSYN_STOP_WORDS: "stop,halt",
  VIBERSYN_ACCEPT_WORDS: "yes,accept,do it",
  VIBERSYN_DECLINE_WORDS: "no,nah,skip",
  VIBERSYN_DONE_WORDS: "done,back",
  VIBERSYN_PAUSE_WORDS: "pause",
  VIBERSYN_RESUME_WORDS: "resume",
  VIBERSYN_PAUSE_ALL_WORDS: "pause all",
  VIBERSYN_STATUS_WORDS: "status",
  VIBERSYN_STEER_IDLE_SECONDS: "20",
  VIBERSYN_STEER_MIN_CONFIDENCE: "0.45",
} as const;

export type VocabularyEnvKey = keyof typeof ROUTING_ENV_DEFAULTS;

export type DocumentedCommandId =
  | "wake"
  | "accept"
  | "decline"
  | "selectAndSteer"
  | "selectOnly"
  | "steer"
  | "endSteering"
  | "pause"
  | "resume"
  | "pauseAll"
  | "status"
  | "stop"
  | "panic"
  | "mute"
  | "unmute";

export interface DocumentedCommand {
  id: DocumentedCommandId;
  spokenForm: string;
  effect: string;
}

export interface RoutingVocabulary {
  wake: string[];
  mute: string[];
  unmute: string[];
  panic: string[];
  stop: string[];
  accept: string[];
  decline: string[];
  done: string[];
  pause: string[];
  resume: string[];
  pauseAll: string[];
  status: string[];
  steerIdleSeconds: number;
  steerMinConfidence: number;
}

export const DOCUMENTED_COMMANDS: readonly DocumentedCommand[] = [
  { id: "wake", spokenForm: "Viber", effect: "opens active-listen window" },
  { id: "accept", spokenForm: "Yes / Accept / Do it", effect: "spawn from pending suggestion" },
  { id: "decline", spokenForm: "No / Nah / Skip", effect: "decline pending suggestion" },
  { id: "selectAndSteer", spokenForm: "[callsign], [instruction]", effect: "route instruction to process" },
  { id: "selectOnly", spokenForm: "[callsign]", effect: "open steering window" },
  { id: "steer", spokenForm: "[instruction] after select", effect: "route instruction to selected process" },
  { id: "endSteering", spokenForm: "Done / Back", effect: "close steering window" },
  { id: "pause", spokenForm: "[callsign], pause / Pause in window", effect: "pause target process" },
  { id: "resume", spokenForm: "[callsign], resume / Resume in window", effect: "resume target process" },
  { id: "pauseAll", spokenForm: "Pause all", effect: "pause all running processes" },
  { id: "status", spokenForm: "Status", effect: "speak active-process summary" },
  { id: "stop", spokenForm: "Stop / Halt", effect: "halt selected process" },
  { id: "panic", spokenForm: "Abort", effect: "panic halt and close windows" },
  { id: "mute", spokenForm: "mute", effect: "stop feeding the pipeline" },
  { id: "unmute", spokenForm: "unmute", effect: "resume feeding the pipeline" },
] as const;

export function loadRoutingVocabulary(env: Record<string, string | undefined> = process.env): RoutingVocabulary {
  return {
    wake: wordsFromEnv(env, "VIBERSYN_WAKE_WORDS"),
    mute: wordsFromEnv(env, "VIBERSYN_MUTE_WORDS"),
    unmute: wordsFromEnv(env, "VIBERSYN_UNMUTE_WORDS"),
    panic: wordsFromEnv(env, "VIBERSYN_PANIC_WORDS"),
    stop: wordsFromEnv(env, "VIBERSYN_STOP_WORDS"),
    accept: wordsFromEnv(env, "VIBERSYN_ACCEPT_WORDS"),
    decline: wordsFromEnv(env, "VIBERSYN_DECLINE_WORDS"),
    done: wordsFromEnv(env, "VIBERSYN_DONE_WORDS"),
    pause: wordsFromEnv(env, "VIBERSYN_PAUSE_WORDS"),
    resume: wordsFromEnv(env, "VIBERSYN_RESUME_WORDS"),
    pauseAll: wordsFromEnv(env, "VIBERSYN_PAUSE_ALL_WORDS"),
    status: wordsFromEnv(env, "VIBERSYN_STATUS_WORDS"),
    steerIdleSeconds: numberFromEnv(env, "VIBERSYN_STEER_IDLE_SECONDS"),
    steerMinConfidence: numberFromEnv(env, "VIBERSYN_STEER_MIN_CONFIDENCE"),
  };
}

export function includesPhrase(text: string, phrases: readonly string[]): boolean {
  return matchPhrase(text, phrases) !== undefined;
}

export function matchPhrase(text: string, phrases: readonly string[]): string | undefined {
  const normalized = normalizeSpeech(text);
  return [...phrases]
    .sort((left, right) => right.length - left.length || left.localeCompare(right))
    .find((phrase) => {
      const normalizedPhrase = normalizeSpeech(phrase);
      return new RegExp(`(^|\\s)${escapeRegex(normalizedPhrase)}(?=\\s|$)`, "u").test(normalized);
    });
}

export function normalizeSpeech(text: string): string {
  return text
    .toLowerCase()
    .replace(/['"]/gu, "")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function wordsFromEnv(env: Record<string, string | undefined>, key: VocabularyEnvKey): string[] {
  return (env[key] ?? ROUTING_ENV_DEFAULTS[key])
    .split(",")
    .map((word) => normalizeSpeech(word))
    .filter(Boolean);
}

function numberFromEnv(env: Record<string, string | undefined>, key: VocabularyEnvKey): number {
  const parsed = Number(env[key] ?? ROUTING_ENV_DEFAULTS[key]);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return Number(ROUTING_ENV_DEFAULTS[key]);
  }
  return parsed;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
