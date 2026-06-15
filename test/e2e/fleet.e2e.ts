import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { Gateway, createSmithers } from "smithers-orchestrator";
import { z } from "zod";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("seam durability recovery e2e", () => {
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

function closeRuntime(runtime: ReturnType<typeof createRuntime>) {
  (runtime.api.db as any)?.$client?.close?.();
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
