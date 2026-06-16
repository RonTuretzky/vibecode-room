import { z } from "zod";
import { logEventSchema, type CueDecision, type LogEvent, type TranscriptObservation } from "../types";
import { redactSecretValues } from "../security/secrets";

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

export interface CueTraceSources {
  observationsJsonl: string;
  decisionsJsonl: string;
  actionsJsonl: string;
  smithersJsonl: string;
}

export interface NormalizedTraceRecord {
  source: "cue.observations" | "cue.decisions" | "cue.actions" | "smithers";
  event: string;
  correlationId?: string;
  upid?: string;
  runId?: string;
  utteranceId?: string;
  seq: number;
  raw: Record<string, unknown>;
}

export interface CrossComponentCausalChain {
  correlationId: string;
  upids: string[];
  complete: boolean;
  missingStages: Array<"observation" | "decision" | "action" | "outcome">;
  observation: NormalizedTraceRecord[];
  decision: NormalizedTraceRecord[];
  action: NormalizedTraceRecord[];
  outcome: NormalizedTraceRecord[];
  events: NormalizedTraceRecord[];
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
    const redacted = redactValue(input.meta ?? {}, input.event, this.#redactionFilters, []);
    const identifiers = redactTraceFields({
      event: input.event,
      sessionId: input.sessionId,
      correlationId: input.correlationId,
      upid: input.upid,
    });
    const meta = redacted.value;
    assertJsonSerializable(meta, ["meta"]);

    const redactionCount = redacted.count + identifiers.count;
    if (redactionCount > 0) {
      this.#events.push(
        logEventSchema.parse({
          level: "warn",
          event: "secret.redacted",
          sessionId: identifiers.fields.sessionId,
          correlationId: identifiers.fields.correlationId,
          upid: identifiers.fields.upid,
          latencyMs,
          meta: { count: redactionCount, sourceEvent: identifiers.fields.event },
        }),
      );
    }

