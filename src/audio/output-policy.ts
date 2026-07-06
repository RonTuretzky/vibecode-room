import type { AckId, OutputDecision } from "../types";
import type { TTSProvider } from "../providers";
import { playAck, type AudioDispatchMeta, type AudioOutput } from "./earcons";

export const DEFAULT_OUTPUT_MAX_WORDS = 15;
export const DEFAULT_OUTPUT_ROUND_TRIP_BUDGET_MS = 1_500;
export const DEFAULT_OUTPUT_WORKING_ACK_REPEAT_MS = 1_500;
export const DEFAULT_OUTPUT_SILENCE_TARGET = 0.9;
export const DEFAULT_OUTPUT_SUMMARY_MODEL = "hot-loop-cheap-fast";

export const OUTPUT_POLICY_ENV_DEFAULTS = Object.freeze({
  VIBERSYN_OUTPUT_MAX_WORDS: String(DEFAULT_OUTPUT_MAX_WORDS),
  VIBERSYN_OUTPUT_ROUND_TRIP_BUDGET_MS: String(DEFAULT_OUTPUT_ROUND_TRIP_BUDGET_MS),
  VIBERSYN_OUTPUT_WORKING_ACK_REPEAT_MS: String(DEFAULT_OUTPUT_WORKING_ACK_REPEAT_MS),
  VIBERSYN_OUTPUT_SILENCE_TARGET: String(DEFAULT_OUTPUT_SILENCE_TARGET),
  VIBERSYN_OUTPUT_SUMMARY_MODEL: DEFAULT_OUTPUT_SUMMARY_MODEL,
});

export const FIXED_STATE_PHRASES = ["Ready", "Muted", "Unmuted", "Working", "Halted"] as const;

export type OutputChannel = OutputDecision["channel"];

export type OutputTriggerClass =
  | "unknown"
  | "ignored-ambient"
  | "observe.pass"
  | "route.pass"
  | "cue.text"
  | "route.suggestion"
  | "route.steer"
  | "route.declined"
  | "mute"
  | "unmute"
  | "halt"
  | "resolve"
  | "substantive"
  | "timeout.working";

export interface OutputPolicyConfig {
  maxWords: number;
  roundTripBudgetMs: number;
  workingAckRepeatMs: number;
  silenceTarget: number;
  summaryModel: string;
}

export interface OutputPlan {
  trigger: OutputTriggerClass;
  decisions: OutputDecision[];
  primaryChannel: OutputChannel;
}

export interface OutputPolicyInput {
  trigger: OutputTriggerClass;
  text?: string;
  addressed?: boolean;
  explicit?: boolean;
  correlationId?: string;
}

export interface SummaryInput {
  text: string;
  maxWords: number;
  model: string;
}

export interface HotLoopSummaryLLM {
  summarize(input: SummaryInput): Promise<string> | string;
}

export type HotLoopSummarizer = HotLoopSummaryLLM;
export type OutputTrigger = OutputPolicyInput;

export interface OutputPolicyOptions {
  summarizer?: HotLoopSummaryLLM;
  config?: Partial<OutputPolicyConfig>;
}

export interface WorkingAckSchedulerOptions {
  output?: AudioOutput;
  onAck?: (id: AckId, meta?: AudioDispatchMeta) => void | Promise<void>;
  budgetMs?: number;
  repeatMs?: number;
  setTimeoutFn?: TimerSetter;
  clearTimeoutFn?: TimerClearer;
  setIntervalFn?: IntervalSetter;
  clearIntervalFn?: IntervalClearer;
}

export function readOutputPolicyConfig(env: Record<string, string | undefined> = process.env): OutputPolicyConfig {
  return {
    maxWords: envPositiveInteger(env, "VIBERSYN_OUTPUT_MAX_WORDS", DEFAULT_OUTPUT_MAX_WORDS),
    roundTripBudgetMs: envPositiveInteger(env, "VIBERSYN_OUTPUT_ROUND_TRIP_BUDGET_MS", DEFAULT_OUTPUT_ROUND_TRIP_BUDGET_MS),
    workingAckRepeatMs: envPositiveInteger(env, "VIBERSYN_OUTPUT_WORKING_ACK_REPEAT_MS", DEFAULT_OUTPUT_WORKING_ACK_REPEAT_MS),
    silenceTarget: envRatio(env, "VIBERSYN_OUTPUT_SILENCE_TARGET", DEFAULT_OUTPUT_SILENCE_TARGET),
    summaryModel: env.VIBERSYN_OUTPUT_SUMMARY_MODEL?.trim() || DEFAULT_OUTPUT_SUMMARY_MODEL,
  };
}

