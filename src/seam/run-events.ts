import type { RunEvent } from "../types";
import type { CorrelationStore } from "./correlation-store";
import type { GatewayEventFrame, SmithersClient } from "./smithers-client";

export interface CueObservationSink {
  observe(observation: {
    type: "smithers.run_event";
    source: "smithers.gateway.streamRunEvents";
    payload: RunEvent & {
      steeringWindowId: string | null;
      correlationId: string;
    };
  }): Promise<void> | void;
}

export interface RunEventBridgeOptions {
  client: SmithersClient;
  correlations: CorrelationStore;
  cue: CueObservationSink;
  reconnectDelayMs?: number;
  clock?: () => number;
  onReconnect?: (event: { upid: string; afterSeq: number; attempt: number; error: unknown }) => void;
}

export class RunEventBridge {
  readonly client: SmithersClient;
  readonly correlations: CorrelationStore;
  readonly cue: CueObservationSink;
  readonly reconnectDelayMs: number;
  readonly clock: () => number;
  readonly onReconnect?: RunEventBridgeOptions["onReconnect"];
  readonly #seen = new Map<string, Set<number>>();

  constructor(options: RunEventBridgeOptions) {
    this.client = options.client;
    this.correlations = options.correlations;
    this.cue = options.cue;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 5;
    this.clock = options.clock ?? Date.now;
    this.onReconnect = options.onReconnect;
  }

  async start(upid: string, options: { signal?: AbortSignal; maxFrames?: number } = {}): Promise<RunEvent[]> {
    const emitted: RunEvent[] = [];
    let attempt = 0;
    let record = await this.requireCorrelation(upid);
    let afterSeq = record.lastSeq;

    while (!options.signal?.aborted) {
      try {
        for await (const frame of this.client.streamRunEvents(upid, { afterSeq, signal: options.signal })) {
          const current = await this.requireCorrelation(upid);
          const event = normalizeSmithersRunEvent(frame, current);
          if (this.isDuplicate(event)) {
            continue;
          }
          this.markSeen(event);
          afterSeq = event.seq;
          await this.correlations.update(upid, {
            lastSeq: event.seq,
            state: stateFromRunEvent(event),
            updatedAtMs: this.clock(),
          });
          await this.cue.observe({
            type: "smithers.run_event",
            source: "smithers.gateway.streamRunEvents",
            payload: {
              ...event,
              steeringWindowId: current.steeringWindowId,
              correlationId: current.correlationId,
            },
          });
          emitted.push(event);
          if (options.maxFrames !== undefined && emitted.length >= options.maxFrames) {
            return emitted;
          }
        }
        return emitted;
      } catch (error) {
        if (options.signal?.aborted) {
          return emitted;
        }
        this.onReconnect?.({ upid, afterSeq, attempt, error });
        await sleep(this.reconnectDelayMs, options.signal);
        attempt += 1;
        record = await this.requireCorrelation(upid);
        afterSeq = Math.max(afterSeq, record.lastSeq);
      }
    }

    return emitted;
  }

  private async requireCorrelation(upid: string) {
    const record = await this.correlations.findByUPID(upid);
    if (record === undefined) {
      throw new Error(`Cannot stream Smithers events without UPID correlation for ${upid}.`);
    }
    return record;
  }

  private isDuplicate(event: RunEvent): boolean {
    return this.#seen.get(event.runId)?.has(event.seq) ?? false;
  }

  private markSeen(event: RunEvent): void {
    const seen = this.#seen.get(event.runId) ?? new Set<number>();
    seen.add(event.seq);
    this.#seen.set(event.runId, seen);
  }
}

export function normalizeSmithersRunEvent(
  frame: GatewayEventFrame,
  correlation: { upid: string; runId: string },
): RunEvent {
  const payload = typeof frame.payload === "object" && frame.payload !== null ? frame.payload : {};
  const seq = numberValue(payload.seq) ?? numberValue(frame.seq) ?? 0;
  const gatewayEvent = stringValue(payload.event) ?? frame.event;
  const runId = stringValue(payload.runId) ?? correlation.runId;
  return {
    upid: correlation.upid,
    runId,
    kind: classifyRunEvent(gatewayEvent, payload),
    text: summarizeForVoice(textFromPayload(gatewayEvent, payload), 15),
    seq,
  };
}

export function summarizeForVoice(text: string, limit = 15): string {
  const cleaned = text
    .replace(/https?:\/\/\S+/giu, "link")
    .replace(/\b[\w./-]+\.(?:ts|tsx|js|jsx|json|md|html|css|log)\b/giu, "file")
    .replace(/[{}\[\]`]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const words = cleaned.length === 0 ? ["Smithers", "updated"] : cleaned.split(/\s+/u);
  return words.slice(0, limit).join(" ");
}

function classifyRunEvent(event: string, payload: Record<string, unknown>): RunEvent["kind"] {
  const status = stringValue(payload.status)?.toLowerCase() ?? "";
  const haystack = `${event} ${status}`.toLowerCase();
  if (/completed|finished|cancelled|failed/u.test(haystack)) {
    return "completed";
  }
  if (/blocker|waiting-approval|approval|error|failed/u.test(haystack)) {
    return "blocker";
  }
  if (/output|task\.finished|node\.finished|complete/u.test(haystack)) {
    return "output";
  }
  return "state";
}

function textFromPayload(event: string, payload: Record<string, unknown>): string {
  for (const key of ["summary", "text", "message", "title", "status"]) {
    const value = stringValue(payload[key]);
    if (value !== undefined && value.trim().length > 0) {
      return value;
    }
  }
  return event.replace(/[\W_]+/gu, " ");
}

function stateFromRunEvent(event: RunEvent) {
  if (event.kind === "completed") {
    return "completed";
  }
  if (event.kind === "blocker") {
    return "active";
  }
  return "active";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}
