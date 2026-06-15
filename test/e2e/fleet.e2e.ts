import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { Gateway, createSmithers } from "smithers-orchestrator";
import { z } from "zod";
import { FileCorrelationStore, MemoryCorrelationStore } from "../../src/seam/correlation-store";
import { SeamDispatcher } from "../../src/seam/dispatcher";
import { GatewaySmithersClient, InProcessGatewayTransport } from "../../src/seam/smithers-client";
import { SteeringWindowManager } from "../../src/routing/steering-window";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("steering-window fleet slice e2e", () => {
  test("selects one process, steers it, then 20 seconds idle closes the window so ambient talk no longer steers", () => {
    const manager = new SteeringWindowManager({
      processes: [
        { callsign: "Atlas", upid: "upid-atlas" },
        { callsign: "Bravo", upid: "upid-bravo" },
      ],
      sessionId: "fleet-window-e2e",
      clock: () => 1_000,
    });

    const select = manager.ingestUtterance({
      text: "Atlas",
      utteranceId: "utt-select-atlas",
      correlationId: "corr-select-atlas",
      sessionId: "fleet-window-e2e",
      nowMs: 1_000,
    });
    expect(select.kind).toBe("pass");
    expect(manager.activeWindow()).toEqual(expect.objectContaining({ targetUPID: "upid-atlas" }));

    const steer = manager.ingestUtterance({
      text: "make it faster",
      utteranceId: "utt-steer-atlas",
      correlationId: "corr-steer-atlas",
      sessionId: "fleet-window-e2e",
      nowMs: 1_250,
    });
    expect(steer).toEqual(
      expect.objectContaining({
        kind: "routed",
        targetUPID: "upid-atlas",
        instruction: "make it faster",
        ackId: "route-steer",
      }),
    );
    expect(steer.traceEvents).toContainEqual(
      expect.objectContaining({
        event: "ack.emit",
        upid: "upid-atlas",
        meta: expect.objectContaining({ ackId: "route-steer" }),
      }),
    );

    const idle = manager.observeMicIdle({
      nowMs: 21_250,
      correlationId: "corr-window-idle",
      sessionId: "fleet-window-e2e",
    });
    expect(idle).toEqual(
      expect.objectContaining({
        kind: "closed",
        reason: "idle",
        closedWindow: expect.objectContaining({ targetUPID: "upid-atlas" }),
      }),
    );
    expect(manager.activeWindow()).toBeNull();

    const ambient = manager.ingestUtterance({
      text: "make it even faster",
      utteranceId: "utt-ambient-after-idle",
      correlationId: "corr-ambient-after-idle",
      sessionId: "fleet-window-e2e",
      nowMs: 21_500,
    });
    expect(ambient).toEqual(
      expect.objectContaining({
        kind: "pass",
        reason: "ambient",
        addressed: false,
        ackId: null,
      }),
    );
    expect(ambient.traceEvents.some((event) => event.event === "route.steer")).toBe(false);
  });
});

