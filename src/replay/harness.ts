import { createHash } from "node:crypto";
import { readTranscriptObservationJsonl } from "./jsonl";
import type { TranscriptObservation } from "../types";

export interface DecisionInput {
  observation: TranscriptObservation;
  observationIndex: number;
  priorOutputHashes: string[];
  temperature: 0;
}

export interface DecisionLLM<TOutput = unknown> {
  decide(input: DecisionInput): Promise<TOutput> | TOutput;
}

export interface DecisionReplayRecord<TOutput = unknown> {
  observation: TranscriptObservation;
  input: DecisionInput;
  output: TOutput;
  inputHash: string;
  outputHash: string;
  ioHash: string;
  cacheHit: boolean;
}

export interface ReplayRunResult<TOutput = unknown> {
  records: DecisionReplayRecord<TOutput>[];
  jsonl: string;
}

export interface ReplayHarnessOptions {
  cache?: ReplayDecisionCache;
  trace?: (event: ReplayTraceEvent) => void;
}

export interface ReplayTraceEvent {
  level: "debug" | "info" | "warn" | "error";
  event: "replay.decision";
  sessionId: string;
  correlationId: string;
  meta: {
    utteranceId: string;
    observationIndex: number;
    inputHash: string;
    outputHash: string;
    ioHash: string;
    cacheHit: boolean;
    temperature: 0;
  };
}

export class ReplayDecisionCache {
  readonly #outputs = new Map<string, unknown>();

  has(inputHash: string): boolean {
    return this.#outputs.has(inputHash);
  }

  get<TOutput>(inputHash: string): TOutput | undefined {
    return this.#outputs.get(inputHash) as TOutput | undefined;
  }

  set<TOutput>(inputHash: string, output: TOutput): void {
    this.#outputs.set(inputHash, deepFreezeClone(output));
  }

  size(): number {
    return this.#outputs.size;
  }
}

export async function runReplayHarness<TOutput>(
  jsonlPath: string,
  llm: DecisionLLM<TOutput>,
  options: ReplayHarnessOptions = {},
): Promise<ReplayRunResult<TOutput>> {
  const observations = await readTranscriptObservationJsonl(jsonlPath);
  return runReplayObservations(observations, llm, options);
}

export async function runReplayObservations<TOutput>(
  observations: TranscriptObservation[],
  llm: DecisionLLM<TOutput>,
  options: ReplayHarnessOptions = {},
): Promise<ReplayRunResult<TOutput>> {
  const cache = options.cache ?? new ReplayDecisionCache();
  const records: DecisionReplayRecord<TOutput>[] = [];
  const priorOutputHashes: string[] = [];

  for (const [observationIndex, observation] of observations.entries()) {
    const input: DecisionInput = {
      observation,
      observationIndex,
      priorOutputHashes: [...priorOutputHashes],
      temperature: 0,
    };
    const inputHash = stableHash(input);
    const cached = cache.get<TOutput>(inputHash);
    const cacheHit = cached !== undefined || cache.has(inputHash);
    const output = cacheHit ? (cached as TOutput) : await llm.decide(input);

    if (!cacheHit) {
      cache.set(inputHash, output);
    }

    const outputHash = stableHash(output);
    const ioHash = stableHash({ inputHash, outputHash });
    const record: DecisionReplayRecord<TOutput> = {
      observation,
      input,
      output: deepFreezeClone(output),
      inputHash,
      outputHash,
      ioHash,
      cacheHit,
    };

    records.push(record);
    priorOutputHashes.push(outputHash);
    options.trace?.(traceEvent(record, observationIndex));
  }

  return {
    records,
    jsonl: records.map((record) => canonicalJson(decisionStreamRecord(record))).join("\n"),
  };
}

export interface AiOutputCandidate {
  pitch?: string;
  mcqs?: readonly unknown[];
  text?: string;
  tts?: string;
  wordCount?: number;
  latencyMs?: number;
  firedAtMs?: number;
}

export interface AiInvariantLimits {
  maxMcqs?: number;
  maxWords?: number;
  budgetMs?: number;
}

export function assertAiOutputInvariants(candidate: AiOutputCandidate, limits: AiInvariantLimits = {}): void {
  const maxMcqs = limits.maxMcqs ?? 3;
  const maxWords = limits.maxWords ?? 15;
  const budgetMs = limits.budgetMs;

  assertMaxMcqs(candidate.mcqs ?? [], maxMcqs);

  const spokenText = candidate.text ?? candidate.tts;
  if (spokenText !== undefined) {
    assertMaxWords(spokenText, maxWords);
  } else if (candidate.wordCount !== undefined && candidate.wordCount > maxWords) {
    throw new Error(`AI output has ${candidate.wordCount} words; expected <= ${maxWords}.`);
  }

  const elapsedMs = candidate.firedAtMs ?? candidate.latencyMs;
  if (budgetMs !== undefined && elapsedMs !== undefined) {
    assertFiresWithinBudget(elapsedMs, budgetMs);
  }
}

export function assertMaxMcqs(mcqs: readonly unknown[], max = 3): void {
  if (mcqs.length > max) {
    throw new Error(`AI output has ${mcqs.length} MCQs; expected <= ${max}.`);
  }
}

export function assertMaxWords(text: string, max = 15): void {
  const wordCount = countWords(text);
  if (wordCount > max) {
    throw new Error(`AI output has ${wordCount} words; expected <= ${max}.`);
  }
}

export function assertFiresWithinBudget(elapsedMs: number, budgetMs: number): void {
  if (elapsedMs > budgetMs) {
    throw new Error(`AI output fired after ${elapsedMs}ms; expected <= ${budgetMs}ms.`);
  }
}

export function stableHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortForJson(value));
}

function traceEvent<TOutput>(
  record: DecisionReplayRecord<TOutput>,
  observationIndex: number,
): ReplayTraceEvent {
  return {
    level: "info",
    event: "replay.decision",
    sessionId: record.observation.sessionId,
    correlationId: `replay-${record.inputHash.slice(0, 16)}`,
    meta: {
      utteranceId: record.observation.utteranceId,
      observationIndex,
      inputHash: record.inputHash,
      outputHash: record.outputHash,
      ioHash: record.ioHash,
      cacheHit: record.cacheHit,
      temperature: record.input.temperature,
    },
  };
}

function decisionStreamRecord<TOutput>(
  record: DecisionReplayRecord<TOutput>,
): Omit<DecisionReplayRecord<TOutput>, "cacheHit"> {
  const { cacheHit: _cacheHit, ...streamRecord } = record;
  return streamRecord;
}

function countWords(text: string): number {
  return text.trim().length === 0 ? 0 : text.trim().split(/\s+/u).length;
}

function deepFreezeClone<T>(value: T): T {
  return sortForJson(value) as T;
}

function sortForJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortForJson(item));
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const child = (value as Record<string, unknown>)[key];
    if (child !== undefined) {
      sorted[key] = sortForJson(child);
    }
  }
  return sorted;
}