    const event = logEventSchema.parse({
      level: input.level ?? "info",
      event: identifiers.fields.event,
      sessionId: identifiers.fields.sessionId,
      correlationId: identifiers.fields.correlationId,
      upid: identifiers.fields.upid,
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
  return events.flatMap(sanitizeLogEventForEmission).map((event) => JSON.stringify(logEventSchema.parse(event))).join("\n");
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

export function reconstructCrossComponentCausalChain(
  sources: CueTraceSources,
  correlationId: string,
): CrossComponentCausalChain {
  const observations = parseLooseJsonl(sources.observationsJsonl, "cue.observations");
  const decisions = parseLooseJsonl(sources.decisionsJsonl, "cue.decisions");
  const actions = parseLooseJsonl(sources.actionsJsonl, "cue.actions");
  const smithers = parseLooseJsonl(sources.smithersJsonl, "smithers");
  const all = [
    ...normalizeLooseRecords(observations, "cue.observations"),
    ...normalizeLooseRecords(decisions, "cue.decisions"),
    ...normalizeLooseRecords(actions, "cue.actions"),
    ...normalizeLooseRecords(smithers, "smithers"),
  ];

  const direct = all.filter((record) => record.correlationId === correlationId);
  const upids = new Set(direct.flatMap((record) => (record.upid === undefined ? [] : [record.upid])));
  const joined = all
    .filter((record) => record.correlationId === correlationId || (record.upid !== undefined && upids.has(record.upid)))
    .sort((left, right) => left.seq - right.seq);

  const chain: CrossComponentCausalChain = {
    correlationId,
    upids: [...upids].sort(),
    complete: false,
    missingStages: [],
    observation: [],
    decision: [],
    action: [],
    outcome: [],
    events: joined,
  };

  for (const record of joined) {
    const stage = classifyNormalizedStage(record);
    chain[stage].push(record);
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

function sanitizeLogEventForEmission(event: LogEvent): LogEvent[] {
  const redacted = redactSecretValues(event.meta, ["meta"]);
  const identifiers = redactTraceFields({
    event: event.event,
    sessionId: event.sessionId,
    correlationId: event.correlationId,
    upid: event.upid,
  });
  const redactionCount = redacted.count + identifiers.count;
  const sanitized = logEventSchema.parse({
    ...event,
    event: identifiers.fields.event,
    sessionId: identifiers.fields.sessionId,
    correlationId: identifiers.fields.correlationId,
    upid: identifiers.fields.upid,
    meta: redacted.value as Record<string, unknown>,
  });

  if (redactionCount === 0) {
    return [sanitized];
  }

  return [
    logEventSchema.parse({
      level: "warn",
      event: "secret.redacted",
      sessionId: identifiers.fields.sessionId,
      correlationId: identifiers.fields.correlationId,
      upid: identifiers.fields.upid,
      latencyMs: event.latencyMs,
      meta: { count: redactionCount, sourceEvent: identifiers.fields.event },
    }),
    sanitized,
  ];
}

function redactTraceFields(fields: {
  event: string;
  sessionId: string;
  correlationId?: string;
  upid?: string;
}): {
  fields: {
    event: string;
    sessionId: string;
    correlationId?: string;
    upid?: string;
  };
  count: number;
} {
  const event = redactTraceEventName(fields.event);
  const sessionId = redactTraceIdentifier(fields.sessionId, "sessionId");
  const correlationId =
    fields.correlationId === undefined ? { value: undefined, count: 0 } : redactTraceIdentifier(fields.correlationId, "correlationId");
  const upid = fields.upid === undefined ? { value: undefined, count: 0 } : redactTraceIdentifier(fields.upid, "upid");

  return {
    fields: {
      event: event.value,
      sessionId: sessionId.value,
      correlationId: correlationId.value,
      upid: upid.value,
    },
    count: event.count + sessionId.count + correlationId.count + upid.count,
  };
}

function redactTraceEventName(event: string): { value: string; count: number } {
  const redacted = redactSecretValues(event, ["event"]);
  if (redacted.count === 0) {
    return { value: event, count: 0 };
  }

  return { value: "redacted.secret", count: redacted.count };
}

function redactTraceIdentifier(value: string, field: string): { value: string; count: number } {
  const redacted = redactSecretValues(value, [field]);
  return { value: String(redacted.value), count: redacted.count };
}

function redactValue(
  value: unknown,
  event: string,
  filters: readonly RedactionFilter[],
  path: readonly string[],
): { value: unknown; count: number } {
  let current = value;
  for (const filter of filters) {
    current = filter(current, { event, path });
  }

  if (Array.isArray(current)) {
    let count = 0;
    const value = current.map((item, index) => {
      const redacted = redactValue(item, event, filters, [...path, String(index)]);
      count += redacted.count;
      return redacted.value;
    });
    return { value, count };
  }

  if (current !== null && typeof current === "object") {
    let count = 0;
    const redacted: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(current)) {
      const keyRedacted = redactSecretValues(key, []);
      const nestedRedacted = redactValue(nested, event, filters, [...path, key]);
      count += keyRedacted.count + nestedRedacted.count;
      redacted[uniqueRedactedKey(redacted, String(keyRedacted.value))] = nestedRedacted.value;
    }
    return { value: redacted, count };
  }

  return redactSecretValues(current, path);
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

const looseRecordSchema = z.record(z.string(), z.unknown());

function parseLooseJsonl(jsonl: string, label: NormalizedTraceRecord["source"]): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];

  for (const [index, rawLine] of jsonl.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid ${label} JSONL at line ${index + 1}: ${(error as Error).message}`);
    }
    records.push(looseRecordSchema.parse(parsed));
  }

  return records;
}

function normalizeLooseRecords(
  records: readonly Record<string, unknown>[],
  source: NormalizedTraceRecord["source"],
): NormalizedTraceRecord[] {
  return records.map((raw, index) => ({
    source,
    event: firstString(raw, ["event", "type", "kind"]) ?? source,
    correlationId: firstString(raw, ["correlationId", "correlation_id"], ["meta", "payload", "attributes"]),
    upid: firstString(raw, ["upid", "targetUPID", "targetUpid", "processId"], ["meta", "payload", "attributes"]),
    runId: firstString(raw, ["runId", "run_id"], ["meta", "payload", "attributes"]),
    utteranceId: firstString(raw, ["utteranceId", "utterance_id"], ["meta", "payload", "attributes"]),
    seq: firstNumber(raw, ["seq", "sequence", "timestampMs", "timeUnixNano"], ["meta", "payload", "attributes"]) ?? index,
    raw,
  }));
}

function classifyNormalizedStage(record: NormalizedTraceRecord): "observation" | "decision" | "action" | "outcome" {
  if (record.source === "cue.observations" || /^observe\./u.test(record.event)) {
    return "observation";
  }
  if (record.source === "cue.decisions" || /^(command|route|decision)\./u.test(record.event)) {
    return "decision";
  }
  if (record.source === "cue.actions" || /^process\.(spawn|steer|pause|resume|halt|pauseAll|status)$/u.test(record.event)) {
    return "action";
  }
  return "outcome";
}

function firstString(
  raw: Record<string, unknown>,
  keys: readonly string[],
  containers: readonly string[] = [],
): string | undefined {
  const value = firstValue(raw, keys, containers);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function firstNumber(
  raw: Record<string, unknown>,
  keys: readonly string[],
  containers: readonly string[] = [],
): number | undefined {
  const value = firstValue(raw, keys, containers);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstValue(
  raw: Record<string, unknown>,
  keys: readonly string[],
  containers: readonly string[],
): unknown {
  for (const key of keys) {
    if (raw[key] !== undefined) {
      return raw[key];
    }
  }

  for (const container of containers) {
    const nested = raw[container];
    if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
      const value = firstValue(nested as Record<string, unknown>, keys, []);
      if (value !== undefined) {
        return value;
      }
    }
  }

  return undefined;
}

function uniqueRedactedKey(target: Record<string, unknown>, key: string): string {
  if (!Object.hasOwn(target, key)) {
    return key;
  }

  let index = 2;
  while (Object.hasOwn(target, `${key}#${index}`)) {
    index += 1;
  }
  return `${key}#${index}`;
}