describe("seam durability recovery e2e", () => {
  test("seam steering and per-process pause stay isolated across two durable runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "panop-fleet-seam-"));
    tempDirs.push(dir);
    const runtime = createFleetControlRuntime("control", join(dir, "smithers.db"));
    const gateway = new Gateway({ heartbeatMs: 1_000, eventWindowSize: 200 });
    const connection = createConnection("fleet-control");
    gateway.connections.add(connection as any);
    gateway.register("panopticon-fleet-control", runtime.workflow as any);

    const store = new MemoryCorrelationStore();
    const dispatcher = new SeamDispatcher({
      client: new GatewaySmithersClient({
        transport: new InProcessGatewayTransport(gateway as any, connection),
        correlations: store,
        defaultWorkflow: "panopticon-fleet-control",
      }),
      correlations: store,
      sessionId: "fleet-e2e",
    });

    try {
      await dispatcher.dispatch(spawnAction("Atlas", "upid-atlas", "run-atlas", "seed-atlas"));
      if (process.env.PANOP_RBG_STALL_UNSELECTED !== "1") {
        await dispatcher.dispatch(spawnAction("Bravo", "upid-bravo", "run-bravo", "seed-bravo"));
      }
      await dispatcher.drain();

      await waitForStatus(gateway, connection, "run-atlas", "waiting-event");
      await waitForStatus(gateway, connection, "run-bravo", "waiting-event");
      await waitForNodeOutput(gateway, connection, "run-atlas", "checkpoint");
      await waitForNodeOutput(gateway, connection, "run-bravo", "checkpoint");

      if (process.env.PANOP_RBG_DROP_STEER_SIGNAL !== "1") {
        await dispatcher.dispatch({
          type: "steer",
          targetUPID: "upid-atlas",
          payload: { command: "make-atlas-blue", injection: "fleet-steer" },
          correlationId: "corr-steer-atlas",
        });
      }
      await dispatcher.drain();

      const atlasComplete = await waitForNodeOutput(gateway, connection, "run-atlas", "complete");
      expect(atlasComplete.row).toEqual(
        expect.objectContaining({
          seed: "seed-atlas",
          command: "make-atlas-blue",
          injection: "fleet-steer",
        }),
      );
      await expectNodeOutputMissing(gateway, connection, "run-bravo", "complete");

      await dispatcher.dispatch({
        type: process.env.PANOP_RBG_PAUSE_ALL_UPIDS === "1" ? "pauseAll" : "pause",
        targetUPID: process.env.PANOP_RBG_PAUSE_ALL_UPIDS === "1" ? null : "upid-bravo",
        payload: {},
        correlationId: "corr-pause-bravo",
      });
      await dispatcher.drain();

      expect(await store.findByUPID("upid-bravo")).toEqual(expect.objectContaining({ state: "paused" }));
      expect(await store.findByUPID("upid-atlas")).not.toEqual(expect.objectContaining({ state: "paused" }));
      await waitForNodeOutput(gateway, connection, "run-bravo", "pause-ack");

      await dispatcher.dispatch({ type: "resume", targetUPID: "upid-bravo", payload: {}, correlationId: "corr-resume-bravo" });
      await dispatcher.drain();
      expect(await store.findByUPID("upid-bravo")).toEqual(expect.objectContaining({ state: "active" }));
      await waitForNodeOutput(gateway, connection, "run-bravo", "resume-ack");
    } finally {
      await gateway.close().catch(() => {});
      closeRuntime(runtime);
    }
  }, 12_000);

  test("backend restart recovers an in-flight durable run from its last checkpoint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "panop-fleet-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "smithers.db");
    const correlationPath = join(dir, "correlations.json");
    const initial = createRuntime("initial", dbPath);
    const gateway = new Gateway({ heartbeatMs: 1_000, eventWindowSize: 200 });
    const connection = createConnection("fleet-initial");
    gateway.connections.add(connection as any);
    gateway.register("panopticon-fleet", initial.workflow as any);
    const initialStore = new FileCorrelationStore(correlationPath);
    const initialDispatcher = new SeamDispatcher({
      client: new GatewaySmithersClient({
        transport: new InProcessGatewayTransport(gateway as any, connection),
        correlations: initialStore,
        defaultWorkflow: "panopticon-fleet",
      }),
      correlations: initialStore,
      sessionId: "fleet-recovery-initial",
    });

    try {
      const accepted = await initialDispatcher.dispatch({
        type: "spawn",
        targetUPID: null,
        payload: {
          upid: "upid-fleet-001",
          runId: "run-fleet-001",
          workflow: "panopticon-fleet",
          callsign: "Fleet",
          steeringWindowId: "window-fleet-001",
          input: {
            seed: "fleet seed",
            checkpoint: "checkpoint:fleet-seed",
          },
        },
        correlationId: "fleet-correlation",
      });
      expect(accepted.accepted).toBe(true);
      await initialDispatcher.drain();
      await waitForStatus(gateway, connection, "run-fleet-001", "waiting-event");
      const checkpointBefore = await rpc(gateway, connection, "getNodeOutput", {
        runId: "run-fleet-001",
        nodeId: "checkpoint",
        iteration: 0,
      });
      expect(checkpointBefore.ok).toBe(true);
      await gateway.close();
    } finally {
      await gateway.close().catch(() => {});
    }

    const recoveredDbPath = process.env.PANOP_RBG_DISABLE_CHECKPOINTING === "1"
      ? join(dir, "empty-after-restart.db")
      : dbPath;
    const recovered = createRuntime("recovered", recoveredDbPath);
    const recoveredGateway = new Gateway({ heartbeatMs: 1_000, eventWindowSize: 200 });
    const recoveredConnection = createConnection("fleet-recovered");
    recoveredGateway.connections.add(recoveredConnection as any);
    recoveredGateway.register("panopticon-fleet", recovered.workflow as any);
    const recoveredStore = new FileCorrelationStore(correlationPath);
    const recoveredDispatcher = new SeamDispatcher({
      client: new GatewaySmithersClient({
        transport: new InProcessGatewayTransport(recoveredGateway as any, recoveredConnection),
        correlations: recoveredStore,
        defaultWorkflow: "panopticon-fleet",
      }),
      correlations: recoveredStore,
      sessionId: "fleet-recovery-restarted",
    });

    try {
      const run = await rpc(recoveredGateway, recoveredConnection, "getRun", { runId: "run-fleet-001" });
      expect(run.ok).toBe(true);
      expect(run.payload.status).toBe("waiting-event");

      const recoveredCheckpoint = await rpc(recoveredGateway, recoveredConnection, "getNodeOutput", {
        runId: "run-fleet-001",
        nodeId: "checkpoint",
        iteration: 0,
      });
      expect(recoveredCheckpoint.ok).toBe(true);
      expect(recoveredCheckpoint.payload.row).toEqual(
        expect.objectContaining({
          seed: "fleet seed",
          checkpoint: "checkpoint:fleet-seed",
        }),
      );
      expect(await recoveredStore.findByUPID("upid-fleet-001")).toEqual(
        expect.objectContaining({
          runId: "run-fleet-001",
          steeringWindowId: "window-fleet-001",
          correlationId: "fleet-correlation",
        }),
      );

      if (process.env.PANOP_RBG_SKIP_RECOVERY_STEER !== "1") {
        await recoveredDispatcher.dispatch({
          type: "steer",
          targetUPID: "upid-fleet-001",
          payload: { command: "continue-after-restart" },
          correlationId: "fleet-correlation-steer",
        });
      }
      await recoveredDispatcher.drain();

      const completion = await waitForNodeOutput(recoveredGateway, recoveredConnection, "run-fleet-001", "complete");
      expect(completion.row).toEqual(
        expect.objectContaining({
          seed: "fleet seed",
          checkpoint: "checkpoint:fleet-seed",
          command: "continue-after-restart",
        }),
      );
    } finally {
      await recoveredGateway.close().catch(() => {});
      closeRuntime(initial);
      closeRuntime(recovered);
    }
  }, 10_000);
});

