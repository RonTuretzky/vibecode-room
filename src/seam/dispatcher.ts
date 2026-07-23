import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { dispatchedActionSchema, type DispatchedAction, type LogEvent } from "../types";
import { TraceProcessor } from "../obs/trace";
import { summarizeFleetStatus } from "../process/registry";
import { CallsignAllocator } from "../routing/callsigns";
import { createCorrelationRecord, type CorrelationStore, type CorrelationRecord } from "./correlation-store";
import type { SmithersClient, SpawnSeed } from "./smithers-client";

export interface DispatchAck {
  accepted: true;
  actionType: DispatchedAction["type"];
  correlationId: string;
  targetUPID: string | null;
  statusSummary?: string;
}

export interface DispatchFailure {
  accepted: false;
  correlationId?: string;
  error: string;
}

export type DispatchResult = DispatchAck | DispatchFailure;

export interface SeamDispatcherOptions {
  client: SmithersClient;
  correlations: CorrelationStore;
  sessionId?: string;
  trace?: TraceProcessor;
  spawnBudgetMs?: number;
  now?: () => number;
  onTrace?: (event: LogEvent) => void;
  callsigns?: CallsignAllocator;
}

export class SeamDispatcher {
  readonly client: SmithersClient;
  readonly correlations: CorrelationStore;
  readonly sessionId: string;
  readonly trace: TraceProcessor;
  readonly spawnBudgetMs: number;
  readonly now: () => number;
  readonly onTrace?: (event: LogEvent) => void;
  readonly callsigns: CallsignAllocator;
  readonly pending: Set<Promise<unknown>> = new Set();

  constructor(options: SeamDispatcherOptions) {
    this.client = options.client;
    this.correlations = options.correlations;
    this.sessionId = options.sessionId ?? "vibersyn-seam";
    this.trace = options.trace ?? new TraceProcessor();
    this.spawnBudgetMs = options.spawnBudgetMs ?? 3_000;
    this.now = options.now ?? (() => performance.now());
    this.onTrace = options.onTrace;
    this.callsigns = options.callsigns ?? new CallsignAllocator();
  }

