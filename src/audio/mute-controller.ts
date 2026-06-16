import type { ASRProvider, AudioReadableStream } from "../providers";
import type { EarconId, LogEvent, MuteReleaseTrigger, OutputDecision, TranscriptObservation } from "../types";
import { decideOutput } from "./output-policy";

export const MUTE_ENGAGE_BUDGET_MS = 500;
export const DEFAULT_MUTE_HEARTBEAT_INTERVAL_MS = 1_000;
export const MUTE_KEYWORD = "mute";
export const UNMUTE_KEYWORD = "unmute";

export type MuteCueKeyword = typeof MUTE_KEYWORD | typeof UNMUTE_KEYWORD;

export interface MuteControllerOptions {
  sessionId: string;
  now?: () => number;
  idFactory?: () => string;
  engageBudgetMs?: number;
  heartbeatIntervalMs?: number;
  onTrace?: (event: LogEvent) => void;
  onOutput?: (decision: OutputDecision) => void | Promise<void>;
  setIntervalFn?: IntervalSetter;
  clearIntervalFn?: IntervalClearer;
}

export interface MuteTransition {
  changed: boolean;
  muted: boolean;
  streamingToCloud: boolean;
  latencyMs: number;
  correlationId: string;
  outputs: OutputDecision[];
  persistentTone: EarconId | null;
}

export interface MuteEngageInput {
  correlationId?: string;
  startedAtMs?: number;
  cueLatencyMs?: number;
}

export interface MuteReleaseInput {
  correlationId?: string;
  startedAtMs?: number;
  trigger: MuteReleaseTrigger;
}

type TimerHandle = ReturnType<typeof setInterval>;
type IntervalSetter = (fn: () => void, delay?: number) => TimerHandle;
type IntervalClearer = (handle: TimerHandle) => void;

export class MuteController {
  readonly #sessionId: string;
  readonly #now: () => number;
  readonly #idFactory: () => string;
  readonly #engageBudgetMs: number;
  readonly #heartbeatIntervalMs: number;
  readonly #onTrace?: (event: LogEvent) => void;
  readonly #onOutput?: (decision: OutputDecision) => void | Promise<void>;
  readonly #setInterval: IntervalSetter;
  readonly #clearInterval: IntervalClearer;
  #muted = false;
  #streamingToCloud = true;
  #heartbeat: TimerHandle | undefined;
  #heartbeatCorrelationId: string | undefined;
  #suppressedObservations = 0;

  constructor(options: MuteControllerOptions) {
    this.#sessionId = options.sessionId;
    this.#now = options.now ?? (() => performance.now());
    this.#idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.#engageBudgetMs = options.engageBudgetMs ?? MUTE_ENGAGE_BUDGET_MS;
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_MUTE_HEARTBEAT_INTERVAL_MS;
    this.#onTrace = options.onTrace;
    this.#onOutput = options.onOutput;
    this.#setInterval = options.setIntervalFn ?? setInterval;
    this.#clearInterval = options.clearIntervalFn ?? clearInterval;
  }

  isMuted(): boolean {
    return this.#muted;
  }

  isStreamingToCloud(): boolean {
    return this.#streamingToCloud;
  }

  suppressedObservations(): number {
    return this.#suppressedObservations;
  }

  async handleCueKeyword(keyword: MuteCueKeyword, input: Omit<MuteEngageInput, "cueLatencyMs"> & { cueLatencyMs?: number } = {}): Promise<MuteTransition> {
    if (keyword === MUTE_KEYWORD) {
      return this.engage(input);
    }

    return this.release({ ...input, trigger: "unmute-word" });
  }

