import { TraceProcessor } from "../obs/trace";
import type { LogEvent, OutputDecision } from "../types";

export const canonicalStageNames = [
  "IDLE",
  "ACTIVE_LISTEN",
  "SUGGESTION_DELIVERY",
  "STEERING_WINDOW",
  "SPAWN",
  "STEER",
  "ACK",
] as const;

export type CanonicalStage = (typeof canonicalStageNames)[number];

export interface StageTransition {
  from: CanonicalStage;
  to: CanonicalStage;
  correlationId: string;
  reason: string;
  audible: OutputDecision | null;
}

export interface StageSequencerOptions {
  sessionId: string;
  trace?: TraceProcessor;
  clock?: () => number;
  onOutput?: (decision: OutputDecision, transition: StageTransition) => void | Promise<void>;
}

export class StageSequencer {
  readonly #sessionId: string;
  readonly #trace: TraceProcessor;
  readonly #clock: () => number;
  readonly #onOutput?: StageSequencerOptions["onOutput"];
  readonly #transitions: StageTransition[] = [];
  #state: CanonicalStage = "IDLE";

  constructor(options: StageSequencerOptions) {
    this.#sessionId = options.sessionId;
    this.#trace = options.trace ?? new TraceProcessor({ clock: options.clock });
    this.#clock = options.clock ?? (() => Date.now());
    this.#onOutput = options.onOutput;
  }

  state(): CanonicalStage {
    return this.#state;
  }

  transitions(): StageTransition[] {
    return this.#transitions.map((transition) => ({
      ...transition,
      audible: transition.audible === null ? null : { ...transition.audible },
    }));
  }

  async transition(
    to: CanonicalStage,
    input: {
      correlationId: string;
      reason: string;
      audible?: OutputDecision | null;
      meta?: Record<string, unknown>;
    },
  ): Promise<LogEvent> {
    assertValidTransition(this.#state, to);
    const startedAtMs = this.#clock();
    const transition: StageTransition = {
      from: this.#state,
      to,
      correlationId: input.correlationId,
      reason: input.reason,
      audible: input.audible ?? null,
    };
    this.#state = to;
    this.#transitions.push(transition);

    if (transition.audible !== null) {
      await this.#onOutput?.(transition.audible, transition);
    }

    return this.#trace.record({
      event: "stage.transition",
      sessionId: this.#sessionId,
      correlationId: input.correlationId,
      startedAtMs,
      endedAtMs: this.#clock(),
      meta: {
        from: transition.from,
        to: transition.to,
        reason: input.reason,
        audibleChannel: transition.audible?.channel ?? "silent",
        ...input.meta,
      },
    });
  }
}

function assertValidTransition(from: CanonicalStage, to: CanonicalStage): void {
  const allowed: Record<CanonicalStage, readonly CanonicalStage[]> = {
    IDLE: ["ACTIVE_LISTEN"],
    ACTIVE_LISTEN: ["SUGGESTION_DELIVERY", "STEERING_WINDOW", "SPAWN", "STEER", "ACK"],
    SUGGESTION_DELIVERY: ["SPAWN", "ACK"],
    STEERING_WINDOW: ["STEER", "ACK"],
    SPAWN: ["ACK"],
    STEER: ["ACK"],
    ACK: ["IDLE"],
  };

  if (!allowed[from].includes(to)) {
    throw new Error(`Invalid canonical stage transition ${from} -> ${to}.`);
  }
}
