// Idle-cue driver (ISSUE-0024).
//
// A suggestion that QUEUES at fire time — because the room is mid-utterance and
// the weighted interrupt cost is too high to barge in — must still be delivered
// once the room falls quiet. The SuggestionEngine already implements that hand-
// off via `observeIdleCue(idleForMs)`: a queued suggestion fires (kind 'fired',
// spoken through the now-draining TTS) once the idle gap elapses with no further
// utterance. What was missing was something to *call* it on room silence.
//
// This driver is that single tick hook. It samples the room's last-final time
// and a monotonic clock — both injected, so tests advance time deterministically
// instead of waiting on the wall clock — and, when the silence since the last
// FINAL utterance crosses PANOP_SUGGEST_IDLE_GAP_SECONDS, calls observeIdleCue
// exactly once for that silence window. A fresh utterance moves the last-final
// time forward, which both resets the measured idle gap (suppressing an early
// delivery) and re-arms the driver for the next silence window.

import { readSuggestionEngineConfig, type IdleCueInput, type SuggestionEngineDecision } from "../suggest/engine";

// The slice of the SuggestionEngine this driver needs. Kept structural so the
// unit test can substitute a spy without constructing a whole engine.
export interface IdleCueObserver {
  observeIdleCue(input: IdleCueInput): Promise<SuggestionEngineDecision>;
}

// Pluggable periodic tick source. Production drives `tick` from a real interval;
// tests inject a clock and call `tick()` directly, leaving the scheduler inert.
export interface IdleCueScheduler {
  start(tick: () => void): void;
  stop(): void;
}

export interface IdleCueDriverOptions {
  engine: IdleCueObserver;
  sessionId: string;
  // Monotonic clock (ms). MUST be the same clock that stamps `lastFinalAtMs` so
  // the measured idle gap is meaningful.
  clock: () => number;
  // The time of the most recent FINAL utterance, or null before any speech. The
  // runtime owns this (its `#lastFinalAtMs`); the driver only reads it.
  lastFinalAtMs: () => number | null;
  env?: Record<string, string | undefined>;
  // Invoked with every non-noop idle decision (e.g. a 'fired' delivery) so the
  // runtime can speak it. Errors here are swallowed — a broken delivery must not
  // wedge the poll loop.
  onDecision?: (decision: SuggestionEngineDecision) => void | Promise<void>;
  // Pending steering commands at tick time, folded into the engine's recomputed
  // interrupt cost. Defaults to none.
  pendingSteerings?: () => number;
  idFactory?: () => string;
  // Override the periodic tick source (tests). Defaults to an unref'd interval.
  scheduler?: IdleCueScheduler;
  // Poll cadence for the default interval scheduler. Ignored when `scheduler`
  // is supplied.
  pollIntervalMs?: number;
}

export const DEFAULT_IDLE_CUE_POLL_INTERVAL_MS = 1_000;

export class IdleCueDriver {
  readonly #engine: IdleCueObserver;
  readonly #sessionId: string;
  readonly #clock: () => number;
  readonly #lastFinalAtMs: () => number | null;
  readonly #env: Record<string, string | undefined>;
  readonly #onDecision?: (decision: SuggestionEngineDecision) => void | Promise<void>;
  readonly #pendingSteerings?: () => number;
  readonly #idFactory: () => string;
  readonly #scheduler: IdleCueScheduler;
  // The last-final time we have already delivered an idle cue for. Guards the
  // "exactly once per silence window" contract: repeated ticks during the same
  // silence are no-ops until a fresh utterance moves `lastFinalAtMs` forward.
  #firedForFinalAt: number | null = null;
  #running = false;

  constructor(options: IdleCueDriverOptions) {
    this.#engine = options.engine;
    this.#sessionId = options.sessionId;
    this.#clock = options.clock;
    this.#lastFinalAtMs = options.lastFinalAtMs;
    this.#env = options.env ?? process.env;
    this.#onDecision = options.onDecision;
    this.#pendingSteerings = options.pendingSteerings;
    this.#idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.#scheduler = options.scheduler ?? intervalScheduler(options.pollIntervalMs ?? DEFAULT_IDLE_CUE_POLL_INTERVAL_MS);
  }

  // Begin polling. Idempotent — a second start is ignored so the runtime can
  // call it unconditionally at the server boundary.
  start(): void {
    if (this.#running) {
      return;
    }
    this.#running = true;
    this.#scheduler.start(() => {
      void this.tick();
    });
  }

  stop(): void {
    if (!this.#running) {
      return;
    }
    this.#running = false;
    this.#scheduler.stop();
  }

  // One idle sample. Returns the engine decision when an idle cue was actually
  // delivered for this silence window, otherwise null (no speech yet, gap not
  // reached, or already delivered for the current silence). Safe to call as
  // often as the scheduler likes.
  async tick(): Promise<SuggestionEngineDecision | null> {
    const lastFinal = this.#lastFinalAtMs();
    if (lastFinal === null) {
      // No FINAL utterance has landed yet — there is nothing queued and no
      // silence to measure against.
      return null;
    }
    const idleForMs = Math.max(0, this.#clock() - lastFinal);
    const config = readSuggestionEngineConfig(this.#env);
    if (idleForMs < config.idleGapSeconds * 1_000) {
      // Still inside the gap. A fresh utterance that arrived after a prior
      // delivery would land here too, which re-arms the next window below.
      return null;
    }
    if (this.#firedForFinalAt === lastFinal) {
      // Already delivered (or attempted) for this exact silence window.
      return null;
    }
    this.#firedForFinalAt = lastFinal;

    const decision = await this.#engine.observeIdleCue({
      sessionId: this.#sessionId,
      idleForMs,
      correlationId: `corr-idle-${this.#idFactory()}`,
      pendingSteerings: this.#pendingSteerings?.(),
    });
    if (decision.kind === "idle") {
      // Nothing was queued; don't surface a no-op to the delivery hook.
      return null;
    }
    await this.#onDecision?.(decision);
    return decision;
  }
}

// Default scheduler: a periodic interval, unref'd so the idle poll never keeps
// the server process alive on its own.
export function intervalScheduler(intervalMs: number): IdleCueScheduler {
  let handle: ReturnType<typeof setInterval> | null = null;
  return {
    start(tick: () => void): void {
      if (handle !== null) {
        return;
      }
      handle = setInterval(tick, intervalMs);
      (handle as { unref?: () => void }).unref?.();
    },
    stop(): void {
      if (handle !== null) {
        clearInterval(handle);
        handle = null;
      }
    },
  };
}
