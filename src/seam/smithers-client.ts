import type { CorrelationRecord, CorrelationStore } from "./correlation-store";
import { SmithersGatewayClient as OfficialSmithersGatewayClient } from "smithers-orchestrator/gateway-client";

const SIGNAL_WAIT_TIMEOUT_MS = 2_000;
const SIGNAL_WAIT_POLL_MS = 20;

export interface SpawnSeed {
  upid: string;
  workflow: string;
  runId?: string;
  prompt?: string;
  callsign?: string | null;
  steeringWindowId?: string | null;
  parentId?: string | null;
  input?: Record<string, unknown>;
  correlationId: string;
}

export interface SpawnResult {
  upid: string;
  runId: string;
  workflow: string;
  parentId: string | null;
}

export interface GatewayEventFrame {
  event: string;
  payload?: Record<string, unknown>;
  seq?: number;
  stateVersion?: number;
}

export interface StreamRunEventsOptions {
  afterSeq?: number;
  signal?: AbortSignal;
}

export interface SmithersClient {
  spawn(seed: SpawnSeed): Promise<SpawnResult>;
  steer(upid: string, payload: unknown): Promise<unknown>;
  signal(upid: string, payload: unknown): Promise<unknown>;
  pause(upid: string): Promise<unknown>;
  resume(upid: string): Promise<unknown>;
  halt(upid: string): Promise<unknown>;
  streamRunEvents(upid: string, options?: StreamRunEventsOptions): AsyncIterable<GatewayEventFrame>;
}

export interface GatewayRpcTransport {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  streamRunEvents?(runId: string, options?: StreamRunEventsOptions): AsyncIterable<GatewayEventFrame>;
}

export interface GatewaySmithersClientOptions {
  transport: GatewayRpcTransport;
  correlations: CorrelationStore;
  defaultWorkflow: string;
}

export class GatewaySmithersClient implements SmithersClient {
  readonly transport: GatewayRpcTransport;
  readonly correlations: CorrelationStore;
  readonly defaultWorkflow: string;

  constructor(options: GatewaySmithersClientOptions) {
    this.transport = options.transport;
    this.correlations = options.correlations;
    this.defaultWorkflow = options.defaultWorkflow;
  }

  async spawn(seed: SpawnSeed): Promise<SpawnResult> {
    const runId = seed.runId ?? `panop-${seed.upid}`;
    const workflow = seed.workflow || this.defaultWorkflow;
    const input = {
      ...(seed.input ?? {}),
      upid: seed.upid,
      prompt: seed.prompt ?? "",
      callsign: seed.callsign ?? null,
      steeringWindowId: seed.steeringWindowId ?? null,
      parentId: seed.parentId ?? null,
      correlationId: seed.correlationId,
    };

    await this.transport.request("launchRun", {
      workflow,
      input,
      options: { runId, idempotencyKey: seed.correlationId },
    });

    return { upid: seed.upid, runId, workflow, parentId: seed.parentId ?? null };
  }

  steer(upid: string, payload: unknown): Promise<unknown> {
    return this.signal(upid, { type: "steer", payload });
  }

  async signal(upid: string, payload: unknown): Promise<unknown> {
    const record = await this.requireRecord(upid);
    return this.submitSignal(record, "steer", payload);
  }

  async pause(upid: string): Promise<unknown> {
    const record = await this.requireRecord(upid);
    await this.waitForSignalWait(record, "pause");
    return this.submitSignal(record, "pause", { upid });
  }

  async resume(upid: string): Promise<unknown> {
    const record = await this.requireRecord(upid);
    if (process.env.PANOP_RBG_RESUME_RPC === "1") {
      return this.transport.request("resumeRun", { runId: record.runId, options: { force: false } });
    }
    await this.waitForSignalWait(record, "resume");
    return this.submitSignal(record, "resume", { upid });
  }

  private submitSignal(record: CorrelationRecord, signalName: string, payload: unknown): Promise<unknown> {
    return this.transport.request("submitSignal", {
      runId: record.runId,
      correlationKey: record.correlationId,
      signalName,
      payload,
    });
  }

  private async waitForSignalWait(record: CorrelationRecord, signalName: string): Promise<void> {
    const deadlineAt = Date.now() + SIGNAL_WAIT_TIMEOUT_MS;
    while (Date.now() <= deadlineAt) {
      const run = await this.tryGetRun(record.runId);
      if (run === undefined || isTerminalRun(run)) {
        return;
      }
      if (isBlockedOnSignal(run, signalName)) {
        return;
      }
      await sleep(SIGNAL_WAIT_POLL_MS);
    }
  }

