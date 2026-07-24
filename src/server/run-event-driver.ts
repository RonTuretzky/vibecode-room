// Run-event driver (ISSUE-0021).
//
// A spawned run is, on the snapshot, a ProjectorProcess whose progress /
// lastOutput / state come from demo fixtures until something feeds it live
// telemetry. This driver is that feed: for each spawned run it subscribes to the
// gateway's streamRunEvents, normalizes every GatewayEventFrame into the same
// RunEvent shape the cue path uses (normalizeSmithersRunEvent), and folds it into
// a per-UPID overlay that composition.ts reads in processSnapshots(). A run with
// a live overlay shows real progress; the seeded fleet (no live run) keeps its
// fixtures because no overlay is ever written for it.
//
// Dedup is by monotonic seq per UPID: gateway events are ordered and the stream
// resumes with afterSeq = the last applied seq, so a reconnect that replays the
// boundary frame (seq <= lastSeq) is dropped rather than double-applied.

import type { RunEvent } from "../types";
import { normalizeSmithersRunEvent } from "../seam/run-events";
import type { GatewayEventFrame, SmithersClient, StreamRunEventsOptions } from "../seam/smithers-client";
import type { ProjectorProcessState } from "../ui/types";

// The live slice of a ProjectorProcess this driver owns. `lastSeq` is the highest
// run-event seq folded in so far — the dedup/afterSeq watermark for this UPID.
export interface RunEventOverlay {
  state: ProjectorProcessState;
  progress: number;
  lastOutput: string;
  lastSeq: number;
}

// Active-run progress climbs with the event seq toward a cap (it never claims
// 100% while the run is still streaming); a completed event jumps to 100.
const ACTIVE_PROGRESS_STEP = 12;
const ACTIVE_PROGRESS_CAP = 95;
const DEFAULT_RECONNECT_DELAY_MS = 5;

// The slice of SmithersClient the driver needs — just the live event stream.
export type RunEventStreamClient = Pick<SmithersClient, "streamRunEvents">;

export interface RunEventDriverOptions {
  client: RunEventStreamClient;
  // Invoked after each overlay change so the runtime can republish the snapshot.
  // Errors are swallowed by the caller; a broken publish must not wedge the stream.
  onUpdate?: (upid: string, overlay: RunEventOverlay) => void;
  // Backoff between stream reconnect attempts. Defaults to a few ms.
  reconnectDelayMs?: number;
  onReconnect?: (event: { upid: string; afterSeq: number; attempt: number; error: unknown }) => void;
}

export class RunEventDriver {
  readonly #client: RunEventStreamClient;
  readonly #onUpdate?: RunEventDriverOptions["onUpdate"];
  readonly #reconnectDelayMs: number;
  readonly #onReconnect?: RunEventDriverOptions["onReconnect"];
  readonly #overlays = new Map<string, RunEventOverlay>();
  readonly #active = new Set<Promise<void>>();
  // In-flight subscription abort handles keyed by UPID so forget() can cancel a
  // still-streaming run before dropping its overlay. A UPID can hold several
  // (subscribe() may be called again after a reconnect-heavy stream returns).
  readonly #subscriptionAborts = new Map<string, Set<AbortController>>();

  constructor(options: RunEventDriverOptions) {
    this.#client = options.client;
    this.#onUpdate = options.onUpdate;
    this.#reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    this.#onReconnect = options.onReconnect;
  }

  // The live overlay for a UPID, or undefined when the run has no telemetry yet
  // (e.g. a seeded fixture). Returned as a copy so callers can't mutate state.
  overlay(upid: string): RunEventOverlay | undefined {
    const overlay = this.#overlays.get(upid);
    return overlay === undefined ? undefined : { ...overlay };
  }

