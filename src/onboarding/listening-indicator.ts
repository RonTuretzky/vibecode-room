import { playEarcon, type AudioDispatchMeta, type AudioOutput } from "../audio/earcons";
import { logEventSchema, type EarconId, type LogEvent } from "../types";

export type MicStreamPhase = "stopped" | "streaming";

export interface MicStreamState {
  phase: MicStreamPhase;
  correlationId: string;
  nowMs?: number;
}

export interface ListeningIndicatorOptions {
  sessionId: string;
  output: AudioOutput;
  clock?: () => number;
  onTrace?: (event: LogEvent) => void;
}

export interface AuthoritativeListeningIndicator {
  authoritative: true;
  listening: boolean;
  source: "mic-stream";
  earconId: EarconId | null;
}

export interface VisualListeningBadge {
  authoritative: false;
  listening: boolean;
  source: "board";
}

export interface ListeningIndicatorEmission {
  id: EarconId;
  source: "transcribing-ambient";
  correlationId: string;
  emittedAtMs: number;
  event: LogEvent;
}

export class ListeningIndicator {
  readonly #sessionId: string;
  readonly #output: AudioOutput;
  readonly #clock: () => number;
  readonly #onTrace?: (event: LogEvent) => void;
  #streaming = false;

  constructor(options: ListeningIndicatorOptions) {
    this.#sessionId = options.sessionId;
    this.#output = options.output;
    this.#clock = options.clock ?? (() => performance.now());
    this.#onTrace = options.onTrace;
  }

  async updateFromMicStream(state: MicStreamState): Promise<ListeningIndicatorEmission | null> {
    const nextStreaming = state.phase === "streaming";
    const wasStreaming = this.#streaming;
    this.#streaming = nextStreaming;

    if (!nextStreaming || wasStreaming) {
      return null;
    }

    const emittedAtMs = state.nowMs ?? this.#clock();
    const meta: AudioDispatchMeta = {
      correlationId: state.correlationId,
      source: "transcribing-ambient",
      emittedAtMs,
    };

    await playEarcon(this.#output, "E2", meta);

    const event = logEventSchema.parse({
      level: "info",
      event: "earcon.emit",
      sessionId: this.#sessionId,
      correlationId: state.correlationId,
      latencyMs: 0,
      meta: {
        id: "E2",
        source: "transcribing-ambient",
        authoritative: true,
        driver: "mic-stream",
      },
    });
    this.#onTrace?.(event);

    return {
      id: "E2",
      source: "transcribing-ambient",
      correlationId: state.correlationId,
      emittedAtMs,
      event,
    };
  }

  authoritativeState(): AuthoritativeListeningIndicator {
    return {
      authoritative: true,
      listening: this.#streaming,
      source: "mic-stream",
      earconId: this.#streaming ? "E2" : null,
    };
  }
}

export function nonAuthoritativeBoardBadge(listening: boolean): VisualListeningBadge {
  return {
    authoritative: false,
    listening,
    source: "board",
  };
}
