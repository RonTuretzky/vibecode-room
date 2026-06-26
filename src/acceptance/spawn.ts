import { checkPreSpawnResources, type HostHeadroom, type SpawnRefusalReason } from "../process/resource-check";
import { ProcessRegistry, type RegistryProcess } from "../process/registry";
import type { DispatchedAction, LogEvent, OutputDecision, PendingSuggestion } from "../types";
import { AcceptanceClassifier, type AcceptanceClassification } from "./classifier";
import { ACCEPTANCE_STATE_SUGGESTION_DELIVERY, PendingSuggestionOwner, type PendingExpiryResult } from "./pending";

export const DEFAULT_ACCEPTANCE_CONFIRMATION_BUDGET_MS = 3_000;

export interface AcceptanceSpawnSeed {
  pitch: string;
  mcqs: string[];
  answers: string[];
}

export type AcceptanceSpawnDispatchResult =
  | {
      accepted: true;
      actionType: "spawn";
      correlationId: string;
      targetUPID: null;
      process: RegistryProcess;
      spokenAck?: string;
    }
  | { accepted: false; correlationId?: string; error: string };

export interface AcceptanceSpawnSeam {
  dispatch(action: DispatchedAction): Promise<AcceptanceSpawnDispatchResult> | AcceptanceSpawnDispatchResult;
}

export interface AcceptanceSpawnerOptions {
  seam: AcceptanceSpawnSeam;
  sessionId?: string;
  clock?: () => number;
  activeProcessCount?: () => number;
  maxConcurrentProcesses?: number;
  minRunSlots?: number;
  minMemoryMB?: number;
  headroom?: HostHeadroom | (() => HostHeadroom | Promise<HostHeadroom>);
  confirmationBudgetMs?: number;
  onTrace?: (event: LogEvent) => void;
  onOutput?: (decision: OutputDecision) => void;
  openSteeringWindow?: (process: RegistryProcess, correlationId: string) => void;
}

export type AcceptanceSpawnResult =
  | {
      accepted: true;
      action: DispatchedAction;
      seed: AcceptanceSpawnSeed;
      process: RegistryProcess;
      outputs: OutputDecision[];
      latencyMs: number;
      withinBudget: boolean;
    }
  | {
      accepted: false;
      reason: SpawnRefusalReason | "seam";
      action?: DispatchedAction;
      seed: AcceptanceSpawnSeed;
      spokenAck?: string;
      error?: string;
      latencyMs: number;
    };

export interface AcceptanceControllerOptions {
  pending: PendingSuggestionOwner;
  classifier: AcceptanceClassifier;
  spawner: AcceptanceSpawner;
}

export type AcceptanceControllerResult =
  | { kind: "spawned"; classification: Extract<AcceptanceClassification, { kind: "accept" }>; spawn: AcceptanceSpawnResult }
  | { kind: "declined"; classification: Extract<AcceptanceClassification, { kind: "decline" }> }
  | { kind: "mcq-answer"; classification: Extract<AcceptanceClassification, { kind: "mcq-answer" }> }
  | { kind: "ignored"; classification: Extract<AcceptanceClassification, { kind: "ignored" }> };

export class AcceptanceSpawner {
  readonly #seam: AcceptanceSpawnSeam;
  readonly #sessionId: string;
  readonly #clock: () => number;
  readonly #activeProcessCount: () => number;
  readonly #maxConcurrentProcesses?: number;
  readonly #minRunSlots?: number;
  readonly #minMemoryMB?: number;
  readonly #headroom?: AcceptanceSpawnerOptions["headroom"];
  readonly #confirmationBudgetMs: number;
  readonly #onTrace?: (event: LogEvent) => void;
  readonly #onOutput?: (decision: OutputDecision) => void;
  readonly #openSteeringWindow?: (process: RegistryProcess, correlationId: string) => void;

  constructor(options: AcceptanceSpawnerOptions) {
    this.#seam = options.seam;
    this.#sessionId = options.sessionId ?? "acceptance-spawn";
    this.#clock = options.clock ?? (() => Date.now());
    this.#activeProcessCount = options.activeProcessCount ?? (() => 0);
    this.#maxConcurrentProcesses = options.maxConcurrentProcesses;
    this.#minRunSlots = options.minRunSlots;
    this.#minMemoryMB = options.minMemoryMB;
    this.#headroom = options.headroom;
    this.#confirmationBudgetMs = options.confirmationBudgetMs ?? DEFAULT_ACCEPTANCE_CONFIRMATION_BUDGET_MS;
    this.#onTrace = options.onTrace;
    this.#onOutput = options.onOutput;
    this.#openSteeringWindow = options.openSteeringWindow;
  }