  private async tryGetRun(runId: string): Promise<Record<string, unknown> | undefined> {
    try {
      const run = await this.transport.request("getRun", { runId });
      return isObject(run) ? run : undefined;
    } catch {
      return undefined;
    }
  }

  async halt(upid: string): Promise<unknown> {
    const record = await this.requireRecord(upid);
    return this.transport.request("cancelRun", { runId: record.runId });
  }

  async *streamRunEvents(upid: string, options: StreamRunEventsOptions = {}): AsyncIterable<GatewayEventFrame> {
    const record = await this.requireRecord(upid);
    if (this.transport.streamRunEvents !== undefined) {
      yield* this.transport.streamRunEvents(record.runId, options);
      return;
    }
    await this.transport.request("streamRunEvents", { runId: record.runId, afterSeq: options.afterSeq ?? 0 });
  }

  private async requireRecord(upid: string) {
    const record = await this.correlations.findByUPID(upid);
    if (record === undefined) {
      throw new Error(`No Smithers run is registered for UPID ${upid}.`);
    }
    return record;
  }
}

export class InProcessGatewayTransport implements GatewayRpcTransport {
  readonly gateway: { routeRequest(connection: unknown, frame: unknown): Promise<unknown> };
  readonly connection: unknown;

  constructor(gateway: { routeRequest(connection: unknown, frame: unknown): Promise<unknown> }, connection: unknown) {
    this.gateway = gateway;
    this.connection = connection;
  }

  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const frame = await this.gateway.routeRequest(this.connection, {
      type: "req",
      id: `${method}:${crypto.randomUUID()}`,
      method,
      params,
    });
    if (!isRpcFrame(frame) || frame.ok !== true) {
      throw new Error(`Gateway ${method} failed: ${JSON.stringify(frame)}`);
    }
    return frame.payload;
  }
}

export class HttpGatewayTransport implements GatewayRpcTransport {
  readonly baseUrl: string;
  readonly tokenProvider?: () => string | undefined;

  constructor(baseUrl: string, tokenProvider?: () => string | undefined) {
    this.baseUrl = baseUrl.replace(/\/+$/u, "");
    this.tokenProvider = tokenProvider;
  }

  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const token = this.tokenProvider?.();
    const response = await fetch(`${this.baseUrl}/v1/rpc/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify({
        type: "req",
        id: `${method}:${crypto.randomUUID()}`,
        method,
        params,
      }),
    });
    const payload = await response.json();
    if (!response.ok || payload?.ok === false) {
      throw new Error(`Gateway ${method} failed with HTTP ${response.status}.`);
    }
    return payload.payload ?? payload;
  }
}

export class OfficialGatewayTransport implements GatewayRpcTransport {
  readonly client: OfficialSmithersGatewayClient;

  constructor(options: { baseUrl?: string; token?: string; WebSocket?: typeof WebSocket } = {}) {
    this.client = new OfficialSmithersGatewayClient({
      baseUrl: options.baseUrl,
      token: options.token,
      WebSocket: options.WebSocket,
      client: {
        id: "panopticon-seam",
        version: "0.0.1",
        platform: "bun",
      },
    });
  }

  request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return (this.client as any).rpcRaw(method, params ?? {});
  }

  async *streamRunEvents(runId: string, options: StreamRunEventsOptions = {}): AsyncIterable<GatewayEventFrame> {
    for await (const frame of this.client.streamRunEventsResilient(
      { runId, afterSeq: options.afterSeq },
      { signal: options.signal },
    )) {
      yield {
        event: frame.event,
        payload: typeof frame.payload === "object" && frame.payload !== null
          ? (frame.payload as Record<string, unknown>)
          : undefined,
        seq: frame.seq,
        stateVersion: frame.stateVersion,
      };
    }
  }
}

function isRpcFrame(value: unknown): value is { ok: boolean; payload?: unknown } {
  return typeof value === "object" && value !== null && "ok" in value;
}

function isTerminalRun(run: Record<string, unknown>): boolean {
  return run.status === "finished" || run.status === "failed" || run.status === "cancelled";
}

function isBlockedOnSignal(run: Record<string, unknown>, signalName: string): boolean {
  const runState = isObject(run.runState) ? run.runState : undefined;
  const blocked = isObject(runState?.blocked) ? runState.blocked : undefined;
  return runState?.state === "waiting-event" &&
    blocked?.kind === "event" &&
    blocked.nodeId === signalName;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