export async function decideOutput(
  input: OutputPolicyInput,
  options: { summarizer?: HotLoopSummaryLLM; config?: Partial<OutputPolicyConfig> } = {},
): Promise<OutputPlan> {
  const config = { ...readOutputPolicyConfig(), ...options.config };

  switch (input.trigger) {
    case "cue.text":
      return plan(input.trigger, [{ channel: "earcon", id: "E1" }]);
    case "route.suggestion":
      return routeAck(input, "route-suggestion");
    case "route.steer":
      return routeAck(input, "route-steer");
    case "route.declined":
      return routeAck(input, "route-declined");
    case "mute":
      return plan(input.trigger, [
        { channel: "earcon", id: "mute-tone" },
        { channel: "tts", text: "Muted", wordCount: 1, summarized: false },
      ]);
    case "unmute":
      return plan(input.trigger, [{ channel: "earcon", id: "E2" }]);
    case "halt": {
      const tts = await ttsDecision(input.text ?? "Halted", {
        config,
        summarizer: options.summarizer,
        fallback: "Halted",
      });
      return plan(input.trigger, [{ channel: "earcon", id: "E5" }, tts]);
    }
    case "resolve":
      return plan(input.trigger, [{ channel: "earcon", id: "E4" }]);
    case "substantive":
      return plan(input.trigger, [
        await ttsDecision(input.text ?? "", {
          config,
          summarizer: options.summarizer,
          fallback: "Updated",
        }),
      ]);
    case "timeout.working":
      return plan(input.trigger, [{ channel: "ack", id: "working" }]);
    case "ignored-ambient":
    case "observe.pass":
    case "route.pass":
    case "unknown":
      return silentPlan(input.trigger);
    default:
      assertNever(input.trigger);
  }
}

export async function ttsDecision(
  text: string,
  options: {
    config?: Partial<OutputPolicyConfig>;
    summarizer?: HotLoopSummaryLLM;
    fallback?: string;
  } = {},
): Promise<Extract<OutputDecision, { channel: "tts" }>> {
  const config = { ...readOutputPolicyConfig(), ...options.config };
  const cleaned = stripNeverRecite(text);
  const fallback = options.fallback ?? "Updated";
  const initial = cleaned.length === 0 ? fallback : cleaned;
  const initialWords = countWords(initial);
  let spoken = initial;
  let summarized = false;

  if (initialWords > config.maxWords) {
    summarized = true;
    const summary = await options.summarizer?.summarize({
      text: initial,
      maxWords: config.maxWords,
      model: config.summaryModel,
    });
    spoken = stripNeverRecite(typeof summary === "string" && summary.trim().length > 0 ? summary : deterministicSummary(initial, config.maxWords));
  }

  spoken = clampWords(spoken, config.maxWords);
  if (spoken.length === 0) {
    spoken = fallback;
  }

  return {
    channel: "tts",
    text: spoken,
    wordCount: countWords(spoken),
    summarized,
  };
}

