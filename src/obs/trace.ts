import { logEventSchema, type CueDecision, type LogEvent, type TranscriptObservation } from "../types";

export type TraceClock = () => number;

export type RedactionFilter = (value: unknown, context: RedactionContext) => unknown;

export interface RedactionContext {
  event: string;
  path: readonly string[];
}

export interface TraceProcessorOptions {
  clock?: TraceClock;
  redactionFilters?: readonly RedactionFilter[];
}

export interface TraceInput {
  level?: LogEvent["level"];
  event: string;
  sessionId: string;
  correlationId: string;
  upid?: string;
  startedAtMs: number;
  endedAtMs?: number;
  meta?: Record<string, unknown>;
}

export interface CausalChain {
  correlationId: string;
  complete: boolean;
  missingStages: Array<"observation" | "decision" | "action" | "outcome">;
  observation: LogEvent[];
  decision: LogEvent[];
  action: LogEvent[];
  outcome: LogEvent[];
  events: LogEvent[];
}

type ChainStage = "observation" | "decision" | "action" | "outcome" | null;

const defaultClock: TraceClock = () => performance.now();

export class TraceProcessor {
  readonly #events: LogEvent[] = [];
  readonly #clock: TraceClock;
  readonly #redactionFilters: readonly RedactionFilter[];

  constructor(options: TraceProcessorOptions = {}) {
    this.#clock = options.clock ?? defaultClock;
    this.#redactionFilters = options.redactionFilters ?? [];
  }

  record(input: TraceInput): LogEvent {
    const endedAtMs = input.endedAtMs ?? this.#clock();
    const latencyMs = measureLatency(input.startedAtMs, endedAtMs);
    const meta = redactValue(input.meta ?? {}, input.event, this.#redactionFilters, []);
    assertJsonSerializable(meta, ["meta"]);

    const event = logEventSchema.parse({
      level: input.level ?? "info",
      event: input.event,
      sessionId: input.sessionId,
      correlationId: input.correlationId,
      upid: input.upid,
      latencyMs,
      meta,
    });

    assertRequiredTraceIds(event);
    this.#events.push(event);
    return event;
  }

  async process<T>(input: TraceInput, downstream: (event: LogEvent) => T | Promise<T>): Promise<T> {
    const event = this.record(input);
    return downstream(event);
  }

  recordObservationPass(
    input: Omit<TraceInput, "event"> & {
      meta: {
        addressed: boolean;
        reason: string;
        utteranceId: string;
        policy: string;
        [key: string]: unknown;
      };
    },
  ): [LogEvent, LogEvent] {
    const observed = this.record({
      ...input,
      event: "observe.pass",
      meta: input.meta,
    });

    const routed = this.record({
      ...input,
      event: "route.pass",
      meta: {
        ...input.meta,
        observeEvent: observed.event,
      },
    });

    return [observed, routed];
  }

  emitDecision(decision: CueDecision, observation: TranscriptObservation): LogEvent[] {
    const startedAtMs = this.#clock() - observation.latencyMs;
    const base = {
      sessionId: observation.sessionId,
      correlationId: decision.correlationId,
      startedAtMs,
      endedAtMs: startedAtMs + observation.latencyMs,
    };

    if (decision.kind === "pass") {
      return this.recordObservationPass({
        ...base,
        meta: {
          addressed: decision.addressed,
          reason: decision.reason,
          utteranceId: observation.utteranceId,
          policy: decision.policy,
          decisionId: decision.decisionId,
          observationText: observation.text,
          ...decision.meta,
        },
      });
    }

    return [
      this.record({
        ...base,
        event: "route.action",
        upid: decision.action.targetUPID ?? undefined,
        meta: {
          action: decision.action.type,
          targetUPID: decision.action.targetUPID,
          utteranceId: observation.utteranceId,
          observationId: observation.utteranceId,
          payload: decision.action.payload,
          decisionId: decision.decisionId,
          policy: decision.policy,
        },
      }),
    ];
  }