  async engage(input: MuteEngageInput = {}): Promise<MuteTransition> {
    const endedAtMs = this.#now();
    const startedAtMs = input.startedAtMs ?? (input.cueLatencyMs === undefined ? endedAtMs : endedAtMs - input.cueLatencyMs);
    const latencyMs = Math.max(0, endedAtMs - startedAtMs);
    const correlationId = input.correlationId ?? this.#correlationId("mute");

    if (this.#muted) {
      return {
        changed: false,
        muted: true,
        streamingToCloud: this.#streamingToCloud,
        latencyMs,
        correlationId,
        outputs: [],
        persistentTone: "mute-tone",
      };
    }

    this.#muted = true;
    this.#streamingToCloud = false;
    this.#heartbeatCorrelationId = correlationId;
    const outputs = await this.#emitOutput("mute");
    this.#emitTrace({
      level: latencyMs <= this.#engageBudgetMs ? "info" : "error",
      event: "mute.engaged",
      sessionId: this.#sessionId,
      correlationId,
      latencyMs,
      meta: {
        streamingToCloud: false,
        budgetMs: this.#engageBudgetMs,
        withinBudget: latencyMs <= this.#engageBudgetMs,
        persistentTone: "mute-tone",
      },
    });
    this.#startHeartbeat(correlationId);

    return {
      changed: true,
      muted: true,
      streamingToCloud: false,
      latencyMs,
      correlationId,
      outputs,
      persistentTone: "mute-tone",
    };
  }

  async release(input: MuteReleaseInput): Promise<MuteTransition> {
    const endedAtMs = this.#now();
    const startedAtMs = input.startedAtMs ?? endedAtMs;
    const latencyMs = Math.max(0, endedAtMs - startedAtMs);
    const correlationId = input.correlationId ?? this.#correlationId("unmute");

    if (!this.#muted) {
      return {
        changed: false,
        muted: false,
        streamingToCloud: this.#streamingToCloud,
        latencyMs,
        correlationId,
        outputs: [],
        persistentTone: null,
      };
    }

    this.#muted = false;
    this.#streamingToCloud = true;
    this.#stopHeartbeat();
    const outputs = await this.#emitOutput("unmute");
    this.#emitTrace({
      level: "info",
      event: "mute.released",
      sessionId: this.#sessionId,
      correlationId,
      latencyMs,
      meta: {
        trigger: input.trigger,
        streamingToCloud: true,
        suppressedObservations: this.#suppressedObservations,
        restoredEarcon: "E2",
      },
    });

    return {
      changed: true,
      muted: false,
      streamingToCloud: true,
      latencyMs,
      correlationId,
      outputs,
      persistentTone: null,
    };
  }

  async releaseFromButton(input: Omit<MuteReleaseInput, "trigger"> = {}): Promise<MuteTransition> {
    return this.release({ ...input, trigger: "unmute-button" });
  }

  acceptPipelineObservation(observation: TranscriptObservation): TranscriptObservation | null {
    if (!this.#muted) {
      return observation;
    }

    this.#suppressedObservations += 1;
    return null;
  }

  filterPipelineObservations(observations: readonly TranscriptObservation[]): TranscriptObservation[] {
    return observations.flatMap((observation) => {
      const accepted = this.acceptPipelineObservation(observation);
      return accepted === null ? [] : [accepted];
    });
  }

  protectCloudAsr(provider: ASRProvider): ASRProvider {
    return new MuteProtectedASRProvider(provider, this);
  }

  close(): void {
    this.#stopHeartbeat();
  }

  async #emitOutput(trigger: "mute" | "unmute"): Promise<OutputDecision[]> {
    const plan = await decideOutput({ trigger });
    for (const decision of plan.decisions) {
      await this.#onOutput?.(decision);
    }
    return plan.decisions;
  }

  #startHeartbeat(correlationId: string): void {
    this.#stopHeartbeat();
    this.#heartbeat = this.#setInterval(() => {
      if (!this.#muted) {
        return;
      }

      this.#emitTrace({
        level: "info",
        event: "mute.heartbeat",
        sessionId: this.#sessionId,
        correlationId: this.#heartbeatCorrelationId ?? correlationId,
        latencyMs: 0,
        meta: {
          streamingToCloud: false,
        },
      });
    }, this.#heartbeatIntervalMs);
  }

  #stopHeartbeat(): void {
    if (this.#heartbeat !== undefined) {
      this.#clearInterval(this.#heartbeat);
      this.#heartbeat = undefined;
    }
  }

  #emitTrace(event: LogEvent): void {
    this.#onTrace?.(event);
  }

  #correlationId(prefix: string): string {
    return `corr-${prefix}-${this.#idFactory()}`;
  }
}

class MuteProtectedASRProvider implements ASRProvider {
  constructor(
    private readonly upstream: ASRProvider,
    private readonly controller: MuteController,
  ) {}

  async *stream(audio: AudioReadableStream): AsyncIterable<TranscriptObservation> {
    if (this.controller.isMuted()) {
      return;
    }

    for await (const observation of this.upstream.stream(audio)) {
      const accepted = this.controller.acceptPipelineObservation(observation);
      if (accepted !== null) {
        yield accepted;
      }
    }
  }
}