  async spawnFromSuggestion(suggestion: PendingSuggestion, correlationId: string): Promise<AcceptanceSpawnResult> {
    const startedAtMs = this.#clock();
    const seed = seedFromSuggestion(suggestion);
    const resourceCheck = await checkPreSpawnResources({
      activeProcessCount: this.#activeProcessCount(),
      correlationId,
      sessionId: this.#sessionId,
      maxConcurrentProcesses: this.#maxConcurrentProcesses,
      minRunSlots: this.#minRunSlots,
      minMemoryMB: this.#minMemoryMB,
      headroom: this.#headroom,
    });

    if (!resourceCheck.ok) {
      this.#onTrace?.(resourceCheck.event);
      const refusal = tts(resourceCheck.spokenAck);
      this.#onOutput?.(refusal);
      return {
        accepted: false,
        reason: resourceCheck.reason,
        seed,
        spokenAck: resourceCheck.spokenAck,
        latencyMs: this.#clock() - startedAtMs,
      };
    }

    const action: DispatchedAction = {
      type: "spawn",
      targetUPID: null,
      payload: seed,
      correlationId,
    };
    const dispatched = await this.#seam.dispatch(action);
    const latencyMs = this.#clock() - startedAtMs;
    if (!dispatched.accepted) {
      return {
        accepted: false,
        reason: "seam",
        action,
        seed,
        error: dispatched.error,
        latencyMs,
      };
    }

    const process = dispatched.process;
    this.#openSteeringWindow?.(process, correlationId);
    const outputs: OutputDecision[] = [
      { channel: "earcon", id: "E3" },
      tts(dispatched.spokenAck ?? `${process.callsign} spawned.`),
    ];
    for (const output of outputs) {
      this.#onOutput?.(output);
    }

    return {
      accepted: true,
      action,
      seed,
      process,
      outputs,
      latencyMs,
      withinBudget: latencyMs <= this.#confirmationBudgetMs,
    };
  }
}

export class AcceptanceController {
  readonly #pending: PendingSuggestionOwner;
  readonly #classifier: AcceptanceClassifier;
  readonly #spawner: AcceptanceSpawner;

  constructor(options: AcceptanceControllerOptions) {
    this.#pending = options.pending;
    this.#classifier = options.classifier;
    this.#spawner = options.spawner;
  }

  acceptSuggestion(suggestion: PendingSuggestion): PendingSuggestion {
    return this.#pending.acceptSuggestion(suggestion);
  }

  // True once a suggestion has been delivered and is awaiting a spoken accept /
  // decline / MCQ answer. The runtime gates live FINAL observations on this so a
  // spoken "yes" routes to acceptance instead of seeding a fresh suggestion.
  awaitingAcceptance(): boolean {
    return this.#pending.state() === ACCEPTANCE_STATE_SUGGESTION_DELIVERY && this.#pending.pending() !== null;
  }

  checkExpiry(nowMs?: number): PendingExpiryResult {
    return this.#pending.checkExpiry(nowMs);
  }

  async observe(input: Parameters<AcceptanceClassifier["classify"]>[0]): Promise<AcceptanceControllerResult> {
    const classification = await this.#classifier.classify(input);
    switch (classification.kind) {
      case "accept": {
        const spawn = await this.#spawner.spawnFromSuggestion(classification.suggestion, classification.correlationId);
        this.#pending.clear();
        return { kind: "spawned", classification, spawn };
      }
      case "decline":
        this.#pending.clear();
        return { kind: "declined", classification };
      case "mcq-answer":
        return { kind: "mcq-answer", classification };
      case "ignored":
        return { kind: "ignored", classification };
      default:
        assertNever(classification);
    }
  }
}

export function createProcessRegistryAcceptanceSeam(registry: ProcessRegistry): AcceptanceSpawnSeam {
  return {
    async dispatch(action: DispatchedAction): Promise<AcceptanceSpawnDispatchResult> {
      if (action.type !== "spawn" || action.targetUPID !== null) {
        return { accepted: false, correlationId: action.correlationId, error: "Acceptance seam only supports spawn." };
      }
      const seed = seedFromPayload(action.payload);
      const result = await registry.spawn({
        correlationId: action.correlationId,
        prompt: seed.pitch,
        input: { ...seed },
      });
      if (!result.accepted) {
        return { accepted: false, correlationId: action.correlationId, error: result.spokenAck };
      }
      return {
        accepted: true,
        actionType: "spawn",
        correlationId: action.correlationId,
        targetUPID: null,
        process: result.process,
        spokenAck: result.spokenAck,
      };
    },
  };
}

export function seedFromSuggestion(suggestion: PendingSuggestion): AcceptanceSpawnSeed {
  return {
    pitch: suggestion.pitch,
    mcqs: [...suggestion.mcqs],
    answers: [...suggestion.answers],
  };
}

function seedFromPayload(payload: unknown): AcceptanceSpawnSeed {
  if (!isRecord(payload)) {
    return { pitch: "", mcqs: [], answers: [] };
  }
  return {
    pitch: typeof payload.pitch === "string" ? payload.pitch : "",
    mcqs: stringArray(payload.mcqs),
    answers: stringArray(payload.answers),
  };
}

function tts(text: string): Extract<OutputDecision, { channel: "tts" }> {
  const spoken = clampWords(text, 15);
  return {
    channel: "tts",
    text: spoken,
    wordCount: countWords(spoken),
    summarized: spoken !== text,
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function countWords(text: string): number {
  return text.trim().split(/\s+/u).filter(Boolean).length;
}

function clampWords(text: string, limit: number): string {
  const words = text.trim().split(/\s+/u).filter(Boolean);
  return words.length <= limit ? text : words.slice(0, limit).join(" ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled acceptance classification ${(value as { kind?: string }).kind ?? "unknown"}.`);
}