function createFleetControlRuntime(label: string, dbPath: string) {
  const api = createSmithers(
    {
      checkpoint: z.object({ seed: z.string(), upid: z.string(), callsign: z.string() }),
      steer: z.object({
        type: z.string(),
        payload: z.object({
          command: z.string(),
          injection: z.string(),
        }),
      }),
      pause: z.object({ upid: z.string() }),
      pauseAck: z.object({ upid: z.string(), paused: z.boolean() }),
      resume: z.object({ upid: z.string() }),
      resumeAck: z.object({ upid: z.string(), resumed: z.boolean() }),
      complete: z.object({
        seed: z.string(),
        upid: z.string(),
        callsign: z.string(),
        command: z.string(),
        injection: z.string(),
      }),
    },
    { dbPath, readableName: `Panopticon fleet control ${label}` },
  );
  const workflow = api.smithers((ctx) => {
    const input = ctx.input as any;
    const seed = String(input.seed ?? input.prompt ?? "");
    const upid = String(input.upid ?? "");
    const callsign = String(input.callsign ?? "");
    const correlationId = String(input.correlationId ?? "");
    const controlMode = String(input.controlMode ?? "steer");

    const checkpoint = React.createElement(
      api.Task,
      { id: "checkpoint", output: api.outputs.checkpoint },
      { seed, upid, callsign } as any,
    );

    const steer = React.createElement(api.Signal, {
      id: "steer",
      schema: api.outputs.steer,
      correlationId,
      children: (data: any) =>
        React.createElement(
          api.Task,
          { id: "complete", output: api.outputs.complete },
          {
            seed,
            upid,
            callsign,
            command: data.payload.command,
            injection: data.payload.injection,
          } as any,
        ),
    });

    const pause = React.createElement(api.Signal, {
      id: "pause",
      schema: api.outputs.pause,
      correlationId,
      children: (data: any) =>
        React.createElement(
          api.Task,
          { id: "pause-ack", output: api.outputs.pauseAck },
          { upid: data.upid, paused: true } as any,
        ),
    });

    const resume = React.createElement(api.Signal, {
      id: "resume",
      schema: api.outputs.resume,
      correlationId,
      children: (data: any) =>
        React.createElement(
          api.Task,
          { id: "resume-ack", output: api.outputs.resumeAck },
          { upid: data.upid, resumed: true } as any,
        ),
    });

    return React.createElement(
      api.Workflow,
      { name: "panopticon-fleet-control" },
      React.createElement(
        api.Sequence,
        null,
        checkpoint,
        ...(controlMode === "pause-resume" ? [pause, resume] : [steer]),
      ),
    );
  });
  return { api, workflow };
}

