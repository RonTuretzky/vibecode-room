import { describe, expect, test } from "bun:test";
import type { DispatchedAction } from "../types";
import { createCorrelationRecord, MemoryCorrelationStore } from "./correlation-store";
import { createSeamApp, SeamDispatcher } from "./dispatcher";
import {
  GatewaySmithersClient,
  type GatewayEventFrame,
  type GatewayRpcTransport,
  type SmithersClient,
  type SpawnResult,
  type StreamRunEventsOptions,
} from "./smithers-client";

describe("Cue Smithers seam dispatcher", () => {
  test("action-schema-match covers the V0 action set and rejects approval/read-back actions", async () => {
    const client = new MockSmithersClient();
    const store = new MemoryCorrelationStore([
      processRecord("upid-atlas", "run-atlas", "Atlas"),
      processRecord("upid-bravo", "run-bravo", "Bravo"),
    ]);
    const dispatcher = new SeamDispatcher({ client, correlations: store });
    const actions: DispatchedAction[] = [
      spawnAction(),
      { type: "steer", targetUPID: "upid-atlas", payload: { text: "ship it" }, correlationId: "corr-steer" },
      { type: "pause", targetUPID: "upid-atlas", payload: {}, correlationId: "corr-pause" },
      { type: "resume", targetUPID: "upid-atlas", payload: {}, correlationId: "corr-resume" },
      { type: "halt", targetUPID: "upid-atlas", payload: {}, correlationId: "corr-halt" },
      { type: "pauseAll", targetUPID: null, payload: {}, correlationId: "corr-pause-all" },
      { type: "status", targetUPID: null, payload: {}, correlationId: "corr-status" },
    ];

    for (const action of actions) {
      const result = await dispatcher.dispatch(action);
      expect(result.accepted).toBe(true);
    }
    await dispatcher.drain();

    expect(client.calls.map((call) => call.name)).toEqual([
      "spawn",
      "steer",
      "pause",
      "resume",
      "halt",
      "pause",
    ]);
    await expect(dispatcher.statusSummary()).resolves.toBe("Bravo paused; mavolune planning");
    expect(await dispatcher.dispatch({ ...spawnAction(), type: "approve" })).toEqual(
      expect.objectContaining({ accepted: false }),
    );
    expect(await dispatcher.dispatch({ ...spawnAction(), type: "deny" })).toEqual(
      expect.objectContaining({ accepted: false }),
    );
  });

  test("per-process actions without targetUPID fail before off-path Smithers work starts", async () => {
    const client = new MockSmithersClient();
    const dispatcher = new SeamDispatcher({ client, correlations: new MemoryCorrelationStore() });

    for (const type of ["steer", "pause", "resume", "halt"] as const) {
      const result = await dispatcher.dispatch({
        type,
        targetUPID: null,
        payload: { text: "missing target" },
        correlationId: `corr-missing-${type}`,
      });

      expect(result).toEqual({
        accepted: false,
        correlationId: `corr-missing-${type}`,
        error: `${type} requires targetUPID.`,
      });
    }

    await dispatcher.drain();
    expect(client.calls).toHaveLength(0);
  });

  test("async-dispatch returns immediately while a slow Smithers spawn is still pending", async () => {
    const client = new MockSmithersClient({ spawnDelayMs: 300 });
    const store = new MemoryCorrelationStore();
    const dispatcher = new SeamDispatcher({ client, correlations: store });
    const startedAt = performance.now();

    const accepted = await dispatcher.dispatch(spawnAction());
    const elapsedMs = performance.now() - startedAt;
    const status = await dispatcher.dispatch({ type: "status", targetUPID: null, payload: {}, correlationId: "corr-status" });

    expect(accepted.accepted).toBe(true);
    expect(status.accepted).toBe(true);
    if (status.accepted) {
      expect(status.statusSummary).toBe("No active processes.");
    }
    expect(elapsedMs).toBeLessThan(100);

    await dispatcher.drain();
    expect(client.calls.map((call) => call.name)).toContain("spawn");
    expect(await store.findByUPID("upid-seam-001")).toEqual(
      expect.objectContaining({ runId: "run-seam-001", steeringWindowId: "window-seam-001" }),
    );
  });

  test("Hono HTTP dispatcher accepts DispatchedAction payloads and status remains <=15 words", async () => {
    const client = new MockSmithersClient();
    const store = new MemoryCorrelationStore([processRecord("upid-atlas", "run-atlas", "Atlas")]);
    const dispatcher = new SeamDispatcher({ client, correlations: store });
    const app = createSeamApp(dispatcher);

    const response = await app.request("/actions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "status", targetUPID: null, payload: {}, correlationId: "corr-status" }),
    });
    const payload = await response.json();
    const status = await app.request("/status");
    const statusPayload = await status.json();

    expect(response.status).toBe(202);
    expect(payload.accepted).toBe(true);
    expect(payload.statusSummary).toBe("Atlas active");
    expect(String(payload.statusSummary).split(/\s+/u).length).toBeLessThanOrEqual(15);
    expect(String(statusPayload.summary).split(/\s+/u).length).toBeLessThanOrEqual(15);
  });

  test("Gateway client pause and resume use per-process submitSignal correlation keys", async () => {
    const store = new MemoryCorrelationStore([processRecord("upid-atlas", "run-atlas", "Atlas")]);
    const transport = new RecordingGatewayTransport();
    const client = new GatewaySmithersClient({
      transport,
      correlations: store,
      defaultWorkflow: "vibersyn-test",
    });

    await client.pause("upid-atlas");
    await client.resume("upid-atlas");

    expect(transport.requests).toEqual([
      {
        method: "getRun",
        params: {
          runId: "run-atlas",
        },
      },
      {
        method: "submitSignal",
        params: {
          runId: "run-atlas",
          correlationKey: "corr-upid-atlas",
          signalName: "pause",
          payload: { upid: "upid-atlas" },
        },
      },
      {
        method: "getRun",
        params: {
          runId: "run-atlas",
        },
      },
      {
        method: "submitSignal",
        params: {
          runId: "run-atlas",
          correlationKey: "corr-upid-atlas",
          signalName: "resume",
          payload: { upid: "upid-atlas" },
        },
      },
    ]);
  });
});