  async dispatch(rawAction: unknown): Promise<DispatchResult> {
    const actionInput = process.env.VIBERSYN_RBG_RENAME_ACTION_FIELD === "1" && isObject(rawAction)
      ? renameTargetField(rawAction)
      : rawAction;
    const parsed = dispatchedActionSchema.safeParse(actionInput);
    if (!parsed.success) {
      return { accepted: false, error: parsed.error.message };
    }

    let action = parsed.data;
    const startedAtMs = this.now();
    if (
      process.env.VIBERSYN_RBG_ALLOW_MISSING_TARGET !== "1" &&
      requiresTarget(action.type) &&
      action.targetUPID === null
    ) {
      this.recordTrace(action, "seam.dispatch.rejected", startedAtMs, {
        reason: "missing-target-upid",
        payloadKind: payloadKind(action.payload),
      });
      return {
        accepted: false,
        correlationId: action.correlationId,
        error: `${action.type} requires targetUPID.`,
      };
    }

    if (action.type === "spawn") {
      const prepared = await this.prepareSpawnCallsign(action, startedAtMs);
      if (!prepared.ok) {
        return { accepted: false, correlationId: action.correlationId, error: prepared.error };
      }
      action = prepared.action;
    }

    const traceEvent = this.recordTrace(action, "seam.dispatch.accepted", startedAtMs, {
      payloadKind: payloadKind(action.payload),
    });

    if (action.type === "status") {
      return this.statusAck(action, startedAtMs);
    }

    const work = process.env.VIBERSYN_RBG_BLOCK_DISPATCH === "1"
      ? this.performAction(action)
      : Promise.resolve().then(() => this.performAction(action));
    this.track(work);

    if (process.env.VIBERSYN_RBG_BLOCK_DISPATCH === "1") {
      busyWait(250);
    }

    return {
      accepted: true,
      actionType: action.type,
      correlationId: traceEvent.correlationId ?? action.correlationId,
      targetUPID: action.targetUPID,
    };
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  async statusSummary(): Promise<string> {
    const active = await this.correlations.allActive();
    return summarizeFleetStatus(active);
  }

  private async statusAck(action: DispatchedAction, startedAtMs: number): Promise<DispatchAck> {
    const statusSummary = await this.statusSummary();
    this.recordTrace(action, "seam.status", startedAtMs, {
      statusSummary,
      wordCount: wordCount(statusSummary),
    }, "registry");
    return {
      accepted: true,
      actionType: "status",
      correlationId: action.correlationId,
      targetUPID: null,
      statusSummary,
    };
  }

  private async performAction(action: DispatchedAction): Promise<void> {
    const startedAtMs = this.now();
    switch (action.type) {
      case "spawn": {
        const seed = spawnSeedFromAction(action);
        const spawned = await this.client.spawn(seed);
        await this.correlations.upsert(
          createCorrelationRecord({
            upid: spawned.upid,
            runId: spawned.runId,
            callsign: seed.callsign ?? null,
            steeringWindowId: seed.steeringWindowId ?? null,
            correlationId: action.correlationId,
            parentId: spawned.parentId,
            state: "planning",
            nowMs: Date.now(),
          }),
        );
        this.recordTrace(action, "process.spawn", startedAtMs, {
          runId: spawned.runId,
          workflow: spawned.workflow,
          parentId: spawned.parentId,
        }, spawned.upid);
        return;
      }
      case "steer":
        await this.withTarget(action, (upid) => this.client.steer(upid, action.payload), "process.steer", startedAtMs);
        return;
      case "pause":
        await this.withTarget(action, async (upid) => {
          await this.client.pause(upid);
          await this.correlations.update(upid, { state: "paused", updatedAtMs: Date.now() });
        }, "process.pause", startedAtMs);
        return;
      case "resume":
        await this.withTarget(action, async (upid) => {
          await this.client.resume(upid);
          await this.correlations.update(upid, { state: "active", updatedAtMs: Date.now() });
        }, "process.resume", startedAtMs);
        return;
      case "halt":
        await this.withTarget(action, async (upid) => {
          await this.client.halt(upid);
          await this.correlations.update(upid, { state: "halted", updatedAtMs: Date.now() });
          this.callsigns.release(upid);
        }, "process.halt", startedAtMs);
        return;
      case "pauseAll": {
        const active = await this.correlations.allActive();
        await Promise.all(active.map((record) => this.client.pause(record.upid)));
        await Promise.all(active.map((record) => this.correlations.update(record.upid, { state: "paused", updatedAtMs: Date.now() })));
        this.recordTrace(action, "process.pauseall", startedAtMs, { count: active.length }, "fleet");
        return;
      }
      case "status":
        return;
      default:
        assertNever(action.type);
    }
  }

  private async withTarget(
    action: DispatchedAction,
    operation: (upid: string) => Promise<unknown>,
    event: string,
    startedAtMs: number,
  ): Promise<void> {
    if (action.targetUPID === null) {
      throw new Error(`${action.type} requires targetUPID.`);
    }
    await operation(action.targetUPID);
    this.recordTrace(action, event, startedAtMs, { payloadKind: payloadKind(action.payload) }, action.targetUPID);
  }

  private track(work: Promise<unknown>): void {
    this.pending.add(work);
    work.finally(() => this.pending.delete(work)).catch(() => undefined);
  }

  private recordTrace(
    action: DispatchedAction,
    event: string,
    startedAtMs: number,
    meta: Record<string, unknown>,
    upid = action.targetUPID ?? undefined,
  ): LogEvent {
    const traceEvent = this.trace.record({
      event,
      sessionId: this.sessionId,
      correlationId: action.correlationId,
      upid,
      startedAtMs,
      endedAtMs: this.now(),
      meta: {
        actionType: action.type,
        targetUPID: action.targetUPID,
        ...meta,
      },
    });
    this.onTrace?.(traceEvent);
    return traceEvent;
  }

  private async prepareSpawnCallsign(
    action: DispatchedAction,
    startedAtMs: number,
  ): Promise<{ ok: true; action: DispatchedAction } | { ok: false; error: string }> {
    const payload = isObject(action.payload) ? action.payload : {};
    const active = await this.correlations.allActive();
    this.callsigns.syncActive(
      active
        .filter((record) => record.callsign !== null)
        .map((record) => ({ upid: record.upid, callsign: record.callsign as string })),
    );

    const upid = stringValue(payload.upid) ?? action.targetUPID ?? `upid-${action.correlationId}`;
    try {
      const assignment = this.callsigns.assign(upid, nullableString(payload.callsign));
      const nextPayload = {
        ...payload,
        upid,
        callsign: assignment.callsign,
      };
      const traceEvent = this.trace.record({
        event: "command.callsign",
        sessionId: this.sessionId,
        correlationId: action.correlationId,
        upid,
        startedAtMs,
        endedAtMs: this.now(),
        meta: {
          callsign: assignment.callsign,
          metaphone: assignment.profile.metaphone,
          phonemes: assignment.profile.phonemes,
          reusedAfterCooldown: assignment.reusedAfterCooldown,
          poolIndex: assignment.poolIndex,
        },
      });
      this.onTrace?.(traceEvent);
      return { ok: true, action: { ...action, payload: nextPayload } };
    } catch (error) {
      this.recordTrace(action, "seam.dispatch.rejected", startedAtMs, {
        reason: "callsign-unavailable",
        message: (error as Error).message,
      }, upid);
      return { ok: false, error: (error as Error).message };
    }
  }
}

export function createSeamApp(dispatcher: SeamDispatcher): Hono {
  const app = new Hono();

  app.get("/health", (context) => context.json({ ok: true, module: "vibersyn-seam" }));
  app.post("/actions", async (context) => {
    const action = await context.req.json();
    const result = await dispatcher.dispatch(action);
    return context.json(result, result.accepted ? 202 : 400);
  });
  app.get("/status", async (context) => context.json({ summary: await dispatcher.statusSummary() }));
  app.get(
    "/ws",
    upgradeWebSocket(() => ({
      onMessage(event, ws) {
        void dispatcher.dispatch(JSON.parse(String(event.data))).then((result) => {
          ws.send(JSON.stringify(result));
        });
      },
    })),
  );

  return app;
}

export function summarizeRegistry(records: readonly CorrelationRecord[]): string {
  if (records.length === 0) {
    return "No active processes.";
  }
  return clampWords(records.map((record) => `${record.callsign ?? record.upid} ${record.state}`).join("; "), 15);
}

function spawnSeedFromAction(action: DispatchedAction): SpawnSeed {
  const payload = isObject(action.payload) ? action.payload : {};
  const upid = stringValue(payload.upid) ?? action.targetUPID ?? `upid-${action.correlationId}`;
  return {
    upid,
    workflow: stringValue(payload.workflow) ?? "vibersyn-process",
    runId: stringValue(payload.runId),
    prompt: stringValue(payload.prompt) ?? stringValue(payload.seed),
    callsign: nullableString(payload.callsign),
    steeringWindowId: nullableString(payload.steeringWindowId),
    parentId: nullableString(payload.parentId),
    input: isObject(payload.input) ? payload.input : payload,
    correlationId: action.correlationId,
  };
}

function clampWords(text: string, limit: number): string {
  const words = text.trim().split(/\s+/u).filter(Boolean);
  return words.slice(0, limit).join(" ");
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/u).filter(Boolean).length;
}

function requiresTarget(type: DispatchedAction["type"]): boolean {
  return type === "steer" || type === "pause" || type === "resume" || type === "halt";
}

function payloadKind(payload: unknown): string {
  if (payload === null) {
    return "null";
  }
  if (Array.isArray(payload)) {
    return "array";
  }
  return typeof payload;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  return stringValue(value);
}


function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renameTargetField(action: Record<string, unknown>) {
  const { targetUPID, ...rest } = action;
  return { ...rest, targetUpid: targetUPID };
}

function busyWait(ms: number): void {
  const started = performance.now();
  while (performance.now() - started < ms) {
    // Intentional RBG-only hot-path stall.
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled dispatched action ${String(value)}.`);
}
