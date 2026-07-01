import {
  IdeaDetectionEngine,
  selectIdeaDetector,
  type DetectionTraceEvent,
  type IdeaCandidate,
  type IdeaDetector,
  type SchedulingState,
} from "../detect";
import type { SmithersClient } from "../seam/smithers-client";
import { SmithersIdeaDetector } from "./smithers-detector";

export interface DetectionSnapshot {
  primary: IdeaCandidate | null;
  candidates: IdeaCandidate[];
  scheduling: SchedulingState;
}

export interface DetectionRunnerOptions {
  engine: IdeaDetectionEngine;
  clock?: () => number;
  // Fired after each detection round (and on accept/clear) so the server can
  // republish the snapshot, deliver the bubble, and run auto-build. May be async;
  // a detection round awaits it so flush() also awaits delivery.
  onUpdate?: (snapshot: DetectionSnapshot) => void | Promise<void>;
  onError?: (error: unknown) => void;
  // Background tick so a detection scheduled by a SPEECH PAUSE still fires when no
  // new turns are arriving. 0 disables (tests drive maybeDetect manually).
  tickIntervalMs?: number;
}

export interface IngestTurnInput {
  speaker: string | null;
  text: string;
  atMs: number;
  correlationId: string;
}

// Drives the IdeaDetectionEngine off the live transcript: appends turns, runs the
// cheap scheduling check, and kicks a NON-OVERLAPPING detection round (model
// inference) whenever the policy says so — on new material or a speech pause.
// The engine owns the intelligence; the runner owns cadence + lifecycle.
export class DetectionRunner {
  readonly #engine: IdeaDetectionEngine;
  readonly #clock: () => number;
  readonly #onUpdate?: (snapshot: DetectionSnapshot) => void | Promise<void>;
  readonly #onError?: (error: unknown) => void;
  readonly #tickIntervalMs: number;
  #latestCorrelationId = "corr-detect";
  #round = 0;
  #inFlight: Promise<void> | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: DetectionRunnerOptions) {
    this.#engine = options.engine;
    this.#clock = options.clock ?? (() => Date.now());
    this.#onUpdate = options.onUpdate;
    this.#onError = options.onError;
    this.#tickIntervalMs = options.tickIntervalMs ?? 1_000;
  }

  start(): void {
    if (this.#timer !== null || this.#tickIntervalMs <= 0) {
      return;
    }
    const timer = setInterval(() => void this.maybeDetect(), this.#tickIntervalMs);
    (timer as { unref?: () => void }).unref?.();
    this.#timer = timer;
  }

  // Append a turn and kick detection in the background (fire-and-forget). Used by
  // callers that must not block on inference.
  ingestTurn(input: IngestTurnInput): void {
    this.#latestCorrelationId = input.correlationId;
    this.#engine.ingestTurn({ speaker: input.speaker, text: input.text, atMs: input.atMs });
    void this.maybeDetect();
  }

  // Append a turn and AWAIT any scheduled detection round (and its bubble delivery)
  // before resolving. The live ingest path uses this so a detected idea is surfaced
  // and pending before the next FINAL utterance is processed — preserving the
  // utterance ordering the acceptance flow depends on (the old SuggestionEngine
  // path blocked on inference the same way).
  async ingestTurnAndDetect(input: IngestTurnInput, options: { force?: boolean } = {}): Promise<void> {
    this.#latestCorrelationId = input.correlationId;
    this.#engine.ingestTurn({ speaker: input.speaker, text: input.text, atMs: input.atMs });
    await this.maybeDetect(options.force ?? false);
  }

  // Run a detection round NOW, bypassing the scheduling policy (used by IDEA
  // CAPTURE mode, which detects eagerly on the current window). Non-overlapping.
  forceDetect(correlationId?: string): Promise<void> {
    if (correlationId !== undefined) {
      this.#latestCorrelationId = correlationId;
    }
    return this.maybeDetect(true);
  }

  // Run a detection round if the scheduling policy allows (or `force`) and none is
  // in flight. Returns the in-flight promise so callers/tests can await the round.
  maybeDetect(force = false): Promise<void> {
    if (this.#inFlight !== null) {
      return this.#inFlight;
    }
    if (!force && !this.#engine.shouldDetect(this.#clock())) {
      return Promise.resolve();
    }
    this.#round += 1;
    const correlationId = `${this.#latestCorrelationId}-detect-${this.#round}`;
    const run = this.#engine
      .detect(correlationId, this.#clock())
      .then(async (result) => {
        if (result.ran && (result.created.length > 0 || result.updated.length > 0 || result.superseded.length > 0)) {
          await this.#emit();
        }
      })
      .catch((error) => this.#onError?.(error))
      .finally(() => {
        this.#inFlight = null;
      });
    this.#inFlight = run;
    return run;
  }

  // Await any in-flight detection (graceful stop / test synchronization).
  async flush(): Promise<void> {
    while (this.#inFlight !== null) {
      await this.#inFlight;
    }
  }

  primary(): IdeaCandidate | null {
    return this.#engine.primary();
  }

  candidates(): IdeaCandidate[] {
    return this.#engine.candidates();
  }

  schedulingState(): SchedulingState {
    return this.#engine.schedulingState(this.#clock());
  }

  snapshot(): DetectionSnapshot {
    return { primary: this.#engine.primary(), candidates: this.#engine.candidates(), scheduling: this.schedulingState() };
  }

  // Consume an accepted candidate (click-to-build / auto-build) and republish.
  accept(id: string): IdeaCandidate | null {
    const accepted = this.#engine.accept(id, this.#clock());
    if (accepted !== null) {
      void this.#emit();
    }
    return accepted;
  }

  clear(): void {
    this.#engine.clear();
    void this.#emit();
  }

  async stop(): Promise<void> {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    await this.flush();
  }

  #emit(): void | Promise<void> {
    return this.#onUpdate?.(this.snapshot());
  }
}

export type DetectionRunnerMode = "host-claude" | "heuristic" | "smithers" | "injected";

export interface DetectionRunnerSelection {
  mode: DetectionRunnerMode;
  runner: DetectionRunner;
}

export interface SelectDetectionRunnerOptions {
  sessionId: string;
  env?: Record<string, string | undefined>;
  clock?: () => number;
  onUpdate?: (snapshot: DetectionSnapshot) => void | Promise<void>;
  onError?: (error: unknown) => void;
  onTrace?: (event: DetectionTraceEvent) => void;
  idFactory?: () => string;
  tickIntervalMs?: number;
  // Test injection: use this detector verbatim (mode "injected").
  detector?: IdeaDetector;
  // When a gateway-backed Smithers client is present, detection runs as a durable
  // `idea-detection` workflow run (mode "smithers") — unless VIBERSYN_IDEA_DETECTOR
  // forces a local detector or a detector is injected.
  smithersClient?: SmithersClient;
}

// Build the detection runner, selecting the inference backend the same way the
// app selects its other backends: explicit env override wins, then a configured
// Smithers gateway, else local host-`claude` inference (the no-config default).
export function selectDetectionRunner(options: SelectDetectionRunnerOptions): DetectionRunnerSelection {
  const env = options.env ?? process.env;
  const { mode, detector } = resolveDetector(options, env);
  const engine = new IdeaDetectionEngine({
    sessionId: options.sessionId,
    detector,
    clock: options.clock,
    idFactory: options.idFactory,
    env,
    onTrace: options.onTrace,
  });
  const runner = new DetectionRunner({
    engine,
    clock: options.clock,
    onUpdate: options.onUpdate,
    onError: options.onError,
    tickIntervalMs: options.tickIntervalMs,
  });
  return { mode, runner };
}

function resolveDetector(
  options: SelectDetectionRunnerOptions,
  env: Record<string, string | undefined>,
): { mode: DetectionRunnerMode; detector: IdeaDetector } {
  if (options.detector !== undefined) {
    return { mode: "injected", detector: options.detector };
  }
  // The detector backend override may come from the runtime env OR the process
  // environment (a deployment/CI-level kill-switch, e.g. forcing the heuristic
  // detector offline). The runtime env wins when both are set.
  const explicit = (env.VIBERSYN_IDEA_DETECTOR ?? process.env.VIBERSYN_IDEA_DETECTOR)?.trim();
  if ((explicit === undefined || explicit === "") && options.smithersClient !== undefined) {
    return { mode: "smithers", detector: new SmithersIdeaDetector({ client: options.smithersClient }) };
  }
  const selection = selectIdeaDetector(explicit ? { ...env, VIBERSYN_IDEA_DETECTOR: explicit } : env);
  return { mode: selection.mode, detector: selection.detector };
}