class MockSmithersClient implements SmithersClient {
  readonly calls: Array<{ name: string; upid?: string; payload?: unknown }> = [];
  readonly spawnDelayMs: number;
  readonly streams: Array<Array<GatewayEventFrame | Error>>;
  streamIndex = 0;

  constructor(options: { spawnDelayMs?: number; streams?: Array<Array<GatewayEventFrame | Error>> } = {}) {
    this.spawnDelayMs = options.spawnDelayMs ?? 0;
    this.streams = options.streams ?? [];
  }

  async spawn(seed: { upid: string; workflow: string; runId?: string; parentId?: string | null }): Promise<SpawnResult> {
    this.calls.push({ name: "spawn", upid: seed.upid });
    await sleep(this.spawnDelayMs);
    return {
      upid: seed.upid,
      runId: seed.runId ?? `run-${seed.upid}`,
      workflow: seed.workflow,
      parentId: seed.parentId ?? null,
    };
  }

  async steer(upid: string, payload: unknown): Promise<unknown> {
    this.calls.push({ name: "steer", upid, payload });
    return { ok: true };
  }

  signal(upid: string, payload: unknown): Promise<unknown> {
    return this.steer(upid, payload);
  }

  async pause(upid: string): Promise<unknown> {
    this.calls.push({ name: "pause", upid });
    return { ok: true };
  }

  async resume(upid: string): Promise<unknown> {
    this.calls.push({ name: "resume", upid });
    return { ok: true };
  }

  async halt(upid: string): Promise<unknown> {
    this.calls.push({ name: "halt", upid });
    return { ok: true };
  }

  async *streamRunEvents(_upid: string, _options: StreamRunEventsOptions = {}) {
    const stream = this.streams[this.streamIndex++] ?? [];
    for (const entry of stream) {
      if (entry instanceof Error) {
        throw entry;
      }
      await sleep(1);
      yield entry;
    }
  }
}

class RecordingGatewayTransport implements GatewayRpcTransport {
  readonly requests: Array<{ method: string; params?: Record<string, unknown> }> = [];

  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === "getRun") {
      const previousSignal = this.requests
        .filter((request) => request.method === "submitSignal")
        .at(-1)?.params?.signalName;
      return {
        runId: params?.runId,
        status: "waiting-event",
        runState: {
          state: "waiting-event",
          blocked: {
            kind: "event",
            nodeId: previousSignal === "pause" ? "resume" : "pause",
          },
        },
      };
    }
    return { ok: true };
  }
}

function spawnAction(): DispatchedAction {
  return {
    type: "spawn",
    targetUPID: null,
    payload: {
      upid: "upid-seam-001",
      runId: "run-seam-001",
      workflow: "vibersyn-test",
      steeringWindowId: "window-seam-001",
      callsign: "mavolune",
      seed: "Build the seam",
    },
    correlationId: "corr-spawn",
  };
}

function processRecord(upid: string, runId: string, callsign: string) {
  return createCorrelationRecord({
    upid,
    runId,
    callsign,
    steeringWindowId: `window-${callsign}`,
    correlationId: `corr-${upid}`,
    state: "active",
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
