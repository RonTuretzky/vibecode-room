import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { Gateway, createSmithers } from "smithers-orchestrator";
import { z } from "zod";
import { MemoryCorrelationStore } from "../../src/seam/correlation-store";
import { SeamDispatcher } from "../../src/seam/dispatcher";
import { GatewaySmithersClient, InProcessGatewayTransport } from "../../src/seam/smithers-client";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
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

      await dispatcher.dispatch({ type: "resume", targetUPID: "upid-bravo", payload: {}, correlationId: "corr-resume-bravo" });
      await dispatcher.drain();
      expect(await store.findByUPID("upid-bravo")).toEqual(expect.objectContaining({ state: "active" }));
    } finally {
      await gateway.close().catch(() => {});
      closeRuntime(runtime);
    }
  }, 12_000);

  test("backend restart recovers an in-flight durable run from its last checkpoint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "panop-fleet-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "smithers.db");
    const initial = createRuntime("initial", dbPath);
    const gateway = new Gateway({ heartbeatMs: 1_000, eventWindowSize: 200 });
    const connection = createConnection("fleet-initial");
    gateway.connections.add(connection as any);
    gateway.register("panopticon-fleet", initial.workflow as any);

    try {
      const created = await rpc(gateway, connection, "launchRun", {
        workflow: "panopticon-fleet",
        input: { seed: "fleet seed", checkpoint: "checkpoint:fleet-seed" },
        options: { runId: "run-fleet-001" },
      });
      expect(created.ok).toBe(true);
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

    return React.createElement(
      api.Workflow,
      { name: "panopticon-fleet-control" },
      React.createElement(
        api.Sequence,
        null,
        React.createElement(
          api.Task,
          { id: "checkpoint", output: api.outputs.checkpoint },
          { seed, upid, callsign } as any,
        ),
        React.createElement(
          api.Parallel,
          null,
          React.createElement(api.Signal, {
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
          }),
          React.createElement(api.Signal, {
            id: "pause",
            schema: api.outputs.pause,
            correlationId,
            children: (data: any) =>
              React.createElement(
                api.Task,
                { id: "pause-ack", output: api.outputs.pauseAck },
                { upid: data.upid, paused: true } as any,
              ),
          }),
        ),
      ),
    );
  });
  return { api, workflow };
}

function createRuntime(label: string, dbPath: string) {
  const api = createSmithers(
    {
      checkpoint: z.object({ seed: z.string(), checkpoint: z.string() }),
      steer: z.object({ command: z.string().optional() }),
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
          correlationId: "fleet-correlation",
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
      input: { seed, upid, callsign },
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