function createRuntime(label: string, dbPath: string) {
  const api = createSmithers(
    {
      checkpoint: z.object({ seed: z.string(), checkpoint: z.string() }),
      steer: z.object({
        type: z.string(),
        payload: z.object({ command: z.string() }),
      }),
      complete: z.object({
        seed: z.string(),
        checkpoint: z.string(),
        command: z.string(),
      }),
    },
    { dbPath, readableName: `Panopticon fleet ${label}` },
  );
  const workflow = api.smithers((ctx) => {
    const input = ctx.input as any;
    return React.createElement(
      api.Workflow,
      { name: "panopticon-fleet" },
      React.createElement(
        api.Sequence,
        null,
        React.createElement(
          api.Task,
          { id: "checkpoint", output: api.outputs.checkpoint },
          {
            seed: String(input.seed ?? ""),
            checkpoint: String(input.checkpoint ?? ""),
          } as any,
        ),
        React.createElement(api.Signal, {
          id: "steer",
          schema: api.outputs.steer,
          correlationId: String(input.correlationId ?? ""),
          children: (data: any) =>
            React.createElement(
              api.Task,
              { id: "complete", output: api.outputs.complete },
              {
                seed: String(input.seed ?? ""),
                checkpoint: String(input.checkpoint ?? ""),
                command: data.payload.command,
              } as any,
            ),
        }),
      ),
    );
  });
  return { api, workflow };
}

function spawnAction(callsign: string, upid: string, runId: string, seed: string) {
  return {
    type: "spawn" as const,
    targetUPID: null,
    payload: {
      upid,
      runId,
      workflow: "panopticon-fleet-control",
      callsign,
      steeringWindowId: `window-${callsign.toLowerCase()}`,
      seed,
      input: { seed, upid, callsign, controlMode: callsign === "Bravo" ? "pause-resume" : "steer" },
    },
    correlationId: `corr-${upid}`,
  };
}

async function rpc(gateway: Gateway, connection: unknown, method: string, params?: Record<string, unknown>) {
  return (gateway as any).routeRequest(connection, {
    type: "req",
    id: `${method}:${crypto.randomUUID()}`,
    method,
    params,
  });
}

async function waitForStatus(gateway: Gateway, connection: unknown, runId: string, status: string) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    const response = await rpc(gateway, connection, "getRun", { runId });
    if (response.ok && response.payload.status === status) {
      return;
    }
    await sleep(20);
  }
  throw new Error(`Timed out waiting for ${runId} to reach ${status}`);
}

async function waitForNodeOutput(gateway: Gateway, connection: unknown, runId: string, nodeId: string) {
  const startedAt = Date.now();
  let latest: any;
  while (Date.now() - startedAt < 5_000) {
    latest = await rpc(gateway, connection, "getNodeOutput", { runId, nodeId, iteration: 0 });
    if (latest.ok && latest.payload.status === "produced") {
      return latest.payload;
    }
    await sleep(20);
  }
  throw new Error(`Timed out waiting for ${runId}/${nodeId}; latest=${JSON.stringify(latest)}`);
}

async function expectNodeOutputMissing(gateway: Gateway, connection: unknown, runId: string, nodeId: string) {
  const response = await rpc(gateway, connection, "getNodeOutput", { runId, nodeId, iteration: 0 });
  expect(response.ok === false || response.payload?.status !== "produced").toBe(true);
}

function createConnection(userId: string) {
  return {
    connectionId: `${userId}:connection`,
    transport: "ws",
    authenticated: true,
    sessionToken: "fleet-session",
    role: "operator",
    scopes: ["*"],
    userId,
    subscribedRuns: null,
    heartbeatTimer: null,
    devtoolsStreams: new Map(),
    runEventStreams: new Map(),
    seq: 0,
    ws: {
      OPEN: 1,
      readyState: 1,
      bufferedAmount: 0,
      sent: [],
      send(data: string) {
        this.sent.push(JSON.parse(data) as never);
      },
    },
  };
}

function closeRuntime(runtime: { api: { db?: any } }) {
  (runtime.api.db as any)?.$client?.close?.();
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
