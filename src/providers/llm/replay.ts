import { readFile } from "node:fs/promises";
import { cueDecisionSchema } from "../../types";
import type { DecisionInput, DecisionLLM, DecisionOutput } from "../types";

export interface ReplayDecisionRecord {
  input: DecisionInput;
  output: DecisionOutput;
}

export class ReplayDecisionLLM implements DecisionLLM {
  readonly calls: DecisionInput[] = [];
  readonly cacheHits: DecisionInput[] = [];
  readonly #records = new Map<string, DecisionOutput>();
  readonly #cache = new Map<string, DecisionOutput>();

  constructor(records: readonly ReplayDecisionRecord[]) {
    for (const record of records) {
      this.#records.set(cacheKey(normalizeInput(record.input)), cloneOutput(record.output));
    }
  }

  static async fromJsonl(path: string): Promise<ReplayDecisionLLM> {
    const body = await readFile(path, "utf8");
    const records: ReplayDecisionRecord[] = [];

    for (const [index, rawLine] of body.split(/\r?\n/u).entries()) {
      const line = rawLine.trim();
      if (line.length === 0) {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid decision replay JSONL at line ${index + 1}: ${(error as Error).message}`);
      }

      records.push(parseReplayDecisionRecord(parsed, index + 1));
    }

    return new ReplayDecisionLLM(records);
  }

  async decide(input: DecisionInput): Promise<DecisionOutput> {
    const normalized = normalizeInput(input);
    const key = cacheKey(normalized);
    this.calls.push(normalized);

    const cached = this.#cache.get(key);
    if (cached !== undefined) {
      this.cacheHits.push(normalized);
      return cloneOutput(cached);
    }

    const output = this.#records.get(key);
    if (output === undefined) {
      throw new Error(`No replayed decision for input ${key}`);
    }

    this.#cache.set(key, cloneOutput(output));
    return cloneOutput(output);
  }
}

function parseReplayDecisionRecord(value: unknown, line: number): ReplayDecisionRecord {
  if (!isRecord(value) || !isRecord(value.input) || !isRecord(value.output)) {
    throw new Error(`Invalid decision replay record at line ${line}: expected {input,output}`);
  }

  const input = normalizeInput(value.input as unknown as DecisionInput);
  const output = parseDecisionOutput(value.output, line);
  return { input, output };
}

function parseDecisionOutput(value: unknown, line: number): DecisionOutput {
  if (!isRecord(value)) {
    throw new Error(`Invalid decision output at line ${line}: expected object`);
  }

  const output = value as unknown as DecisionOutput;
  if (output.temperature !== 0) {
    throw new Error(`Invalid decision output at line ${line}: replay outputs must be temperature 0`);
  }

  cueDecisionSchema.parse(output.decision);
  return cloneOutput(output);
}

function normalizeInput(input: DecisionInput): DecisionInput {
  if (input.temperature !== undefined && input.temperature !== 0) {
    throw new Error("DecisionLLM replay only accepts temperature 0 inputs");
  }

  return {
    ...input,
    temperature: 0,
    messages: input.messages.map((message) => ({ ...message })),
    metadata: input.metadata === undefined ? undefined : { ...input.metadata },
  };
}

function cacheKey(input: DecisionInput): string {
  return JSON.stringify(stable(input));
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stable);
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, stable(entryValue)]),
    );
  }

  return value;
}

function cloneOutput(output: DecisionOutput): DecisionOutput {
  return structuredClone(output);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