export function stripNeverRecite(text: string): string {
  return text
    .split(/\r?\n/u)
    .filter((line) => !/^\s*(?:at\s+\S+|\+\+\+|---|@@|\+|-|diff\s+--git\b)/u.test(line))
    .join(" ")
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/https?:\/\/\S+/giu, " ")
    .replace(/\b(?:[\w.-]+\/)+[\w.-]+\b/giu, " ")
    .replace(/\b[\w.-]+\.(?:ts|tsx|js|jsx|json|md|html|css|log|diff|patch)\b(?::\d+(?::\d+)?)?/giu, " ")
    .replace(/\b(?:Error|TypeError|ReferenceError|SyntaxError):/gu, "error")
    .replace(/[{}[\]`<>]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function countWords(text: string): number {
  const matches = text.trim().match(/[\p{L}\p{N}]+(?:['-][\p{L}\p{N}]+)*/gu);
  return matches?.length ?? 0;
}

export async function precacheFixedStatePhrases(tts: TTSProvider): Promise<void> {
  await precacheStatePhrases(tts);
}

export async function precacheStatePhrases(
  tts: TTSProvider,
  options: { voice?: string; phrases?: readonly string[] } = {},
): Promise<readonly string[]> {
  const phrases = options.phrases ?? FIXED_STATE_PHRASES;
  for (const phrase of phrases) {
    await tts.speak(phrase, options.voice === undefined ? undefined : { voice: options.voice });
  }
  return phrases;
}

export function silenceRatio(plans: readonly OutputPlan[]): number {
  if (plans.length === 0) {
    return 1;
  }
  const silent = plans.filter((entry) => entry.primaryChannel === "silent").length;
  return silent / plans.length;
}

export function meetsSilenceTarget(plans: readonly OutputPlan[], target = readOutputPolicyConfig().silenceTarget): boolean {
  return silenceRatio(plans) >= target;
}

export class WorkingAckScheduler {
  readonly #output?: AudioOutput;
  readonly #onAck?: WorkingAckSchedulerOptions["onAck"];
  readonly #budgetMs: number;
  readonly #repeatMs: number;
  readonly #setTimeout: TimerSetter;
  readonly #clearTimeout: TimerClearer;
  readonly #setInterval: IntervalSetter;
  readonly #clearInterval: IntervalClearer;
  #timeout: TimerHandle | undefined;
  #interval: IntervalHandle | undefined;
  #meta: AudioDispatchMeta = {};

  constructor(options: WorkingAckSchedulerOptions = {}) {
    const config = readOutputPolicyConfig();
    this.#output = options.output;
    this.#onAck = options.onAck;
    this.#budgetMs = options.budgetMs ?? config.roundTripBudgetMs;
    this.#repeatMs = options.repeatMs ?? config.workingAckRepeatMs;
    this.#setTimeout = options.setTimeoutFn ?? setTimeout;
    this.#clearTimeout = options.clearTimeoutFn ?? clearTimeout;
    this.#setInterval = options.setIntervalFn ?? setInterval;
    this.#clearInterval = options.clearIntervalFn ?? clearInterval;
  }

  start(meta: AudioDispatchMeta = {}): void {
    this.stop();
    this.#meta = meta;
    this.#timeout = this.#setTimeout(() => {
      void this.#emit();
      this.#interval = this.#setInterval(() => {
        void this.#emit();
      }, this.#repeatMs);
    }, this.#budgetMs);
  }

  substantiveAckArrived(): void {
    this.stop();
  }

  stop(): void {
    if (this.#timeout !== undefined) {
      this.#clearTimeout(this.#timeout);
      this.#timeout = undefined;
    }
    if (this.#interval !== undefined) {
      this.#clearInterval(this.#interval);
      this.#interval = undefined;
    }
  }

  async #emit(): Promise<void> {
    await this.#onAck?.("working", this.#meta);
    if (this.#output !== undefined) {
      await playAck(this.#output, "working", this.#meta);
    }
  }
}

export class OutputPolicy {
  readonly #plans: OutputPlan[] = [];
  readonly #options: OutputPolicyOptions;

  constructor(options: OutputPolicyOptions = {}) {
    this.#options = options;
  }

  async decide(input: OutputPolicyInput): Promise<OutputDecision[]> {
    const output = await decideOutput(input, this.#options);
    this.#plans.push(output);
    return output.decisions;
  }

  silenceRatio(): number {
    return silenceRatio(this.#plans);
  }

  meetsSilenceTarget(): boolean {
    return meetsSilenceTarget(this.#plans, { ...readOutputPolicyConfig(), ...this.#options.config }.silenceTarget);
  }
}

export interface WorkingAckLoopOptions {
  emit: (decision: OutputDecision) => void | Promise<void>;
  roundTripBudgetMs?: number;
  repeatMs?: number;
  setTimer?: TimerSetter;
  setIntervalTimer?: IntervalSetter;
  clearTimer?: TimerClearer;
  clearIntervalTimer?: IntervalClearer;
}

export interface WorkingAckHandle {
  complete(decision?: OutputDecision): void;
}

export class WorkingAckLoop {
  readonly #scheduler: WorkingAckScheduler;

  constructor(options: WorkingAckLoopOptions) {
    this.#scheduler = new WorkingAckScheduler({
      budgetMs: options.roundTripBudgetMs,
      repeatMs: options.repeatMs,
      setTimeoutFn: options.setTimer,
      setIntervalFn: options.setIntervalTimer,
      clearTimeoutFn: options.clearTimer,
      clearIntervalFn: options.clearIntervalTimer,
      onAck: () => options.emit({ channel: "ack", id: "working" }),
    });
  }

  start(): WorkingAckHandle {
    this.#scheduler.start();
    return {
      complete: (decision?: OutputDecision): void => {
        if (decision !== undefined && decision.channel === "silent") {
          return;
        }
        if (decision?.channel === "ack" && decision.id === "working") {
          return;
        }
        this.#scheduler.substantiveAckArrived();
      },
    };
  }
}

function routeAck(input: OutputPolicyInput, id: AckId): OutputPlan {
  if (input.addressed !== true && input.explicit !== true) {
    return silentPlan(input.trigger);
  }
  return plan(input.trigger, [{ channel: "ack", id }]);
}

function plan(trigger: OutputTriggerClass, decisions: OutputDecision[]): OutputPlan {
  return {
    trigger,
    decisions,
    primaryChannel: decisions[0]?.channel ?? "silent",
  };
}

function silentPlan(trigger: OutputTriggerClass): OutputPlan {
  return plan(trigger, [{ channel: "silent" }]);
}

function clampWords(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/u).filter(Boolean);
  if (words.length <= maxWords) {
    return text.trim();
  }
  return words.slice(0, maxWords).join(" ");
}

function deterministicSummary(text: string, maxWords: number): string {
  return clampWords(text, maxWords);
}

function envPositiveInteger(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function envRatio(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

type TimerHandle = ReturnType<typeof setTimeout>;
type IntervalHandle = ReturnType<typeof setInterval>;
type TimerSetter = (callback: () => void, ms: number) => TimerHandle;
type IntervalSetter = (callback: () => void, ms: number) => IntervalHandle;
type TimerClearer = (handle: TimerHandle) => void;
type IntervalClearer = (handle: IntervalHandle) => void;

function assertNever(value: never): never {
  throw new Error(`Unhandled output trigger ${String(value)}.`);
}