  // Subscribe to a spawned run's live events and fold each into its overlay. Runs
  // until the stream ends, the signal aborts, or maxFrames overlay updates land.
  // Returns a tracked promise so callers (and tests) can await all in-flight
  // subscriptions via idle().
  subscribe(upid: string, runId: string, options: { signal?: AbortSignal; maxFrames?: number } = {}): Promise<void> {
    // Every subscription gets its own abort handle (combined with any caller
    // signal) so forget() can tear down this UPID's stream on halt.
    const controller = new AbortController();
    const signal = options.signal === undefined ? controller.signal : AbortSignal.any([options.signal, controller.signal]);
    const handles = this.#subscriptionAborts.get(upid) ?? new Set<AbortController>();
    handles.add(controller);
    this.#subscriptionAborts.set(upid, handles);
    const promise = this.#stream(upid, runId, { signal, maxFrames: options.maxFrames }).finally(() => {
      this.#active.delete(promise);
      handles.delete(controller);
      if (handles.size === 0 && this.#subscriptionAborts.get(upid) === handles) {
        this.#subscriptionAborts.delete(upid);
      }
    });
    this.#active.add(promise);
    return promise;
  }

  // Drop a UPID's overlay and abort any in-flight subscription for it. Called
  // when the process is halted (the composition wires this from the halt path)
  // so a dead run's telemetry doesn't sit in the overlay map forever.
  forget(upid: string): void {
    this.#overlays.delete(upid);
    const handles = this.#subscriptionAborts.get(upid);
    if (handles === undefined) {
      return;
    }
    this.#subscriptionAborts.delete(upid);
    for (const controller of handles) {
      controller.abort();
    }
  }

  // Resolve once no subscription is in flight. Used by tests/e2e to await the
  // streamed overlay before asserting the snapshot.
  async idle(): Promise<void> {
    while (this.#active.size > 0) {
      await Promise.allSettled([...this.#active]);
    }
  }

  // Fold one already-normalized run event into the UPID's overlay, deduping by
  // seq. Returns the new overlay, or null when the event was a duplicate/replay.
  ingest(event: RunEvent): RunEventOverlay | null {
    const previous = this.#overlays.get(event.upid);
    if (previous !== undefined && event.seq <= previous.lastSeq) {
      // Already applied this seq — a reconnect replayed the afterSeq boundary, or
      // the same frame arrived twice. Drop it rather than double-apply.
      return null;
    }
    const next = runEventToOverlay(event, previous);
    this.#overlays.set(event.upid, next);
    this.#onUpdate?.(event.upid, { ...next });
    return next;
  }

  async #stream(upid: string, runId: string, options: { signal?: AbortSignal; maxFrames?: number }): Promise<void> {
    const signal = options.signal;
    let afterSeq = this.#overlays.get(upid)?.lastSeq ?? 0;
    let applied = 0;
    let attempt = 0;

    while (isAborted(signal) === false) {
      try {
        const stream: AsyncIterable<GatewayEventFrame> = this.#client.streamRunEvents(upid, {
          afterSeq,
          signal,
        } satisfies StreamRunEventsOptions);
        for await (const frame of stream) {
          const event = normalizeSmithersRunEvent(frame, { upid, runId });
          const overlay = this.ingest(event);
          afterSeq = Math.max(afterSeq, event.seq);
          if (overlay !== null && options.maxFrames !== undefined) {
            applied += 1;
            if (applied >= options.maxFrames) {
              return;
            }
          }
        }
        return;
      } catch (error) {
        if (isAborted(signal)) {
          return;
        }
        this.#onReconnect?.({ upid, afterSeq, attempt, error });
        attempt += 1;
        // Resume after the last applied seq so dedup never has to re-drop a long
        // backlog; the seq guard in ingest() still catches the boundary frame.
        afterSeq = Math.max(afterSeq, this.#overlays.get(upid)?.lastSeq ?? 0);
        await sleep(this.#reconnectDelayMs, signal);
      }
    }
  }
}

// Map one run event onto the live process overlay. Exported so the frame->fields
// projection is unit-testable independently of any stream. `previous` carries the
// prior overlay so active progress climbs monotonically and a blocker holds it.
export function runEventToOverlay(event: RunEvent, previous?: RunEventOverlay): RunEventOverlay {
  const priorProgress = previous?.progress ?? 0;
  const progress =
    event.kind === "completed"
      ? 100
      : event.kind === "blocker"
        ? priorProgress
        : Math.min(ACTIVE_PROGRESS_CAP, Math.max(priorProgress, event.seq * ACTIVE_PROGRESS_STEP));
  return {
    state: projectorStateFromRunEvent(event.kind),
    progress,
    lastOutput: event.text,
    lastSeq: Math.max(previous?.lastSeq ?? 0, event.seq),
  };
}

function projectorStateFromRunEvent(kind: RunEvent["kind"]): ProjectorProcessState {
  switch (kind) {
    case "completed":
      return "completed";
    case "blocker":
      return "blocked";
    case "output":
    case "state":
    default:
      return "active";
  }
}

function isAborted(signal?: AbortSignal): boolean {
  return signal !== undefined && signal.aborted;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (isAborted(signal)) {
      resolve();
      return;
    }
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}