  events(): LogEvent[] {
    return [...this.#events];
  }

  query(correlationId: string): CausalChain {
    return reconstructCausalChain(this.#events, correlationId);
  }

  toJsonl(): string {
    return serializeTraceJsonl(this.#events);
  }

  static fromJsonl(jsonl: string, options: TraceProcessorOptions = {}): TraceProcessor {
    const processor = new TraceProcessor(options);
    processor.#events.push(...parseTraceJsonl(jsonl));
    return processor;
  }
}

export function serializeTraceJsonl(events: readonly LogEvent[]): string {
  return events.map((event) => JSON.stringify(logEventSchema.parse(event))).join("\n");
}

export function parseTraceJsonl(jsonl: string): LogEvent[] {
  const events: LogEvent[] = [];

  for (const [index, rawLine] of jsonl.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid trace JSONL at line ${index + 1}: ${(error as Error).message}`);
    }

    const event = logEventSchema.parse(parsed);
    assertRequiredTraceIds(event);
    events.push(event);
  }

  return events;
}

export function reconstructCausalChain(events: readonly LogEvent[], correlationId: string): CausalChain {
  const matching = events
    .filter((event) => event.correlationId === correlationId)
    .sort((left, right) => {
      const leftSeq = typeof left.meta.seq === "number" ? left.meta.seq : Number.MAX_SAFE_INTEGER;
      const rightSeq = typeof right.meta.seq === "number" ? right.meta.seq : Number.MAX_SAFE_INTEGER;
      return leftSeq - rightSeq;
    });

  const chain: CausalChain = {
    correlationId,
    complete: false,
    missingStages: [],
    observation: [],
    decision: [],
    action: [],
    outcome: [],
    events: matching,
  };

  for (const event of matching) {
    const stage = classifyStage(event.event);
    if (stage !== null) {
      chain[stage].push(event);
    }
  }

  for (const stage of ["observation", "decision", "action", "outcome"] as const) {
    if (chain[stage].length === 0) {
      chain.missingStages.push(stage);
    }
  }

  chain.complete = chain.missingStages.length === 0;
  return chain;
}

function measureLatency(startedAtMs: number, endedAtMs: number): number {
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
    throw new Error("Trace latency requires finite measured timestamps.");
  }

  const latencyMs = endedAtMs - startedAtMs;
  if (latencyMs < 0) {
    throw new Error("Trace latency cannot be negative.");
  }

  return latencyMs;
}

function assertRequiredTraceIds(event: LogEvent): void {
  if (event.correlationId === undefined || event.correlationId.length === 0) {
    throw new Error(`Trace event ${event.event} is missing correlationId.`);
  }

  if (requiresUpid(event.event) && (event.upid === undefined || event.upid.length === 0)) {
    throw new Error(`Trace event ${event.event} is missing upid.`);
  }

  if (event.latencyMs === undefined) {
    throw new Error(`Trace event ${event.event} is missing measured latencyMs.`);
  }
}

function requiresUpid(event: string): boolean {
  return /^process\./u.test(event);
}

function classifyStage(event: string): ChainStage {
  if (/^observe\./u.test(event)) {
    return "observation";
  }

  if (/^(command|route)\./u.test(event)) {
    return "decision";
  }

  if (/^safety\./u.test(event)) {
    return "action";
  }

  if (/^process\.(spawn|steer|pause|resume|halt|pauseAll|status)$/u.test(event)) {
    return "action";
  }

  if (/^(ack|earcon|output)\./u.test(event) || /^process\.(blocker|completed|failed|state)$/u.test(event)) {
    return "outcome";
  }

  return null;
}

function redactValue(
  value: unknown,
  event: string,
  filters: readonly RedactionFilter[],
  path: readonly string[],
): unknown {
  let current = value;
  for (const filter of filters) {
    current = filter(current, { event, path });
  }

  if (Array.isArray(current)) {
    return current.map((item, index) => redactValue(item, event, filters, [...path, String(index)]));
  }

  if (current !== null && typeof current === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(current)) {
      redacted[key] = redactValue(nested, event, filters, [...path, key]);
    }
    return redacted;
  }

  return current;
}

function assertJsonSerializable(value: unknown, path: readonly string[]): void {
  if (
    value === undefined ||
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol" ||
    (typeof value === "number" && !Number.isFinite(value))
  ) {
    throw new Error(`Trace meta contains non-JSON value at ${path.join(".")}.`);
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonSerializable(item, [...path, String(index)]));
    return;
  }

  if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      assertJsonSerializable(nested, [...path, key]);
    }
  }
}
